# kiro-acp Debug Logging

> **Pi copy.** Source and identity: [README.md](../README.md).
> Do not edit `home/dot_omp/private_agent/extensions/kiro-acp` for Pi work.
> The Oh My Pi copy uses `$TMPDIR/omp-kiro-acp-debug.log` and
> `~/.omp/agent/kiro-acp.json`.

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
| `PI_KIRO_ACP_RESTORE_LEAK_CHECK_MS` | Wait after a successful `session/load`/`session/resume` before committing the restore, so the racing leak/fallback signals can land and a suspect snapshot is abandoned (default 150; 0 disables the wait) |
| `PI_KIRO_ACP_REFUSAL_RETRY_MS` | Delay before re-sending a recovery prompt that came back as a contentless `refusal` (default 1500) |
| `PI_KIRO_ACP_EFFORT_COMMAND_TIMEOUT_MS` | Bound on the in-band `/effort <level>` command prompt, so a backend that never answers cannot pin the turn's reconciliation (default 10000) |
| `PI_KIRO_ACP_EFFORT_REPLY_GRACE_MS` | How long after a settled `/effort` command a chunk that still reads like the command's reply is dropped instead of streamed (default 2000) |

### kiro-cli's own verbosity

kiro-cli writes `-v` output to **stdout — the same pipe as JSON-RPC** (there is no
file-log or log-level env var for ACP mode). Non-JSON lines are therefore split out
of the framing path and logged as `kiro log` with ANSI stripped. Two writers sharing
one pipe can in principle interleave a large frame, so this stays off by default and
is meant for a specific hunt:

