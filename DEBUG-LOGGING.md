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

## Bridge stderr logs

`kiro-acp-bridge.mjs` writes to **stderr** with prefix `[mcp-bridge]`. These appear in the Pi extension host output, not in the log file.

```
[mcp-bridge] tools/list 42 tools
[mcp-bridge] tools/call read_file callId: abc-123
[mcp-bridge] tools/call error read_file connect ECONNREFUSED
```

Fired at: `tools/list` (line 100), `tools/call` before HTTP POST (line 127), HTTP errors (line 150).

---

## All log messages

### index.ts — extension lifecycle

| Message | Data | When |
|---|---|---|
| `extension skipped (subagent context)` | `{ pid }` | Duplicate registration via Symbol |
| `extension loaded` | `{ pid, models, logFile }` | Extension initialized |
| `session_shutdown event received` | — | Pi fires session_shutdown |

### stream.ts — request flow

| Message | Data | When |
|---|---|---|
| `streamKiroAcp entry` | `{ modelId, toolsCount, messagesCount, systemPromptLen, sessionId }` | Stream handler called |
| `streamSimple called` | `{ session, isResumption, toolResults, pendingToolCalls, hasActivePrompt, cwd, optionSessionId, ensureStartedMs }` | Session routed |
| `prompt parts` | `{ session, includeHistory, promptChars, sessionBusy, hasActivePrompt }` | Before sending to kiro-cli |
| `timing first thinking` | `{ session, ttftMs, sincePromptMs }` | First `agent_thought_chunk` |
| `timing first text` | `{ session, ttftMs, sincePromptMs, sinceThinkingMs }` | First `agent_message_chunk` |
| `timing first tool` | `{ session, sinceTurnMs, sincePromptMs, toolName }` | First bridge tool call |
| `tool calls → stream` | `{ session, count, callIds }` | Tool calls emitted to AI stream |
| `tool call queued` | `{ session, callId, toolName }` | Tool call received from bridge |
| `prompt done → stop` | `{ session }` | Prompt completed, no tool calls |
| `prompt error → error` | `{ session, error }` | Prompt promise rejected |
| `outcome` | `{ session, outcome, gen, streamGen, timing }` | Stream outcome + TTFT / chunk stats |
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
| `thinkingChars` / `textChars` | Total chars received (pre-coalesce) |
| `thinkingChunks` / `textChunks` | ACP update count (pre-coalesce) |
| `avgThinkingChunkChars` / `avgTextChunkChars` | Mean chars per ACP chunk |
| `emittedThinkingDeltas` / `emittedTextDeltas` | Deltas pushed to pi after coalesce |
| `avgEmittedThinkingChars` / `avgEmittedTextChars` | Mean chars per emitted delta |
| `coalesceMs` | Batch window (`STREAM_COALESCE_MS`) |

### session-manager.ts — routing

| Message | Data | When |
|---|---|---|
| `route resumption` | `{ session, matches, toolResults }` | Tool results matched → resumption |
| `route: no resumption match found` | `{ toolResults, toolNames, pendingSessions }` | Tool results with no matching calls |
| `route existing keyed session` | `{ session, key, cwd, busy }` | Reusing keyed session |
| `route new keyed session` | `{ session, key, originalKey, cwd, existingBusy }` | New keyed session created |
| `route idle same-cwd session` | `{ session, cwd }` | Reusing idle anon session |
| `route new anon session` | `{ session, cwd, activeSessions }` | New anonymous session created |
| `pruning idle session` | `{ session, idleMs, key }` | Session idle >10min, removed |

### session.ts — session lifecycle & RPC

