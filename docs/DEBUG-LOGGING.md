# kiro-acp Debug Logging

## Log File

Path comes from Node `os.tmpdir()` (not always `/tmp` on macOS):

```
$TMPDIR/kiro-acp-debug.log
```

Example on this machine: `/var/folders/.../T/kiro-acp-debug.log`.  
On load, `extension loaded` includes `{ logFile }` when debug is on.

Format: `[HH:MM:SS.mmm] message {json}` — written by `logging.ts:log()` via `appendFile`.

### Watch in real-time

```sh
LOG="${TMPDIR%/}/kiro-acp-debug.log"
# or: node -e "console.log(require('os').tmpdir()+'/kiro-acp-debug.log')"
tail -f "$LOG"
# filter to one session
tail -f "$LOG" | grep '"session":"abc123"'
# clear and restart
: > "$LOG" && tail -f "$LOG"
```

---

## Debug toggles

| Variable | Effect |
|---|---|
| `kiro-acp.json` → `logger.debug: true` | Enables the log file above (`false`/unset = no logging) |
| `kiro-acp.json` → `logger.verbose: 1..3` | Passes `-v`/`-vv`/`-vvv` to `kiro-cli acp`; its own logs land in the same file as `kiro log` |
| `PI_KIRO_ACP_DRAIN_MS` | Grace period between answering Kiro's outstanding `tools/call` and cancelling its turn (default 150) |
| `PI_KIRO_ACP_REFUSAL_RETRY_MS` | Delay before re-sending a recovery prompt that came back as a contentless `refusal` (default 1500) |

### kiro-cli's own verbosity

kiro-cli writes `-v` output to **stdout — the same pipe as JSON-RPC** (there is no
file-log or log-level env var for ACP mode). Non-JSON lines are therefore split out
of the framing path and logged as `kiro log` with ANSI stripped. Two writers sharing
one pipe can in principle interleave a large frame, so this stays off by default and
is meant for a specific hunt:

```sh
PI_KIRO_ACP_VERBOSE=2 pi
```

Rough volume for one initialize + `session/new` cycle: `-v` ≈ 8 lines, `-vv` ≈ 20,
`-vvv` ≈ 173 (adds HTTP/transport traces).

---

## Tool transport (`pi_host`)

Pi extension tools reach Kiro through an in-process Streamable HTTP MCP server
(`tool-bridge.ts`) registered as `pi_host`. Transport-level diagnostics come from its
`onDebug` hook (`bridge tools/call *`); the rest is traced through `session.ts`:

- `session initialized` → `bridgePort` is the port the bridge is listening on
  (one per session; `null` means the bridge never started).
- `bridge tool call received` → Kiro issued `tools/call` and the extension turned it
  into a pending pi tool call.
- `delivering tool result` / `UNMATCHED tool result` → pi's result went back (or did not)
  to the waiting MCP request.
- `bridge tool call ABANDONED by kiro` → Kiro dropped the call at its 120s deadline; the
  result is recovered on the next turn instead (ADR 0002).
- `forwarded tool catalog updated` / `forwarded tool catalog is EMPTY` → the set of
  tools exposed to Kiro via pi_host changed (logged once per fingerprint). Empty means
  Kiro has zero tools — usually a session or subagent plan that deactivated everything.

All Kiro tools — builtins and extension tools alike — cross the pi_host bridge and are
executed by pi (ADR 0001 amendment 2026-09-04); there are no native Kiro tools on this
path anymore.

---

## All log messages

### index.ts — extension lifecycle

| Message | Data | When |
|---|---|---|
| `extension loaded` | `{ pid, models, logFile }` | Extension initialized |
| `dynamic models registered` | `{ models, ids }` | Model list discovered from kiro-cli |
| `dynamic model discovery failed; using fallback models` | `{ error }` | Discovery failed; `KIRO_MODELS` used |
| `session_shutdown` | `{ reason, targetSessionFile }` | Pi fires session_shutdown → all sessions stopped |

### stream.ts — request flow

