# 0001 — In-process HTTP MCP tool transport for kiro-acp

Status: accepted (2026-08)
Supersedes: the `.mjs` stdio bridge + `/tmp` tools-file + HTTP IPC transport.

## Context

Kiro in ACP mode can only call *external* tools through an MCP server. To let Kiro's
models use pi extension tools (`web_search`, `fetch_content`, `herdr_agent`, …), the
extension has to expose them as MCP.

The original transport had three links: a `kiro-acp-bridge.mjs` stdio MCP server spawned
by kiro-cli, a tool catalog written to a file under `/tmp` for that process to read, and an
HTTP IPC channel back into the extension (`POST /tool/pending`). Every tool call crossed
all three, the catalog could go stale, and the `.mjs` file duplicated aliasing logic.

Two facts, verified empirically against kiro-cli 2.16.0 before committing to the change:

- `session/new` accepts `mcpServers: [{ type: "http", name, url, headers: [Bearer …] }]`;
  Kiro then performs `initialize` → `notifications/initialized` → `tools/list` against that
  URL, sending the `Authorization` header on every request.
- `initialize` returns `agentCapabilities.mcpCapabilities = { http: true, sse: false }`,
  so HTTP support can be feature-gated instead of assumed.

## Decision

**Transport.** One in-process Streamable HTTP MCP server per ACP session (`tool-bridge.ts`,
protocol `2025-06-18`), registered in `session/new` as `type: "http"` under the name
`pi_host`, authenticated with a per-session bearer token on loopback. The `.mjs` bridge, the
`/tmp` tools file, and the IPC server are gone. Aliasing lives only in `tool-catalog.ts`
(`pi_<hash>` for names Kiro cannot accept) — deliberately not a second aliasing layer.

If `mcpCapabilities.http` is ever absent, the fallback is to declare the same in-process
server in the agent config; only the declaration changes, not the server.

**Streaming.** `agent_message_chunk` is forwarded straight to pi as `text_delta`; the
coalescing timer (`STREAM_COALESCE_MS`) was removed. `agent_thought_chunk` → thinking blocks
is kept.

**Execution split (B1).** Kiro executes its native `fs_read`, `fs_write`, `execute_bash`,
`glob`, `grep` itself; only active pi extension tools are forwarded over `pi_host` and
executed by pi. Kiro's native `web_search`/`web_fetch` are excluded from `allowedTools` so
pi's web tools win. The catalog filter is dynamic (`active && source ∉ {builtin, sdk}`), so
new extension tools are picked up without code changes.

**Visibility.** Kiro's native tool calls are mirrored into pi's transcript as display-only
thinking blocks built from the ACP `tool_call` / `tool_call_update` pair
(`native-tool-mirror.ts`, toggle `PI_KIRO_ACP_MIRROR`). The mirror never emits `toolcall_*`
events: in pi's stream those are an instruction to execute the tool, which would break the
turn loop.

## Consequences

- Fewer round-trips per tool call, and no catalog file that can drift.
- Pi no longer gates fs/bash — Kiro runs them under `--trust-all-tools`. This is an accepted
  security-model change traded for latency; visibility is preserved by the mirror, not by
  approval prompts.
- Every session owns a listening port, so lifecycle discipline is mandatory: `stop()`,
  `pruneIdleSessions()`, and `stopAllSessions()` must close the bridge, and pending tool-call
  ids are namespaced `${session.id}-<n>` so results cannot cross sessions. Both are covered by
  `test/lifecycle-cleanup.test.ts`.
- Reverting to "pi executes and gates everything" (B2) stays cheap: widen the catalog filter,
  drop the native tools from `allowedTools`, disable the mirror.

## Amendment (2026-08-26) — concurrent `tools/call`

The first `pi_host` implementation kept a single in-flight HTTP `tools/call`. A second POST
while the first was open returned JSON-RPC `-32000 Another tool call is already pending`.
Kiro does issue overlapping calls in one turn (two `herdr_agent`, or `herdr_agent` +
`web_search`); the model then reported a transport error.

Pending calls are keyed per HTTP response. Each keeps its own SSE/JSON stream, keepalive,
and abort. Disconnect or `close()` only settles that call. Pi already tracks multiple
`pendingToolCalls`; the stream debounce batches them into one turn.

## Amendment (2026-09-04) — revert to full forwarding (B2)

The execution split (B1) is reverted: **pi executes every tool.** Kiro's agent config
now lists only `@pi_host` (`writeAgentCfg`), and the catalog filter is widened to
include builtin tools alongside extension tools — pi's **active** builtin set, which
defaults to `read`, `bash`, `edit`, `write` (`grep`/`find`/`ls` are forwarded only when
a session or subagent tool plan activates them); only host-SDK customs stay out. Every Kiro `tools/call` crosses the
bridge into pi's pending-call flow, so pi emits real `tool_execution_start/end` events
— child sessions (pi-subagents) get live FleetView activity and tool/token counters,
which the display-only mirror could never provide.

- The mirror (`native-tool-mirror.ts`) and the styled `<!--kiro-tool-->` transformer are
  kept as a **dormant fallback**: with no native tools every `tool_call` update carries
  `_meta.kiro.mcpServerName`, so the mirror no-ops and pi's standard tool rendering is
  the primary display path. It still catches any update that arrives without the
  discriminator (e.g. if kiro-cli re-introduces native tools). `PI_KIRO_ACP_MIRROR=0`
  still disables it. **(Superseded by Amendment 3: the mirror, transformer, and toggle
  were removed.)**
- Cost, as in the pre-B1 transport: every fs/bash call round-trips through the bridge
  and pi's turn loop (one debounce delay per turn, `TOOL_CALL_DEBOUNCE_MS`), and pi
  gates fs/bash again — the `--trust-all-tools` caveat above narrows rather than
  disappears: the flag is still passed (`session.ts` spawn args) and is what
  auto-approves the `pi_host` MCP tools inside Kiro, but nothing executes outside
  pi's normal permission model anymore.

## Amendment 3 — 2026-09-04: dormant mirror removed

After a week of live B2 usage the native-tool mirror (`native-tool-mirror.ts`),
its markdown transformer (`tool-frame-transformer.ts`), and the
`PI_KIRO_ACP_MIRROR` toggle were removed as dead code: with
`tools: ["@pi_host"]` every tool_call carries `_meta.kiro.mcpServerName`, so the
mirror could never emit. The strip readers in `native-tool-frame.ts` remain to
clean `<!--kiro-tool-->` blocks and one-liner frames out of historical
transcripts before they reach the model or persistence. Note that legacy
`<!--kiro-tool-->` blocks in resumed sessions now render as plain text
(`🔧 title` / body / `[status]`) instead of styled boxes, since the
transformer no longer exists; model-facing behavior is unchanged.
