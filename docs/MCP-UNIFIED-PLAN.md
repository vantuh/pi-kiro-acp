# kiro-acp — UNIFIED plan: MCP transport modernization

Consolidates `MCP-MIGRATION-PLAN.md` (Phases 1–6) into a single track.
**Supersedes it** — once approved, the old file can be deleted.

Goal: replace the three-part tool transport (`.mjs` bridge + tools file in /tmp + HTTP IPC)
with a single in-process **Streamable HTTP MCP** server (protocol `2025-06-18`), registered
in `session/new` as `type:"http"`; keep deterministic tool-name aliasing.
Do not lose any `kiro-acp` features.

## Status (2026-08-25) — COMPLETE

All phases (0, 0b, 1–7) are done. Decisions are recorded in
`adr/0001-in-process-http-mcp-tool-transport.md`.

Phase 7 verification:
- Dead code removed: `tool-coordinator.ts` (+ its test) was unused because Phase 3
  left the `pendingToolCalls` machinery in `session.ts`; stale references to `/tool/pending`
  removed from `types.ts`.
- Load gate (Risk 2) — `test/extension-load.test.ts`: `index.ts` registers the
  `kiro-acp` provider with models and `streamSimple`, subscribes to `turn_start`/`message_end`/`session_shutdown`.
- `claude-haiku-4.5` smoke: native `execute_bash` produced exactly one mirrored thinking block
  (`🔧 Running: echo …` + output), **0** `bridge tool call received`, **0** pi-toolCalls — the loop is intact.
- `claude-opus-5` smoke: `web_search` went through `pi_host` (`callId: s-…-1`, `roundtripMs`
  2255, `resultLen` 6141), pi executed the tool and Kiro continued to `outcome: stop`.
- Ports: after each `-p` run the bridge port was released; `lsof` shows only ports of
  live pi sessions (one per session), no orphans.
- **Not confirmed by live smoke:** `agent_thought_chunk` — neither `claude-opus-5` nor
  `deepseek-3.2` with `--thinking high` sent thought chunks (`ttftThinkingMs: null`,
  `thinkingChars: 0`), so reasoning UX was verified only by unit tests (`stream.test.ts`).

---

## Terminology: two different meanings of "MCP"

- **MCP #1 — internal transport (`pi_host`).** Kiro in ACP can only call external
  tools as an MCP server, so the extension spins up a local MCP server `pi_host`
  so the Kiro model can call **Pi extension tools** (e.g. `peer_list`/`peer_send`).
  This is the basic mechanism; it always works when needed, letting the Kiro model reach pi-tools.
  **This entire migration is about MCP #1.**
- **MCP #2 — passthrough of user-defined `mcp.json` servers.** Forwarding the user's own
  stdio-MCP servers to the Kiro model. **The user does NOT use this → dropped from the
  plan** (former Phase 2b). Do not confuse with MCP #1.

**User decision:** calling Pi extension tools from Kiro models **is needed** →
the `pi_host` bridge stays.

---

## User requirements (recorded)

1. **All tools executed by the model are visible in pi** — regardless of whether pi or Kiro executes them natively.
2. **Fast** — no extra round-trips for frequent operations.
3. **Kiro sees and calls pi-registered extension tools, and pi executes them** (and displays them).

Consequence = the previously chosen **B1 + mirror** (see Decision B): fast native fs/bash — in Kiro
(with a visibility mirror, Phase 4); pi extension tools — via `pi_host`, executed by pi.

### Concrete set of pi extension tools (verified in the environment)

Forwarded to Kiro and executed by pi:
- `web_search`, `source_check`, `fetch_content`, `get_search_content` — the `pi-web-access` package
- `herdr_agent` — local `herdr-agents` extension

Rules:
- The catalog filter is **dynamic** (`active && source ∉ {builtin, sdk}`) — these 5 pass,
  future extension tools are picked up automatically, no hardcoding.
- **Native dedup:** remove Kiro-native `web_search`/`web_fetch` from `allowedTools`
  (they would beat the pi web tools); keep native `fs_*`/`execute_bash`/`glob`/`grep` in Kiro.
- Verify (Phase 5): a test confirms that `sourceInfo.source` of these 5 tools ≠ `builtin`/`sdk`
  (otherwise the filter would wrongly drop them).

---

## Verified facts (Phase 0 — GREEN)

