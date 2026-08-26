# 0002 — Surviving Kiro's 120s MCP tool-call deadline

Status: accepted (2026-08)
Extends: [0001 — In-process HTTP MCP tool transport](0001-in-process-http-mcp-tool-transport.md)

## Context

Pi tools forwarded over `pi_host` can run far longer than a chat tool normally does:
`herdr_agent` waits minutes for a subagent, deep research fetches dozens of pages. The
transport in ADR 0001 assumed Kiro would hold its `tools/call` request open until pi
answered.

It does not. Measured against kiro-cli 2.19.1:

- Kiro abandons an in-flight `tools/call` after **120s exactly** (`waitedMs: 120002`,
  `120014`, `120019`, `120032` across runs) and closes the HTTP request.
- Its MCP client *does* request streaming (`accept: text/event-stream, application/json`)
  and *does* supply a `_meta.progressToken`, but neither SSE keepalives nor
  `notifications/progress` extend the deadline.
- The deadline is not configurable: `timeout` / `timeoutMs` on the `session/new`
  `mcpServers` entry are ignored, and `mcp.noInteractiveTimeout` is the MCP *initialization*
  timeout in milliseconds, not a per-call one. Kiro issue #8111 ("Support per-tool-call
  timeout for MCP servers") is still open.

Observed damage in one afternoon of real sessions: 33 `herdr_agent` calls issued over the
bridge, **7 results delivered**. Fast tools were unaffected (`fetch_content`: 14 issued, 13
delivered).

Three defects turned that drop into an unbounded loop:

1. `buildConversationPrompt` sliced history at the last *user* message, so the assistant
   `toolCall` and its `toolResult` — which sit after it — were never replayed. A rebuilt
   Kiro session saw only the original question. (`replayPromptChars` was byte-identical
   across three consecutive replays while the pi conversation had grown by a full report.)
2. `activePromptDone` was only cleared in the stream's `stop` / `error` branches. When Kiro
   ended its turn while pi was still running a tool, the promise settled into a stream that
   had already finished with `toolUse`, so the session stayed `busy` forever.
3. Because the session was permanently `busy`, routing could not reuse it: every returning
   tool result spawned another `pi:<id>:parallel:<sid>` kiro-cli process, replayed the
   question, and got the same tool called again. Five cycles in one turn, each leaking a
   process.

## Decision

**Accept the deadline; make the drop survivable.** Kiro is allowed to give up on a
`tools/call`; pi keeps executing the tool and the result is handed back as a new turn.

- **Recovery routing.** When a context carries tool results that match no pending bridge
  call, `routeSession` no longer falls through to "fresh session + replay". It reuses the
  live session that still holds the ACP conversation (`orphanedToolResults: true`), and the
  stream sends `buildToolResultRecoveryPrompt` — the result framed as the return value of
  Kiro's own abandoned call, with an explicit "do not call the tool again". If no live
  session exists, the replay path is forced (never a persisted resume, whose fingerprint
  ignores trailing results).
- **Retry deduplication.** Kiro's model often reissues the identical call once its deadline
  fires. Those retries are answered from `abandonedToolCalls` (keyed by tool name plus
  order-independent arguments) instead of being dispatched, so the tool never runs twice.
  Records are dropped after the recovery turn lands (`stop` / `toolUse`), after a
  30-minute TTL, or when the session stops. Clearing them *before* the follow-up
  prompt is sent lets Kiro's retry dispatch the tool a second time.
- **Prompt lifecycle.** `session/prompt` clears `activePromptDone` whenever it settles,
  guarded by a `promptSeq` so a late prompt cannot clear a newer one. Sessions become
  reusable instead of permanently `busy`.
- **Full replay.** `buildConversationPrompt` emits a `<work_already_done>` block for
  everything after the current user message, so no replay can lose completed work.
- **Keepalive anyway.** `tools/call` is answered over SSE when the client asks for it, with
  an SSE comment plus a `notifications/progress` message every 20s. Kiro ignores both today;
  it is kept because it is what the MCP transport prescribes and it costs nothing.

## Consequences

- A tool slower than 120s costs one extra Kiro turn: the abandoned call, then the recovery
  prompt. Idle-session recovery (no in-flight `session/prompt`) was verified end to end
  against kiro-cli 2.19.1 (135s hold): the result was delivered into the same ACP session
  and the tool was not rerun.