```sh
# logger.debug + logger.verbose go to ~/.pi/agent/kiro-acp.json:
# { "logger": { "debug": true, "verbose": 2 } }
pi
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

Forwarded Pi tools cross the `pi_host` bridge and are executed by pi (ADR 0001
amendment 2026-09-04). A **fresh** session with `tools: ["@pi_host"]` registers
no Kiro builtins at all (verified against kiro-cli 2.21.1). Builtins can only
leak back when `session/load` restores a persisted session whose snapshot
predates the current agent config — `model-visible tools { builtins: [...] }`
detects that, the stale snapshot is never resumed again (config fingerprint),
and the process restarts before the next turn. Spawn uses
`--trust-tools=@pi_host` (not `--trust-all-tools`; verified live: pi_host tools
run with zero permission RPCs). Permission RPC denies anything that is not
`pi_host` / a forwarded `kiroName` / `pi_*`. `excludedTools: ["@builtin"]` is
parsed by 2.21 but has no effect there; written for CLI 3+.

### Thinking levels (`effort`)

The thinking level is applied **in band**, not at spawn: kiro-cli 2.24.1
silently drops the `--effort` flag unless the process also fixes `--model`
(the session model is `auto`), and `session/set_model` clears the session's
effort — extra fields on that RPC are ignored. The only remaining channel is
the `/effort <level>` command, which kiro's ACP layer intercepts from a
`session/prompt` and answers with an assistant chunk instead of calling the
model. `session.ts` therefore sends that prompt directly (not via
`startPrompt`, so the turn's bookkeeping is untouched), suppresses the reply
so it cannot reach pi as model output, and re-applies the level after every
`session/set_model`. Clearing a level is the one thing kiro cannot express
in-band (`/effort` rejects every "unset" spelling), so that case restarts the
process — the only restart effort still needs. A change that arrives while the
session is busy is deferred (`deferring effort change while session is busy`)
and applied before the next turn's prompt.

Reconciliation is **one command per turn and one command at a time**. A turn
tries to apply a missing level once — `ensureStarted` normally, `startPrompt`
only when `session/set_model` dropped it or the previous attempt never ran
(`effortReconcilePending`) — so a level kiro refuses costs one
`effort not applied` per turn, not two. Concurrent reconciliations serialise
on one in-flight command (a command prompt is not part of `busy`, and two
interleaved commands would share the suppression state); a caller that waited
for a command which did *not* apply the level it wanted gets one more.

The command is **bounded** (`effortCommandTimeoutMs()`, 10s; override with
`PI_KIRO_ACP_EFFORT_COMMAND_TIMEOUT_MS`) unlike the turn's own prompt, which is
unlimited: a backend that never answers logs `effort not applied` with the
timeout as `error`, leaves the applied level alone, and suppression is always
released — a stuck command can never leave the session dropping model output.
The reply is captured up to 1024 chars (`effort command reply truncated`).
kiro answers with the reply chunk *before* the RPC result, but that order is
not relied on: for 2s after the command settles
(`PI_KIRO_ACP_EFFORT_REPLY_GRACE_MS`) a chunk that reads like a command reply
(`Effort set to` / `Effort is not available` / `invalid effort level`, or a
prefix of one) is still dropped as `late: true`; anything else is forwarded as
model output.

`kiro reasoning` and `kiro effort mismatch` come from
`_kiro.dev/metadata.reasoning` and are the only feedback that a level actually
took. A reported level counts as a mismatch only when a level is believed
*applied*: with nothing applied kiro reports the model's own default (live:
`max` for opus-5 right after `session/set_model`), which is not a mismatch and
is never adopted as ours — the pending reconciliation the model change or fresh
spawn already scheduled re-applies the desired level. A mismatch is also
ignored while a command is in flight, where the report is the pre-command
state by design. Seen at any other time, it invalidates the session's belief
in its applied level, so the next turn re-sends the command.

---

## All log messages

### index.ts — extension lifecycle

| Message | Data | When |
|---|---|---|
| `extension loaded` | `{ pid, models, logFile }` | Extension initialized |
| `dynamic models registered` | `{ models, ids }` | Model list discovered from kiro-cli |
| `dynamic model discovery failed; using fallback models` | `{ error }` | Discovery failed; `KIRO_MODELS` used |
| `session_shutdown` | `{ reason, targetSessionFile }` | Pi fires session_shutdown → ACP sessions owned by that extension instance stopped |

### stream.ts — request flow

| Message | Data | When |
|---|---|---|
| `streamKiroAcp entry` | `{ modelId, toolsCount, messagesCount, systemPromptLen, sessionId }` | Stream handler called |
| `streamSimple called` | `{ session, routeKind, toolResults, pendingToolCalls, hasActivePrompt, hadLiveConversation, cwd, optionSessionId, ensureStartedMs }` | Session routed (`routeKind`: `prompt` / `resumption` / `orphaned`; `hadLiveConversation` = ACP id existed *before* `ensureStarted`) |
| `prompt parts` | `{ session, promptChars, replayPromptChars, routeKind, recoverInPlace, hadLiveConversation, sessionBusy, hasActivePrompt, persistenceKey }` | Before sending to kiro-cli (`recoverInPlace` = a dropped tool result is being handed back instead of the user message) |
| `timing first thinking` | `{ session, ttftMs, sincePromptMs }` | First `agent_thought_chunk` |
| `timing first text` | `{ session, ttftMs, sincePromptMs, sinceThinkingMs }` | First `agent_message_chunk` |
| `native ACP tool update (not forwarded to pi)` | `{ session, sessionUpdate, native, mcpServer, kiroToolName, toolCallId, status, kind }` | ACP `tool_call` / `tool_call_update` without `pi_host` (Kiro AgentCrew / native fs) |
| `ACP tool update` | same | ACP tool update that *is* tagged `pi_host` |
| `unhandled ACP sessionUpdate` | `{ session, sessionUpdate }` | Any other `sessionUpdate` kind |
| `permission request` | `{ session, allow, toolName, mcpServer, optionId, cancelled }` | `session/request_permission` allow/deny |
| `timing first tool` | `{ session, sinceTurnMs, sincePromptMs, toolName }` | First bridge tool call |
| `tool calls → stream` | `{ session, count, callIds }` | Tool calls emitted to AI stream |
| `tool call queued` | `{ session, callId, toolName }` | Tool call received from bridge |
| `prompt done → stop` | `{ session }` | Prompt completed, no tool calls |
| `skip persisting kiro session (backend quarantined)` | `{ session, acpSessionId }` | Turn finished on a leaked backend — its snapshot is not saved, so the leak cannot be resumed |
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
| `starting kiro session` | `{ session, cwd, agentRootPath, agentName, desiredEffort }` | About to spawn kiro-cli (`desiredEffort` = the level this turn asked for; the level is applied in-band, not by a spawn flag) |
| `session initialized` | `{ session, bridgePort, pid, loadSession, resumeSession, timing }` | RPC initialize succeeded (`timing.bridgeMs` = pi_host startup, `preSpawnSetupMs`, `mcpCfgMs` = settings-call duration, `initializeMs`, `totalMs`) |
| `configured mcp.noInteractiveTimeout` | `{ session, ms }` | First successful `kiro-cli settings` in this process (MCP *initialization* timeout, in ms) |
| `skipped mcp.noInteractiveTimeout (already configured)` | `{ session }` | Later cold starts skip the ~0.3s settings call |
| `failed to configure mcp.noInteractiveTimeout` | `{ session, error }` | Settings call failed; will retry next cold start |
| `acp session/new` | `{ session, acpSessionId }` | New ACP session ID allocated |
| `model-visible tools` | `{ session, count, builtins, mcpServers }` | `_kiro.dev/commands/available` — the model's actual tool list, logged once per change. Non-empty `builtins` means the agent config was not applied or a restored snapshot leaked builtins |
| `KIRO BUILTINS LEAKED into the model tool list` | `{ session, builtins }` | Built-in tools detected in the model-visible list; recovery scheduled and backend quarantined (persist suppressed), persisted snapshot cleared, restart scheduled for the next turn |
| `model-visible tools clean — leak quarantine lifted` | `{ session }` | A clean tools list on the same process after a leak — persistence resumes for the new snapshot |
| `restarting Kiro: leaked builtins or agent fallback` | `{ session, attempt }` | Pre-turn restart after a leak or fallback (fresh process + session; bounded at two attempts) |
| `deferring leaked-builtins restart while session is busy` | `{ session }` | Leak restart postponed because a prompt is in flight |
| `GIVING UP on leak/fallback recovery after two restarts — session degraded` | `{ session }` | Recovery bounded out (deterministic fallback/leak); session keeps running gated and unpersisted — investigate the agent config |
| `KIRO AGENT NOT FOUND — kiro-cli fell back` | `{ session, requestedAgent, fallbackAgent }` | kiro-cli could not discover the spawned `--agent` and ran under `kiro_default` (all builtins, wrong prompt); schedules a bounded recovery restart — always investigate if it repeats |
| `model set` | `{ session, modelId, previousModel }` | Model changed via RPC |
| `prompt sent` | `{ session, modelId, replayHistory, promptChars, systemPromptChars, systemPromptIncluded, systemPromptSkipped, userMessageChars, imageCount, timing }` | `session/prompt` fired (system block once per ACP session unless hash changes) |
| `rpc →` | `{ session, method, id, timeoutMs, pendingCount }` | RPC request sent |
| `rpc ←` | `{ session, method, id, ms, hasError }` | RPC response received (`ms` = roundtrip) |
| `RPC TIMEOUT` | `{ session, method, id, timeoutMs, remainingPending }` | RPC exceeded timeout (60s default) |
| `stdout parse error` | `{ session, line }` | kiro-cli stdout is not valid JSON (truncated to 200 chars) |
| `kiro log` | `{ session, text }` | Same, but with `logger.verbose` on (kiro-acp.json): kiro-cli's own `-v` line, kept in full |
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
| `abandoning restored kiro session — leak/fallback during restore` | `{ session, method, acpSessionId }` | The restore RPC succeeded but the fallback/leak signals landed within the check window — the suspect snapshot is cleared and the process restarts with a fresh session (history replayed from pi) |
| `persisted kiro session fingerprint mismatch` | `{ session, ... }` | History changed → cannot resume |
| `effort applied` | `{ session, level }` | kiro accepted the in-band `/effort <level>` command (`Effort set to …`); the session now has that level |
| `effort not applied` | `{ session, level, kiroReply, commandMs }` / `{ session, level, commandMs, error }` | The command was refused (`Effort is not available on this model.`, `invalid effort level …`), the RPC failed or the process died, or it went unanswered past the command timeout — the applied level is left unchanged and the next turn retries |
| `effort command reply truncated` | `{ session, maxChars }` | The captured command reply hit the 1024-char cap; only the prefix was parsed |
| `resetting Kiro effort` | `{ session, from, reason }` | Clearing an applied level; kiro has no in-band clear, so the process restarts (the only restart effort needs) |
| `deferring effort change while session is busy` | `{ session, currentEffort, requestedEffort }` | A level change arrived mid-turn; `/effort` is a `session/prompt`, so it is applied before the next turn's prompt instead |
| `suppressed kiro command output` | `{ session, sessionUpdate, late }` | An assistant chunk dropped because it was the `/effort` command's own reply, not model output (`late: true` = caught by the post-command grace window rather than while the command was in flight) |
| `kiro reasoning` | `{ session, reasoning }` | `_kiro.dev/metadata.reasoning` changed (`support` / `thinkingEnabled` / `effort` / `effortLevels`); logged once per change, not per tick |
| `kiro effort mismatch` | `{ session, desired, reported }` | A level is applied and kiro reports a different `effort` — the only signal that the level did not take. Logged once per `{desired, reported}` pair, never while a command is in flight (that window reports the pre-command level by design) and never when nothing is applied (kiro's report is then the model's default); it also invalidates the session's belief in its applied level, so the next turn re-sends the command |
| `UNMATCHED tool result` | `{ session, toolCallId, toolName, pendingCalls }` | Tool result with no matching call (`... (text-only)` on the image follow-up path) |
| `findToolCallMatch: rejecting name-match (foreign toolCallId)` | `{ session, toolCallId, toolName }` | Tool result from different session rejected |
| `ambiguous tool name match` | `{ session, toolName, matchCount, callIds }` | Multiple pending calls with same name |

---

## Common debugging scenarios

### Tool call not arriving

1. Check `session initialized` for a non-null `bridgePort` — without it Kiro was never told about `pi_host`
2. Check `bridge tool call received` — confirms Kiro's `tools/call` reached the extension
3. Check `tool call queued` → `tool calls → stream` to confirm it was flushed to the AI stream
4. If a call is missing entirely, check for `NameCollision` in the kiro-cli WARN lines: a forwarded tool sharing a Kiro builtin name was dropped; the catalog aliases those (`read` → `pi_read`, …)
5. If the tool is missing from Kiro's list, check `forwarded tool catalog updated` diagnostics in `tool-catalog.ts` (all active builtin + extension pi tools are forwarded; only host-SDK customs stay out)

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

### Native Kiro tool activity not visible in pi

A fresh session has no Kiro builtins (`tools: ["@pi_host"]` — verified against
kiro-cli 2.21.1 with a probe MCP server). Builtins leak back only when
`session/load` restores a persisted session whose agent snapshot predates the
current agent config — including the case of a snapshot bound to a
previous process's agent name (the agent name is now **stable per
persistence key** — derived from the persisted-session identity — so the
next process rewrites the identical config under the same name and
`session/load` re-resolves it: verified clean cross-restart restore with
`replayHistory:false`. Only sessions without a persistence key keep a
random name, and snapshot-config mismatches can still leak):
`NameCollision(BuiltIn(FsRead/AgentCrew/…))` then drops
same-named pi_host specs and the native tool becomes model-visible. The
forwarded catalog aliases those names (`subagent` → `pi_subagent`, `read` →
`pi_read`, …) so the MCP spec survives. `bash`/`edit` keep their Pi names.

Three layers handle a leak:

1. **Persistence gate** — `agentConfigFingerprint` (semantic config hash) is
   stored with every persisted session; a mismatch refuses restore and starts
   fresh (`persisted kiro session fingerprint mismatch { historyMatch,
   configMatch }`).
2. **Runtime detection** — `_kiro.dev/commands/available` carries the model's
   actual tool list (`tools[].source` is `built-in` or `mcp:<server>`).
   `model-visible tools { builtins: [...] }` logs it; non-empty `builtins`
   triggers `KIRO BUILTINS LEAKED …`, clears the persisted snapshot, and — for
   leaks on a **restored** backend or an **agent fallback** — the next
   `ensureStarted` restarts the process fresh (deferred while busy, bounded at
   two attempts per session; a deterministic fallback then gives up loudly).
   A clean list on the same process lifts the quarantine. An agent fallback is
   additionally reported by `KIRO AGENT NOT FOUND`. A restore whose restore RPC
   succeeded but whose leak/fallback signals landed during the decision window
   is **abandoned before it is ever used** (`abandoning restored kiro session —
   leak/fallback during restore`): the snapshot is cleared and the process
   restarts with a fresh session — pi replays the full history, so the model
   keeps its context, only Kiro-side state is lost.
3. **Execution gate** — `--trust-tools=@pi_host` plus deny-by-default
   `session/request_permission` blocks native execution that goes through the
   permission RPC (verified live: a pi_host tool executes with zero permission
   RPCs, so the gate costs nothing on the happy path). Native calls that skip
   the RPC cannot be blocked on 2.21 — that needs a CLI honoring
   `excludedTools`.

```sh
grep -E 'model-visible tools|BUILTINS LEAKED|AGENT NOT FOUND|native ACP tool update|permission request|NameCollision|Aliasing ' "$LOG"
```

`native ACP tool update` is an ACP `tool_call` with `mcpServer` set and not `pi_host`,
or a builtin name (`subagent`, `read`, …) and no mcpServer. Missing `_meta` on a
non-builtin (e.g. `bash`) is *not* treated as native. The display-only mirror is gone
(ADR 0001 amendment 3); these lines plus `permission request { allow: false }` are
the remaining live trace.

`KIRO AGENT NOT FOUND — kiro-cli fell back` means the spawned `--agent` name was
not discovered by kiro-cli and everything ran under `kiro_default` (all builtins,
wrong prompt). This must never be silent.

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
