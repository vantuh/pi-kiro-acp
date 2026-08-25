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
| `PI_KIRO_ACP_DEBUG=1` | Enables the log file above (`0`/unset = no logging at all) |
| `PI_KIRO_ACP_VERBOSE=1..3` | Passes `-v`/`-vv`/`-vvv` to `kiro-cli acp`; its own logs land in the same file as `kiro log` |
| `PI_KIRO_ACP_MIRROR=0` | Disables mirroring Kiro's native tool calls into the transcript |

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
(`tool-bridge.ts`) registered as `pi_host`. It has no logging of its own; trace it
through `session.ts`:

- `session initialized` → `bridgePort` is the port the bridge is listening on
  (one per session; `null` means the bridge never started).
- `bridge tool call received` → Kiro issued `tools/call` and the extension turned it
  into a pending pi tool call.
- `delivering tool result` / `UNMATCHED tool result` → pi's result went back (or did not)
  to the waiting MCP request.

Kiro's *native* tools (`fs_read`, `fs_write`, `execute_bash`, `glob`, `grep`) never
touch the bridge — they run inside kiro-cli and only surface as mirrored thinking
blocks in the transcript.

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
| `streamSimple called` | `{ session, isResumption, toolResults, pendingToolCalls, hasActivePrompt, cwd, optionSessionId, ensureStartedMs }` | Session routed |
| `prompt parts` | `{ session, includeHistory, promptChars, sessionBusy, hasActivePrompt }` | Before sending to kiro-cli |
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
| `emittedThinkingDeltas` / `emittedTextDeltas` | Deltas pushed to pi (1:1 with ACP chunks since coalescing was removed) |

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
| `session initialized` | `{ session, bridgePort, pid, loadSession, resumeSession, timing }` | RPC initialize succeeded (`timing.bridgeMs` = pi_host startup, `preSpawnSetupMs`, `mcpCfgMs` = settings-call duration, `initializeMs`, `totalMs`) |
| `configured mcp.noInteractiveTimeout` | `{ session, minutes }` | First successful `kiro-cli settings` in this process |
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
| `delivering tool result` | `{ session, callId, toolName, resultLen, roundtripMs }` | Tool result matched and delivered (`roundtripMs` = bridge wait time) |
| `delivering tool result (text-only for image FUP)` | `{ session, callId, toolName, resultLen, roundtripMs }` | Same, on the image follow-up path |
| `rejecting pending tool calls` | `{ session, reason, count, callIds }` | Pending calls failed on cancel / handoff |
| `ACP usage update` | `{ session, acpSessionId, contextUsed, contextSize, sessionCost }` | `usage_update` for this ACP session |
| `kiro metadata` | `{ session, ... }` | `_kiro.dev/metadata` notification |
| `image FUP: *` | `{ session, ... }` | Image follow-up handoff (cancel → settle → re-prompt) |
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

Kiro runs `fs_read`/`fs_write`/`execute_bash`/`glob`/`grep` itself, so they only appear as
mirrored thinking blocks (`native-tool-mirror.ts`). If nothing shows up:

1. Confirm `PI_KIRO_ACP_MIRROR` is not `0`
2. Confirm thinking blocks are not hidden in the TUI — the mirror renders as thinking
3. The mirror only emits on `tool_call_update` with `status: completed|failed` (or on turn
   end via `flush()`); a tool still running shows only the transient `🔧 <title>` indicator
4. Tools carrying `_meta.kiro.mcpServerName` are skipped on purpose — those are `pi_host`
   tools and already render as real pi tool calls

### Wrong session selected / unexpected resumption

1. Trace `route *` messages for the relevant `session` ID
2. `route: no resumption match found` means tool results were provided but no pending calls matched — check `pendingSessions`
3. `UNMATCHED tool result` / `findToolCallMatch: rejecting name-match (foreign toolCallId)` indicate cross-session confusion