Smoke test on `kiro-cli 2.16.0` (manual `initialize` + `session/new` with a mock HTTP MCP):
- `session/new` with `mcpServers: [{ type:"http", name, url, headers:[Bearer] }]` **accepted**.
- Kiro connected and called `initialize` → `notifications/initialized` → `tools/list`
  on the mock server — **all with `Authorization: Bearer`**.
- `initialize` returns `agentCapabilities.mcpCapabilities = { http: true, sse: false }`
  → there is a clean feature gate, no blind trust needed.
- Also confirmed: `loadSession: true`, `promptCapabilities.image: true`.

**Consequence:** transport via `session/new`+`type:http` is viable. A fallback to
agent-config registration **is not needed** (but stays as an emergency path, gated by
`mcpCapabilities.http`).

### Phase 0b — shape of ACP tool updates for native tools (GREEN)

Smoke test: `session/prompt` asking to run `echo` via native bash. Kiro sends:
```jsonc
// session/update → update:
{ "sessionUpdate": "tool_call",
  "toolCallId": "tooluse_...",
  "title": "Running: echo hello-from-kiro",
  "kind": "execute",                       // execute|read|edit|... 
  "rawInput": { "command": "echo hello-from-kiro" },
  "_meta": { "kiro": { "toolName": "shell" } } }   // actual native tool name
{ "sessionUpdate": "tool_call_update",
  "toolCallId": "tooluse_...",
  "content": [ { "type": "content", "content": { "type": "text", "text": "hello-from-kiro\n" } } ] }
```
So everything needed for the "visibility mirror" is there: `toolCallId` (correlation), `title` (human label),
`kind`, `rawInput` (arguments), `_meta.kiro.toolName` (name), and the result in `tool_call_update.content`.
At that time `stream.ts` **ignored** these updates (it only listened to `agent_*_chunk`).

---

## Recorded decisions

### A — streaming (chose A1)
Remove the coalescing timer (`STREAM_COALESCE_MS`, buffer, `flushCoalesced` in `stream.ts`),
forward `agent_message_chunk` directly as `text_delta`. **Keep** the
`agent_thought_chunk` → thinking-blocks branch. Simplicity + lower latency, without losing reasoning UX.

### B — tool-forwarding philosophy (CHOSEN: B1 + visibility mirror)
Orthogonal to transport: HTTP-MCP works with any tool set. The difference is only in
the catalog filter + `allowedTools` in the agent config.