| Message | Data | When |
|---|---|---|
| `streamKiroAcp entry` | `{ modelId, toolsCount, messagesCount, systemPromptLen, sessionId }` | Stream handler called |
| `streamSimple called` | `{ session, isResumption, toolResults, pendingToolCalls, hasActivePrompt, hadLiveConversation, cwd, optionSessionId, ensureStartedMs }` | Session routed (`hadLiveConversation` = ACP id existed *before* `ensureStarted`) |
| `prompt parts` | `{ session, promptChars, replayPromptChars, orphanedToolResults, recoverInPlace, hadLiveConversation, sessionBusy, hasActivePrompt, persistenceKey }` | Before sending to kiro-cli (`recoverInPlace` = a dropped tool result is being handed back instead of the user message) |
| `timing first thinking` | `{ session, ttftMs, sincePromptMs }` | First `agent_thought_chunk` |
| `timing first text` | `{ session, ttftMs, sincePromptMs, sinceThinkingMs }` | First `agent_message_chunk` |
| `timing first tool` | `{ session, sinceTurnMs, sincePromptMs, toolName }` | First bridge tool call |
| `tool calls → stream` | `{ session, count, callIds }` | Tool calls emitted to AI stream |
| `tool call queued` | `{ session, callId, toolName }` | Tool call received from bridge |
| `prompt done → stop` | `{ session }` | Prompt completed, no tool calls |
| `prompt error → error` | `{ session, error }` | Prompt promise rejected |
| `no active prompt → error` | `{ session, error }` | No prompt was in flight (process exited / session stopped) — turn fails instead of hanging |
| `outcome` | `{ session, outcome, gen, streamGen, timing }` | Stream outcome + TTFT / chunk stats |
| `image FUP: detected images in tool results` | `{ session, ... }` | Tool results carried images → follow-up prompt handoff |
| `streamKiroAcp FATAL error` | `{ error }` | Uncaught exception in stream handler |

`outcome.timing` fields:

| Field | Meaning |
|---|---|
| `turnMs` | Total time for this stream invocation |
| `streamMs` | Prompt sent → turn end (`turnMs − promptReadyMs`) |
| `ensureStartedMs` | Time until `ensureStarted` returned |
| `promptReadyMs` | Time until prompt sent / resumption delivered |
| `ttftThinkingMs` | Entry → first thinking chunk (`null` if none) |
| `ttftTextMs` | Entry → first text chunk (`null` if none) |
| `firstToolMs` | Entry → first tool call (`null` if none) |
| `thinkingChars` / `textChars` | Total chars received |
| `thinkingChunks` / `textChunks` | ACP update count |
| `avgThinkingChunkChars` / `avgTextChunkChars` | Mean chars per ACP chunk |

### session-manager.ts — routing

| Message | Data | When |
|---|---|---|
| `route resumption` | `{ session, matches, toolResults }` | Tool results matched → resumption |
| `route: no resumption match found` | `{ toolResults, toolNames, pendingSessions }` | Tool results with no pending call — Kiro abandoned its `tools/call` |
| `route orphaned tool result to live session` | `{ session, acpSessionId, toolNames }` | Recovery: the result is re-delivered as a follow-up prompt on the same ACP session |
| `route orphaned tool result: no live session to recover into` | `{ sessionId, cwd }` | No live session left; a full replay is forced instead |
| `route existing keyed session` | `{ session, key, cwd, busy }` | Reusing keyed session |
| `route new keyed session` | `{ session, key, originalKey, cwd, existingBusy }` | New keyed session created |
| `route idle same-cwd session` | `{ session, cwd }` | Reusing idle anon session |
| `route new anon session` | `{ session, cwd, activeSessions }` | New anonymous session created |
| `pruning idle session` | `{ session, idleMs, key }` | Session idle >10min, removed |

### session.ts — session lifecycle & RPC