- Kiro's model sees an error for its abandoned call before the recovery prompt arrives. The
  dedup note tells it to end the turn rather than improvise a replacement; a model that
  ignores that will produce a partial answer, which the recovery turn then supersedes.
- Recovery depends on the pi session id (`options.sessionId`) to find the live session.
  Anonymous streams (no session id) fall back to the forced-replay path.
- The dedup key is tool name plus arguments, so a *deliberate* identical retry inside the
  same turn is suppressed until the first result comes back. That is the intended trade.
- If kiro-cli ever implements a configurable per-call timeout (issue #8111), the recovery
  path stays correct but becomes cold — set the timeout above pi's slowest tool and the
  120s drop disappears.

## Amendment (2026-08-26) — cancel before recovering into a live prompt

The idle-session probe was not the orchestrator path. After abandoning `tools/call`, Kiro
keeps the original `session/prompt` running (thinking / retrying the same tool). Recovery
that sent a *second* `session/prompt` without `session/cancel` failed immediately:

```
prompt parts { recoverInPlace: true, sessionBusy: true, hasActivePrompt: true }
prompt error → error { error: "Internal error" }   // 1ms
```

Then `clearAbandonedToolCalls` had already dropped the dedup record, so Kiro's retry of
`herdr_agent` was dispatched again. Confirmed by duration: scouts that finished in
93–99s delivered; the same tool at `waitedMs: 120002` did not.

- Recovery now uses `cancelAndStartFollowUp` (the image-follow-up handoff): cancel, wait
  for the original prompt to settle, then send the dropped result. The session stays
  `busy` during that wait so routing cannot fork `pi:<id>:parallel:<sid>`.
- `recoverInPlace` is decided from `acpSessionId` *before* `ensureStarted`. A freshly
  spawned process has an id for an empty conversation; handing it only the result (no
  `<work_already_done>` replay) is the relaunch loop.
- Abandoned-call records are cleared only after the recovery turn lands (`stop` /
  `toolUse`), not before the follow-up prompt is sent.

## Amendment (2026-08-26, later) — no unanswered tool_use may survive into recovery

The cancel-then-recover handoff still lost about half its turns. Of 21 recoveries in one
afternoon, 7 had their follow-up prompt rejected outright:

```
active prompt settled { stopReason: "cancelled", pendingToolCalls: 1 }
kiro log  WARN agent::agent: 4231: received a tool execution event for an agent
          not processing tools ... active_state: Idle
active prompt settled { stopReason: "refusal", pendingToolCalls: 0, elapsedMs: 4 }
outcome   { outcome: "stop", thinkingChars: 0, textChars: 0, turnMs: 6 }
```

The correlation is exact: `refusal` happened only when a `tools/call` was still open at
cancel time (7 of 14 such recoveries), never with `pendingToolCalls: 0` (0 of 8). Those open
calls are Kiro's retries after its own deadline fired, arriving once pi's stream had already
closed — pi could not dispatch them (`STRANDED`), so they hung until Kiro's next 120s
deadline. Cancelling with one outstanding left Kiro's conversation holding a `tool_use` whose
`tool_result` arrived a moment too late and was discarded, and the next prompt was refused.
Because the stream mapped any settled prompt to `stop`, pi saw a finished, empty turn: the
orchestrator appeared to stop the instant its subagent returned, and the user's "continue"
was really just the retry Kiro would have accepted.

- **Stranded calls are answered on arrival.** `toolIntakeClosed` (set by the stream's
  `finish`, cleared by every `startPrompt`) distinguishes "the turn is over" from "the stream
  has not attached yet"; the latter still queues, as the tool-batch window requires. An
  answered stranded call also ends Kiro's turn (`session/cancel`) when Kiro holds no other
  live pi call — nothing it produces afterwards can reach pi, so the alternative is paying
  for output nobody reads. A still-open sibling keeps the turn alive: that one can beat the
  deadline and be delivered normally.
- **Results before the cancel.** `cancelAndStartFollowUp` answers outstanding calls first and
  waits `PI_KIRO_ACP_DRAIN_MS` (150) before cancelling, so the result is consumed while Kiro
  still processes tools rather than after it goes Idle.
- **An empty refusal is a failed handoff, not a turn.** The stream re-sends the same recovery
  prompt once after `PI_KIRO_ACP_REFUSAL_RETRY_MS` (1500) — empirically what the manual nudge
  did — and ends the turn only if that is refused too.
