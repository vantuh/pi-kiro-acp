# kiro-acp Latency Fix Plan

Symptom (pi vs direct `kiro-cli`): long silent thinking gaps, jerky text, slow tool rounds.

Root shape: extension does not throttle text deltas; most wait is **before first chunk** or **between tool rounds** (pi agent loop + MCP HTTP bridge). Effort/`--effort high` amplifies silent thinking.

## Priority order

### P0 — Measure first (done)

With `PI_KIRO_ACP_DEBUG=1`, log TTFT + tool roundtrip:

| Metric | Log | Healthy warm-path guess |
|---|---|---|
| `promptReadyMs` | `outcome.timing` | < 200ms warm; seconds if cold/replay |
| `ttftThinkingMs` / `ttftTextMs` | `timing first *` / `outcome` | dominated by model, not bridge |
| `roundtripMs` | `delivering tool result` | tool exec time + pi loop overhead |
| `rpc ← ms` | per RPC | initialize/session/new/set_model spikes on cold |
| `avg*ChunkChars` | `outcome.timing` | very small → jerky UI |

Do not optimize until one slow turn shows which bucket dominates.

### P1 — Tool handoff (biggest “held by the hand” feel)

Today each forwarded tool is: kiro `tools/call` → in-process `pi_host` HTTP MCP → wait → pi ends
stream (`toolUse`) → pi runs tool → new `streamKiroAcp` resumption → `deliverToolResults` → MCP
responds → kiro continues. (Kiro's native fs/bash tools skip this path entirely — see
`adr/0001-in-process-http-mcp-tool-transport.md`.)

Ideas (pick after measurements):

1. **Faster flush**: `TOOL_CALL_DEBOUNCE_MS = 0` (next timer tick) — still batches same-wave parallel MCP calls, drops the old ~50ms stall. **Implemented.**
2. **Overlap**: if pi exposes mid-turn tool execution without ending the assistant stream, deliver results without full stream restart (API-dependent; may be impossible).
3. **Instrumentation UI**: surface `roundtripMs` in a diagnostic so “slow tool” is not blamed on the model.

Likely win: cut perceived stall between “tool announced” and “kiro continues” when pi loop is the gap.

### P2 — Prompt / session init

1. **Skip `configureMcpTimeout` on every cold start** — process-wide cache after success; first run overlaps with `initialize`. **Implemented.**
2. **Avoid full history replay** when fingerprint matches (already attempted via persistence) — verify warm resume hits `restored persisted kiro session` in logs.
3. **Once-per-ACP-session `system_instructions`** — send on first prompt / when hash changes / after session recreate; skip on later user turns. **Implemented** (always on, no env flag).
4. **Parallelize independent RPCs** only where safe (usually cannot parallelize initialize → session/new → set_model).

### P3 — Jerky text / thinking gaps

1. **Coalesce deltas** in `stream.ts` (`STREAM_COALESCE_MS = 24`) before `stream.push` — smoother TUI; TTFT delayed by at most one window. **Implemented, then reverted** (decision A1 in `adr/0001-in-process-http-mcp-tool-transport.md`): deltas are forwarded 1:1 for lower latency, so `emitted*Deltas` now tracks `*Chunks`.
2. **Effort default**: map pi `defaultThinkingLevel: "high"` carefully; document that high effort ⇒ long silent gaps even when chunks stream correctly.
3. Do **not** chase readline-per-line “µs” overhead — not the user-visible stall.

## Non-goals

- Matching bare `kiro-cli` UX exactly (no pi system prompt / skills / tool loop).
- Buffering text until thinking ends (would make “sit and wait” worse).

## Implementation slices (when ready)

1. Confirm log timings on one repro turn.
2. If tool `roundtripMs` dominates → P1 (flush + handoff).
3. If `promptReadyMs` / RPC dominates → P2.
4. If TTFT after prompt is large but RPCs fast → effort/model; optionally P3 coalesce only for jerkiness.
5. Keep changes behind debug logs; re-measure the same turn shape after each slice.