| Message | Data | When |
|---|---|---|
| `starting kiro session` | `{ session, cwd, agentRootPath, agentName }` | About to spawn kiro-cli |
| `session initialized` | `{ session, bridgePort, pid, loadSession, resumeSession, timing }` | RPC initialize succeeded (`timing.bridgeMs` = pi_host startup, `preSpawnSetupMs`, `mcpCfgMs` = settings-call duration, `initializeMs`, `totalMs`) |
| `configured mcp.noInteractiveTimeout` | `{ session, ms }` | First successful `kiro-cli settings` in this process (MCP *initialization* timeout, in ms) |
| `skipped mcp.noInteractiveTimeout (already configured)` | `{ session }` | Later cold starts skip the ~0.3s settings call |
| `failed to configure mcp.noInteractiveTimeout` | `{ session, error }` | Settings call failed; will retry next cold start |
| `acp session/new` | `{ session, acpSessionId }` | New ACP session ID allocated |
| `model set` | `{ session, modelId, previousModel }` | Model changed via RPC |
| `prompt sent` | `{ session, modelId, replayHistory, promptChars, systemPromptChars, systemPromptIncluded, systemPromptSkipped, userMessageChars, imageCount, timing }` | `session/prompt` fired (system block once per ACP session unless hash changes) |
| `rpc →` | `{ session, method, id, timeoutMs, pendingCount }` | RPC request sent |
| `rpc ←` | `{ session, method, id, ms, hasError }` | RPC response received (`ms` = roundtrip) |
| `RPC TIMEOUT` | `{ session, method, id, timeoutMs, remainingPending }` | RPC exceeded timeout (60s default) |
| `stdout parse error` | `{ session, line }` | kiro-cli stdout is not valid JSON (truncated to 200 chars) |
| `kiro log` | `{ session, text }` | Same, but with `PI_KIRO_ACP_VERBOSE` on: kiro-cli's own `-v` line, kept in full |
| `stdout dispatch error` | `{ session, method, id, error }` | A consumer callback threw while handling a stdout message |
| `orphan RPC response` | `{ session, id, hasError }` | RPC response with no pending request |
| `kiro stderr` | `{ session, text }` | stderr from kiro-cli process (one entry per line, ANSI stripped) |
| `kiro exited` | `{ session, code, signal }` | kiro-cli process exited |
| `cleanupAfterProcessExit` | `{ session, pendingRpcs, pendingToolCalls, hadActivePrompt }` | Cleanup after unexpected exit |
| `stopping kiro session` | `{ session }` | stop() called |
| `stop: killing process tree` | `{ session, rootPid, descendants }` | Force-killing (timeout path) |
| `bridge tool call received` | `{ session, callId, kiroName, toolName, argsKeys }` | Kiro called a pi tool over `pi_host`; `callId` is `${session}-<n>` |
| `bridge tools/call accepted` | `{ session, tool, accept, streaming, hasProgressToken, pendingCount }` | Transport setup for the call (`streaming` = answered over SSE with keepalives; `pendingCount` includes this call) |
| `bridge tool call ABANDONED by kiro` | `{ session, callId, toolName, waitedMs, remainingPending }` | Kiro gave up on its own `tools/call` (measured: 120s on 2.19.1) while pi was still running the tool |
| `bridge tool call STRANDED (no stream attached)` | `{ session, callId, toolName, answered, cancellingTurn, remainingPending }` | Kiro called a tool after pi's turn closed. Answered immediately with `strandedNote` (it can never be dispatched); `cancellingTurn` means Kiro held no other live pi call, so its now-unreadable turn was cancelled too |
| `bridge tool call queued before stream attach` | `{ session, callId, toolName }` | Arrived between `session/prompt` and the stream attaching its handler — stays queued and is flushed on attach |
| `empty refusal → resending recovery prompt` | `{ session, attempt, delayMs, promptChars }` | The recovery prompt came back as a contentless `refusal`; it is re-sent instead of ending the turn |
| `empty refusal → stop` | `{ session, retried, recoverable }` | The retry was refused too (or there was nothing to re-send) — the turn ends |
| `empty refusal retry failed → error` | `{ session, error }` | The re-sent prompt could not be delivered |
| `bridge tools/call disconnected by client` | `{ session, tool, streaming, waitedMs }` | Same event seen from the HTTP side |
| `bridge tool call DEDUPED (already running)` | `{ session, toolName, abandonedCallId, abandonedAgoMs }` | Kiro reissued an abandoned call; answered without running the tool twice |
| `cleared abandoned tool call records` | `{ session, cleared, remaining, tools }` | Recovery turn landed; the tool may be called again |
| `active prompt settled` | `{ session, stopReason, pendingToolCalls, elapsedMs }` | `session/prompt` resolved; the session stops being `busy` even if its stream already ended with `toolUse` |
| `delivering tool result` | `{ session, callId, toolName, resultLen, roundtripMs }` | Tool result matched and delivered (`roundtripMs` = bridge wait time) |
| `delivering tool result (text-only for image FUP)` | `{ session, callId, toolName, resultLen, roundtripMs }` | Same, on the image follow-up path |
| `rejecting pending tool calls` | `{ session, reason, count, callIds }` | Pending calls failed on cancel / handoff |
| `ACP usage update` | `{ session, acpSessionId, contextUsed, contextSize, sessionCost }` | `usage_update` for this ACP session |
| `kiro metadata` | `{ session, ... }` | `_kiro.dev/metadata` notification |
| `image FUP: *` / `orphaned tool result: *` | `{ session, ... }` | Follow-up handoff (cancel → settle → re-prompt); recovery uses the `orphaned tool result` prefix |
| `startPrompt overlapping an in-flight prompt` | `{ session, pendingToolCalls }` | A second `session/prompt` was sent without cancel — kiro-cli answers `Internal error` |
| `restored persisted kiro session` / `failed to restore persisted kiro session` | `{ session, ... }` | Fingerprint-keyed resume of a previous ACP session |
| `persisted kiro session fingerprint mismatch` | `{ session, ... }` | History changed → cannot resume |
| `restarting Kiro for effort change` / `deferring effort change while session is busy` | `{ session, ... }` | `--effort` change handling |
| `UNMATCHED tool result` | `{ session, toolCallId, toolName, pendingCalls }` | Tool result with no matching call (`... (text-only)` on the image follow-up path) |
| `findToolCallMatch: rejecting name-match (foreign toolCallId)` | `{ session, toolCallId, toolName }` | Tool result from different session rejected |
| `ambiguous tool name match` | `{ session, toolName, matchCount, callIds }` | Multiple pending calls with same name |