User requirement: **fast AND visible** ("who executes doesn't matter; what matters is that pi
shows that work is happening"). Therefore:

- **Execution — B1:** Kiro runs **native** tools (`fs_read/fs_write/execute_bash/glob/grep/web_*`);
  via `pi_host` — only **active extension tools** (Pi-builtin excluded). Far fewer
  round-trips → speed (addresses `LATENCY-FIX-PLAN.md`).
- **Visibility — the mirror (Phase 4, last):** Kiro's native tool calls are rendered in pi as
  **display-only** activity (from `tool_call`/`tool_call_update` — see Phase 0b). Pi does **not
  execute or gate them**, it just shows "what is being done".

A tradeoff consciously accepted: pi does **not** gate fs/bash (Kiro does those) — this is a
security-model change for the sake of speed. Visibility is preserved via the mirror.

Rejected: **B2** (all pi-tools via the bridge) — everything visible and gated, but every fs/bash
operation pays a round-trip (latency). Technically reverting is trivial: the filter in
`buildForwardedToolCatalog` + `allowedTools` + disable the mirror.

### C — aliasing (folded into the catalog)
Slice B from the old plan is **cancelled**: aliasing already lives inside the ported
`tool-catalog.ts` (`isKiroToolName`, `aliasFor`, `pi_<hash>`). A separate `tool-names.ts`
is **not created** — avoiding two layers of aliasing (Symptom 3 from the risk discussion).

### Transport registration
The primary path is `session/new mcpServers: [{type:"http", name:"pi_host", url, headers:[Bearer]}]`,
gated by `agentCapabilities.mcpCapabilities.http === true`. If the capability is absent —
fallback: HTTP entry in the agent config (the in-process server is the same, only the declaration changes).

---

## Phase 1 — Streaming (A1) [DO FIRST — low risk]

Independent of tool work, purely `stream.ts`.

- In `stream.ts` remove coalescing (`STREAM_COALESCE_MS`, buffer, `flushCoalesced`),
  forward `agent_message_chunk` directly as `text_delta`.
- Keep `agent_thought_chunk` → thinking blocks and text↔thinking transitions.
- Remove coalescing metrics (`avgEmitted*Chars`), keep TTFT.

verify: `stream.test.ts` + `abort.test.ts` green; manual check with a reasoning model (thinking visible)
and TTFT.

---

> **Phases 2–5 below are the risky tool-forwarding block (`pi_host` + mirror, Decision B1).**
> Do it **last**, after streaming is stable. Until the block is finished, the old tool
> transport (`.mjs`+IPC) keeps working — nothing breaks.

## Phase 2 — Port the tools infrastructure (isolated, with tests)

Copy into `kiro-acp/` and adapt:
- `tool-catalog.ts` — active catalog, deterministic `pi_<hash>` aliases, fingerprint, diagnostics.
  Filter per Decision B (B1: extension tools only; B2: all except the 3 meta).
- `tool-bridge.ts` — in-process Streamable HTTP MCP (bearer, Origin/Accept validation,
  64KB body limit, 401/403/406/413 codes, protocol `2025-06-18`).
- `tool-coordinator.ts` — state machine for a suspended ACP prompt ↔ the next Pi turn.

**Multi-session adaptation (critical — Symptom 6):**
- `startToolBridge` + `KiroToolCoordinator` are created **per `AcpSession`** (own port/token).
- `AcpSession.stop()` and `pruneIdleSessions`/`stopAllSessions` (`session-manager.ts`) **must
  close** the session's HTTP server → otherwise ports leak.
- Preserve the matching invariant: `piToolCallId` must carry the `${session.id}-` prefix so a
  result never lands in the wrong session (analogous to the current `findToolCallMatch`). The
  ported community coordinator doesn't know this prefix — **stitch it in**.

verify: unit tests `catalog`, `tool-bridge`, `tool-coordinator`, `framing` green.

## Phase 3 — Replace IPC+`.mjs` with in-process HTTP MCP in `session.ts`

Delete:
- the in-process IPC HTTP server (`startIpcServer`, `handleIpcRequest`, `/tool/pending`, `ipcPort`, `ipcSecret`)
- `writeTools()` + the tools file in /tmp
- the stdio bridge in `writeAgentCfg()` (the `mcpServers: { node kiro-acp-bridge.mjs }` block)
- the `kiro-acp-bridge.mjs` file

Add:
- at session start: `startToolBridge({ catalog, onToolCall })`, save `url`/`token`;
- in `session/new` (and in `tryRestorePersistedSession`!) pass
  `mcpServers: [{ type:"http", name:"pi_host", url, headers:[Bearer] }]` — both places where it is currently `[]`;
- agent config: `allowedTools` = Kiro natives `fs_read/fs_write/execute_bash/glob/grep`
  (**without** `web_search`/`web_fetch` — pi provides those via `pi_host`) + `@pi_host`;
  remove the stdio `mcpServers`;
- flow: `tools/call` → `onToolCall` → `coordinator.beginCall` → the stream emits `toolcall_*`
  → Pi executes → `deliverToolResults` resolves the coordinator.

verify: manual smoke (Kiro calls an extension tool, Pi executes, Kiro continues);
`lifecycle-cleanup` (respawn after kill) green; no orphaned ports after `stop`.

## Phase 4 — Visibility mirror for Kiro's native tools (for the "visible" requirement)

Problem: under B1, Kiro's native fs/bash run inside Kiro and are **invisible** in pi.

**Verified in the pi SDK (`pi-ai`, `pi-coding-agent`):**
- Stream events (`AssistantMessageEvent`) — only `start | text_* | thinking_* | toolcall_* | done | error`.
  **There is NO separate status/notice/foreign-tool channel in the stream.** `toolcall_*` is tied to
  execution (`done: toolUse` forces pi to execute the tool) → **the mirror cannot be built via the stream**.
- Instead, `ExtensionAPI` provides **out-of-stream** UI channels (in `pi.ui` + `pi.sendMessage`):
  - `pi.ui.setWorkingMessage(msg?)` / `setStatus(key, text?)` / `setWorkingIndicator(...)` —
    transient "something is happening" indicator during the stream (footer/loader line).
  - `pi.ui.notify(msg, "info")` — notifications.
  - `pi.sendMessage({ customType, content, display, details })` (+ registering a `MessageRenderer`) —
    **a persistent custom transcript entry** (best for the "history" of each native call).

**Mirror design (no stream):**
- Capture `pi: ExtensionAPI` at registration (`index.ts`) and pass it into the session/stream
  (currently `streamKiroAcp` does not receive it).
- On `tool_call` (shape — Phase 0b): `pi.ui.setWorkingMessage("🔧 " + title)` (transient) and/or
  `pi.sendMessage({ customType: "kiro_native_tool", display: true, content: title, details: rawInput })`.
- On `tool_call_update`: append the result (`content[].content.text`) to the same entry
  (correlation by `toolCallId`), clear the working message.
- **Do NOT** emit `toolcall_start/end` into the stream — that is an order for pi to
  "execute" and would break the loop (Risk 7).
- The mirror is behind a flag (off → pure B1 without visualization; or switch to B2).

verify: manual smoke — the Kiro model runs `execute_bash`/`fs_read`; the pi TUI shows the activity
(working message + custom entry with the result); pi does **not** execute the tool (no extra
`toolcall` loop).

## Phase 5 — Tests (the tool block)

- Run via pi-bundled `jiti`.
- Port/write: `catalog` (incl. aliasing + filter B), `tool-bridge`,
  `tool-coordinator`, `framing`, `lifecycle-cleanup`,
  `transcript`/context (adapt to `kiro-acp` persistence).
- Add a test for **per-session isolation** of the coordinator/port (Symptom 6).

verify: the whole suite is green with one command.

## Phase 6 — Documentation

- `docs/adr/0001-*.md` — record the in-process HTTP MCP, the `mcpCapabilities.http` feature gate,
  decisions A1/B.
- Update `DEBUG-LOGGING.md` (remove the `.mjs` `[mcp-bridge]` logs, add `pi_host` logs).
- Delete the obsolete `MCP-MIGRATION-PLAN.md`.

## Phase 7 — Cleanup and final verification

- Remove dead code: `kiro-acp-bridge.mjs`, the tools-file/IPC branches, unused imports
  (verify `index.ts` still loads — otherwise the whole provider disappears, Symptom 2).
- Run the full test suite + manual smoke on 2–3 models (reasoning + fast).
- Check concurrent sessions, port cleanup on idle-prune and on Pi exit.

---

## Risk register (with mitigations)

| # | Risk | Mitigation |
|---|---|---|
| 1.1 | `kiro-cli acp` doesn't accept `type:http` | **Cleared by Phase 0**; gate `mcpCapabilities.http` + agent-config fallback |
| 1.2 | tools invisible (a forgotten `@name` in `allowedTools`) | Phase 3: add `@pi_host` to `allowedTools`; test |
| 2 | extension fails to load (dangling imports after deletion) | Phase 7 gate: confirm `index.ts` loads; clean cutover |
| 3 | double aliasing | **Cleared**: Slice B cancelled, aliasing only in `tool-catalog.ts` |
| 4 | orphaned stdio entry pointing at the deleted `.mjs` | Phase 3 removes the block entirely |
| 5 | B1 removes the pi gate over fs/bash | Conscious Decision B (speed); the mirror restores visibility (Phase 4) |
| 6 | cross-session mixing of tool calls / port leaks | Per-session bridge+coordinator; `${id}-` prefix; close on stop/prune |
| 7 | the mirror wrongly emits `toolcall_*` → pi tries to execute | The mirror is **out-of-stream** (`pi.ui`/`pi.sendMessage`), NOT via `toolcall_*`; behind a flag |

## Not touched (kiro-acp features absent from the community version)
Multi-session support; persistence by fingerprint (`session-persistence.ts`); `--effort`;
image handling in tool results (`cancelAndStartFollowUp`); process-tree kill (`process-utils.ts`).

---

## Execution order
**Streaming first, the risky tool-forwarding last:**
Phase 1 (streaming, independent) → 2 → 3 → 4 → 5 → 6 → 7.
Phases 2–5 are the `pi_host` tool block (B1); until they are done, the old `.mjs`+IPC transport keeps working.
The blocker is cleared (Phases 0/0b), so Phase 1 can start immediately.