| Message | Data | When |
|---|---|---|
| `starting kiro session` | `{ session, cwd, agentRootPath, agentName }` | About to spawn kiro-cli |
| `session initialized` | `{ session, ipcPort, pid, timing }` | RPC initialize succeeded (`timing.mcpCfgMs` = settings-call duration, `preSpawnSetupMs`, `initializeMs`, `totalMs`) |
| `configured mcp.noInteractiveTimeout` | `{ session, minutes }` | First successful `kiro-cli settings` in this process |
| `skipped mcp.noInteractiveTimeout (already configured)` | `{ session }` | Later cold starts skip the ~0.3s settings call |
| `failed to configure mcp.noInteractiveTimeout` | `{ session, error }` | Settings call failed; will retry next cold start |
| `acp session/new` | `{ session, acpSessionId }` | New ACP session ID allocated |
| `model set` | `{ session, modelId, previousModel }` | Model changed via RPC |
| `prompt sent` | `{ session, modelId, replayHistory, promptChars, systemPromptChars, systemPromptIncluded, systemPromptSkipped, userMessageChars, imageCount, timing }` | `session/prompt` fired (system block once per ACP session unless hash changes) |
| `rpc →` | `{ session, method, id, timeoutMs, pendingCount }` | RPC request sent |
| `rpc ←` | `{ session, method, id, ms, hasError }` | RPC response received (`ms` = roundtrip) |
| `RPC TIMEOUT` | `{ session, method, id, timeoutMs, remainingPending }` | RPC exceeded timeout (60s default) |
| `stdout parse error` | `{ session, line }` | kiro-cli stdout is not valid JSON |
| `orphan RPC response` | `{ session, id, hasError }` | RPC response with no pending request |
| `kiro stderr` | `{ session, text }` | stderr from kiro-cli process |
| `kiro exited` | `{ session, code, signal }` | kiro-cli process exited |
| `cleanupAfterProcessExit` | `{ session, pendingRpcs, pendingToolCalls, hadActivePrompt }` | Cleanup after unexpected exit |
| `stopping kiro session` | `{ session }` | stop() called |
| `stop: killing process tree` | `{ session, rootPid, descendants }` | Force-killing (timeout path) |
| `IPC tool call received` | `{ session, callId, rawCallId, toolName, argsKeys }` | Bridge POST /tool/pending |
| `IPC tool call completed` | `{ session, callId, toolName, isError, roundtripMs }` | HTTP response after pi delivered result |
| `IPC error` | `{ session, error }` | Exception in handleIpcRequest |
| `delivering tool result` | `{ session, callId, toolName, resultLen, roundtripMs }` | Tool result matched and delivered |
| `UNMATCHED tool result` | `{ session, toolCallId, toolName, pendingCalls }` | Tool result with no matching call |
| `findToolCallMatch: rejecting name-match (foreign toolCallId)` | `{ session, toolCallId, toolName }` | Tool result from different session rejected |
| `ambiguous tool name match` | `{ session, toolName, matchCount, callIds }` | Multiple pending calls with same name |

---

## Common debugging scenarios

### Tool call not arriving

1. Check bridge stderr for `tools/call` — confirms kiro-cli issued the call
2. Check `IPC tool call received` — confirms bridge HTTP POST reached the extension
3. If missing: `tools/call error` in bridge stderr → IPC server unreachable (check `session initialized` for ipcPort)
4. Check `tool call queued` → `tool calls → stream` to confirm it was flushed to the AI stream

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
   grep -E 'timing first|prompt sent|outcome|IPC tool call|rpc ←|delivering tool' "$LOG"
   ```
4. Interpret:
   - Large `promptReadyMs` / `rpc ← initialize|session/new|set_model` → cold init / model set
   - Large gap `prompt sent` → `timing first thinking|text` → model/effort (not extension buffering)
   - Large `delivering tool result.roundtripMs` → pi tool-loop roundtrip (bridge waiting)
   - Tiny `avgTextChunkChars` + many `textChunks` → tiny ACP chunks; after coalesce check `avgEmittedTextChars` / `emittedTextDeltas`

See also `LATENCY-FIX-PLAN.md`.

### Wrong session selected / unexpected resumption

1. Trace `route *` messages for the relevant `session` ID
2. `route: no resumption match found` means tool results were provided but no pending calls matched — check `pendingSessions`
3. `UNMATCHED tool result` / `findToolCallMatch: rejecting name-match (foreign toolCallId)` indicate cross-session confusion