---

## Common debugging scenarios

### Tool call not arriving

1. Check `session initialized` for a non-null `bridgePort` — without it Kiro was never told about `pi_host`
2. Check `bridge tool call received` — confirms Kiro's `tools/call` reached the extension
3. Check `tool call queued` → `tool calls → stream` to confirm it was flushed to the AI stream
4. If a fs/bash/glob/grep call is missing entirely: that is expected — those are Kiro-native and bypass the bridge (look for a mirrored thinking block in the transcript instead)
5. If the tool is missing from Kiro's list, check the catalog filter in `tool-catalog.ts` (only active, non-builtin/non-sdk pi tools are forwarded)

### Session dies unexpectedly

1. Look for `kiro exited` — note `code`/`signal`
2. Check `kiro stderr` lines before exit for error output from kiro-cli
3. `cleanupAfterProcessExit` shows how many pending RPCs/tool calls were dropped
4. If `hadActivePrompt: true`, the prompt was lost — Pi will likely error

### RPC timeout

1. `RPC TIMEOUT` shows `method` and `timeoutMs`
2. Look for preceding `rpc →` with the same `id` to measure latency
3. Check `kiro stderr` around same timestamp for subprocess errors
4. If `initialize` times out, kiro-cli never became ready — check spawn args in `starting kiro session`

### Streaming feels slow / waiting

1. Enable debug: `PI_KIRO_ACP_DEBUG=1`
2. Clear log: `LOG="${TMPDIR%/}/kiro-acp-debug.log"; : > "$LOG"`
3. Reproduce one slow turn, then:
   ```sh
   grep -E 'timing first|prompt sent|outcome|bridge tool call|rpc ←|delivering tool' "$LOG"
   ```
4. Interpret:
   - Large `promptReadyMs` / `rpc ← initialize|session/new|set_model` → cold init / model set
     (`session initialized.timing` splits it into `bridgeMs` / `preSpawnSetupMs` / `mcpCfgMs` / `initializeMs`)
   - Large gap `prompt sent` → `timing first thinking|text` → model/effort (not extension buffering)
   - Large `delivering tool result.roundtripMs` → pi tool-loop roundtrip (bridge waiting)
   - Tiny `avgTextChunkChars` + many `textChunks` → tiny ACP chunks; they are forwarded 1:1 now,
     so this is kiro-cli's chunking, not extension batching

See also `LATENCY-FIX-PLAN.md` (same directory).

### Native Kiro tool activity not visible in pi

Since the forwarded transport (ADR 0001 amendment 2026-09-04) Kiro has no native tools:
every tool call — `read`, `bash`, `edit`, `write`, extension tools — crosses the pi_host
bridge and renders as a real pi tool call (`toolCall`/`toolResult` pair), so there is
nothing separate to "see". The mirror that once rendered Kiro's native tools as
`<!--kiro-tool-->` marker blocks was removed along with its markdown transformer (ADR
0001 amendment 3); the only remaining trace is the strip readers in
`native-tool-frame.ts`, which clean legacy marker blocks and one-liner frames out of
historical persisted transcripts before they reach the model. New frames are never
created.

### Wrong session selected / unexpected resumption

1. Trace `route *` messages for the relevant `session` ID
2. `route: no resumption match found` means tool results were provided but no pending calls matched — check `pendingSessions`
3. `UNMATCHED tool result` / `findToolCallMatch: rejecting name-match (foreign toolCallId)` indicate cross-session confusion

### A slow tool's result never reaches Kiro

Kiro abandons any `pi_host` `tools/call` after 120s (kiro-cli 2.19.1) — SSE keepalives and
MCP progress notifications do not extend it, and the deadline is not configurable. Anything
slower than that (subagents, deep research) always takes the recovery path:

```sh
grep -E 'ABANDONED by kiro|DEDUPED|route orphaned|recoverInPlace|orphaned tool result' "$LOG"
```

Expected sequence for one slow tool:

1. `bridge tool call received` → `bridge tools/call accepted`
2. `bridge tool call ABANDONED by kiro` with `waitedMs` ≈ 120000
3. optionally `bridge tool call DEDUPED (already running)` if Kiro reissued the call
4. `route orphaned tool result to live session` + `prompt parts` with `recoverInPlace: true`
   and `hadLiveConversation: true`
5. `orphaned tool result: cancel sent` → `old prompt settle wait complete` → follow-up prompt
6. `cleared abandoned tool call records` after that turn lands (`stop` / `toolUse`)

`prompt error → error { error: "Internal error" }` within a few ms of `recoverInPlace: true`
while `hasActivePrompt: true` means the follow-up overlapped the original prompt — cancel
did not run, or did not settle. A `route new keyed session` with `originalKey` at step 4
instead means recovery failed and Kiro is being asked the original question again. See
`docs/adr/0002-surviving-kiro-mcp-tool-call-deadline.md`.

### The agent stops right after a subagent returns ("continue" restarts it)

The recovery prompt was refused outright. Signature:

```sh
grep -E 'STRANDED|empty refusal|"stopReason":"refusal"' "$LOG"
```

`active prompt settled { stopReason: "refusal", elapsedMs: 4-20 }` with an `outcome` of
`stop` and `thinkingChars: 0, textChars: 0` is kiro-cli rejecting a prompt sent while its
conversation still held a `tool_use` with no `tool_result`. It only ever happened when a
`STRANDED` call was still open at cancel time (7 of 14 recoveries on 2026-08-26; never with
`pendingToolCalls: 0`). Stranded calls are now answered on arrival and refusals are retried
once, so both the trigger and the silent stop should be gone — an `empty refusal → stop`
line means the retry was refused too.
