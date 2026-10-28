# Kiro CLI V3 ACP: live probe findings

Measured on 2026-10-28 against the real `kiro-cli acp --agent-engine=v3 --auth-method=cli`.
Unless a line says otherwise, everything was observed on kiro-cli 2.35.1 (KAS 0.66.70);
the agent-selection and tool-lockdown probes ran first on 2.34.0 (KAS 0.66.62) and the
`initialize` result was re-checked on 2.35.1. Steering scenarios are reproducible with
[`test/e2e/v3-native-steer.mjs`](../test/e2e/v3-native-steer.mjs)
(`KIRO_E2E_LIVE=full`, spends credits). Reference: the
[ACP client migration guide](https://kiro.dev/docs/cli/v3/acp-migration.md).

## Handshake

- `initialize` advertises `loadSession: true`, `sessionCapabilities` `list`, `close`,
  `delete`, `fork`, and 32 `_meta.kiro.extensionMethods` (2.35.1 added
  `_kiro/memory/getSyncStatus`). **`_session/steer` is not advertised**, yet it is
  implemented (below).
- An unknown client-to-agent method returns `-32603 Internal error` with
  `data.details` "has no persistence classification", not `-32601`.
- Fresh `session/new` returns `modes` and `configOptions`: `mode`, `model` (each model
  option carries `_meta.kiro.effortLevels` and `defaultEffortLevel`), `memoryReflection`,
  `autopilot`, `contentCollection`. No `effortLevel` option appeared on a fresh session
  with model `auto`.
- V3 writes its own session files and logs under `~/.kiro` (logs path is in
  `_meta.kiro.logging`); there is no flag to avoid that.

## Selecting our agent without `--agent`

V3 resolves agent profiles from the session workspace, not from the process cwd: a
profile in the spawn cwd's `.kiro/agents/` is not offered as a mode. This works and
touches neither the user project nor `~/.kiro`:

```json
{
  "cwd": "<real project>",
  "additionalDirectories": ["<temp dir holding .kiro/agents/<name>.json>"],
  "mcpServers": [<pi_host>],
  "_meta": { "kiro": { "modeId": "<name>" } }
}
```

The response reports `modes.currentModeId: "<name>"`.

## Agent selection failures and restore

Free probe on 2.35.1: only `initialize`, `session/new`, `session/load` and
`session/list`, no `session/prompt`, no credits.

Both `session/new` and `session/load` answer with `modes.currentModeId` and
`modes.availableModes` (`[{id, name, description, _meta}]`, the seven bundled modes plus
ours when it resolves). **No agent-selection failure is ever a JSON-RPC error**: the
session is created or loaded normally and silently runs in mode `vibe` with every Kiro
built-in tool active.

| Case | Response | Late notification |
|---|---|---|
| `modeId` names a profile that does not exist | `vibe`, `availableModes` without it | `_kiro/customAgent/not_found {requestedAgent, fallbackAgent: "vibe"}` |
| Profile deleted between new and load (leak) | `vibe` | `_kiro/customAgent/not_found`, same shape |
| v2-shaped profile (`allowedTools`, no `permissions`) | `vibe` | `not_found` with `skipped: {path, reasonCode: "cli_only_agent", error: "Agent profile uses fields this agent engine does not support: allowedTools"}` |
| Broken JSON profile | `vibe` | `_kiro/customAgent/config_error {sessionId, path, reasonCode: "invalid_config", error: "AgentFileFormatError: …"}`, then `not_found` |
| `session/load` without the agent dir in `additionalDirectories` | `vibe` | none needed |

So `modes.currentModeId !== <agentName>` is the only synchronous signal, and it is
reliable. The `_kiro/customAgent/*` notifications always arrive *after* the response and
are post-mortem detail only.

Restore specifics:

- `session/load` **ignores `_meta.kiro.modeId`**: the mode stored with the session wins
  (a `vibe` session loaded with `modeId: "<agent>"` stays `vibe`; our session loaded with
  `modeId: "vibe"` stays ours). A wrong mode cannot be repaired by loading again — the
  session has to be recreated with `session/new` and the history replayed.
- A load whose agent dir differs from the one the session was created with works: old dir
  deleted, new dir holding a profile of the same name → `currentModeId` is our agent. The
  per-process temp agent root is therefore fine across restarts.
- `session/list` carries both `_meta.modeId` (requested) and `_meta.agentMode` (effective);
  a fallback session shows the requested id next to `agentMode: "vibe"`, and a session
  that never had an agent shows only `agentMode`.
- `_kiro/tools/didChange` is **not** a lockdown signal: in our mode its tags include
  `{source: "builtin", tag: "read"}` even though builtins are denied. MCP tools appear
  there as `@pi_host/<name>` next to same-named builtins (`read`, `write`, `shell`, `web`)
  with no collision handling, no warning, and `disabled: false` for all of them in
  `_kiro/mcp/status`; the paid tool-lockdown probe (*Only pi tools visible*, below) still
  showed the model in our mode reaching `pi_host` tools (`tool_load`/`tool_call`) and
  running `pi_host::read` while a builtin `read` existed.
- Supporting signal: `session_info_update` `_meta.kiro.breakdown.tools` reports
  `builtin.tokens` ≈1.7–2.0k in our mode versus ≈4.9–5.2k in `vibe` — the builtin schemas
  that the `builtin: deny` rule removes.

Client guard (implemented in `src/session.ts`):

1. `session/new`: adopt the session only when `modes.currentModeId` is our agent; on a
   mismatch log the requested agent and the actual mode, leave the session unadopted
   (`acpSessionId` stays null) and fail the turn — the next turn retries with a freshly
   written profile.
2. `session/load`: same check on the load response. A mismatch is handled like a failed
   restore — drop the persisted record, restart the process and let the caller replay the
   history into a fresh `session/new`. The v2 hazard window
   (`RESTORE_LEAK_CHECK_MS`, builtin-leak bookkeeping) is skipped on V3: those
   notifications do not exist there and the mode is synchronous.
3. `_kiro/customAgent/not_found` and `_kiro/customAgent/config_error` are logged (agent
   names, `reasonCode`, error text, path) and change no state.

## Only pi tools visible

In V3 the model does not see MCP tools directly. It gets the meta tools `tool_load`
(loads `pi_host::<tool>` and returns its schema) and `tool_call` (runs it with
`{tool_id, arguments}`); a forwarded call then appears as a `tool_call` update with
`title: "@pi_host/<tool>"` and `_meta.kiro.serverName: "pi_host"`.

Asking the model to list its tools, per profile variant:

| Profile | Model's tools | `pi_host` call |
|---|---|---|
| `tools: ["@pi_host"]` + `permissions` allow `mcp pi_host/*` | `tool_load`, `tool_call`, `disclose_context` | works |
| same + `excludedTools: ["@builtin"]` | `disclose_context` only | **broken**: model has no way to reach MCP |
| same + `excludedTools: ["disclose_context"]` or `["context"]` | unchanged, still has `disclose_context` | works |
| `tools: ["@pi_host"]` + rules `mcp pi_host/*` allow, `builtin` deny | **`tool_load`, `tool_call`** | works |

`disclose_context` activates Kiro skills and steering documents (it would pull in
`~/.kiro/skills`). The last row is the profile to use:

```json
{
  "tools": ["@pi_host"],
  "permissions": { "rules": [
    { "capability": "mcp", "match": ["pi_host/*"], "effect": "allow" },
    { "capability": "builtin", "effect": "deny" }
  ]}
}
```

With it no `session/request_permission` arrived in any run, and the model said it had
no `disclose_context` when asked to call it. V3 skips a profile that has
`allowedTools` but no `permissions`, so the v2 profile cannot be reused as is.

## Model, effort and telemetry

Free RPCs only — `initialize`, `session/new`, `session/set_config_option`, `session/load`,
`session/close`; no turn was prompted.

`session/new` carries a `configOptions` array instead of v2's `models`. Ids in a fresh
session: `mode`, `model`, `memoryReflection`, `autopilot`, `contentCollection`. The
`model` select lists 15 values, and each choice documents its own effort support in
`_meta.kiro`:

```json
{ "value": "claude-opus-5.5", "name": "Claude Opus 5.5",
  "_meta": { "kiro": { "rateMultiplier": 2, "rateUnit": "Credit", "hasEffort": true,
    "effortSchemaPath": "output_config",
    "effortLevels": ["low","medium","high","xhigh","max"], "defaultEffortLevel": "medium" } } }
```

- Effort-capable: `claude-opus-5.5`, `claude-sonnet-5.5`, `gpt-5.6-terra`, `gpt-5.6-luna`,
  `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.8`, `claude-sonnet-4.6`. The GPT
  models also offer `none`, and `claude-sonnet-4.6` stops at `max` without `xhigh`.
- No effort: `auto`, `claude-haiku-4.5`, `deepseek-3.2`, `minimax-m2.5`, `minimax-m2.1`,
  `glm-5`, `qwen3-coder-next` (`hasEffort: false`).
- There is **no `effortLevel` option** until an effort-capable model is current, and it
  disappears again when a model without effort is selected.

`session/set_config_option { sessionId, configId, value }` answers with the full
`configOptions` array and emits a `config_option_update` with the same array. Selecting a
model also emits `session_info_update` (`context_usage`) and `available_commands_update`
frames; setting the effort level emits only the `config_option_update`.

The trap: **an unusable value is not an error**. `model: "no-such-model"` is echoed back as
`currentValue` (and drops the `effortLevel` option), and an `effortLevel` the model does not
list is answered with the unchanged `currentValue`. So the caller has to check the value
against the advertised options before writing it, and read `currentValue` back to know what
was actually applied. The provider does exactly that: model ids it did not see are refused
with an explicit error, an effort level the model does not advertise is logged and skipped,
and `currentEffort` is only set when kiro echoes the level back.

The ids themselves are portable: the 15 v2 `availableModels.modelId` values and the 15 v3
`model` option values are the same set, in the same order, with no difference in either
direction.

`session/load` was not probed for `configOptions`. When a restore response carries none, the
provider writes the model value unchecked rather than refusing every id (the echo still
decides what is recorded), and skips the effort level for that turn.

Telemetry arrives as `session/update` frames, not as the v2 `_kiro.dev/metadata`
notification. Every `session_info_update` carries `_meta.kiro.kind`:

| kind | payload used |
|---|---|
| `context_usage` | `usagePercentage` → `contextUsagePercentage` |
| `turn_completion` | `elapsedTime` (ms), `promptTurnSummaries[].{unit,unitPlural,usage}` → credits |
| `turn_start`, `turn_end`, `focus_update`, `steering_queued`, `steering_injected`, `steering_cleared`, `user_message_id_assigned` | nothing to record |

A turn still ends on the `session/prompt` result, so those kinds are consumed and dropped
rather than surfaced to the stream.

Tool identity differs from v2 as well: a forwarded call is tagged
`_meta.kiro.mcpTool.identity.{serverName,toolName}` or a `title` of `@pi_host/<tool>`, while
the meta tools are titled `Tool Load` and `tool_call` with no identity at all — so they can
never be mistaken for a `pi_host` call. Because a server name is now only part of the title,
V3 cannot use v2's name-only fallback: a call is ours only when the tag says `pi_host` *and*
the forwarded catalog still lists the tool, otherwise `@evil/slow` would pass on the strength
of a forwarded `slow`. `session/request_permission` on V3 offers `{ optionId, name, kind }`;
the provider only ever selects `allow_once`/`reject_once` and cancels a request that offers
nothing else, since a standing grant would run the tool for the rest of the session without
pi seeing it.

## Native steering: `_session/steer`

Request `{ sessionId, message: string }` (`prompt` or `content` arrays are rejected as
"missing or empty message"); response `{ queued: true, messageId: "steer-<uuid>" }`.
Lifecycle notifications are `session_info_update` with `_meta.kiro.kind`
`steering_queued` (at the call), `steering_injected`, and `steering_cleared` (at turn
end), each carrying the `messageId`.

Every scenario used the pi-only profile above, a `pi_host` tool `slow` that sleeps 20 s,
and the steer "Add the code word CANARY-<random> to your final answer." A run passes
only when the word is in the answer outside the model's `[STEERING …]` note.

| Scenario | Runs | Result |
|---|---|---|
| Steer 3 s into a running `pi_host` tool call | 10 | 9/10 obeyed. `steering_injected` came the instant the tool result arrived, before the next model output. The one miss mentioned the word only in its `[STEERING …]` note. |
| Same, agent prompt says never to write `[STEERING …]` notes | 3 | 3/3 obeyed; note still written in 1/3 |
| Steer while the model streams text, no tool | 2 | 2/2 obeyed, but **the whole answer was streamed twice**: Kiro injects after the first answer finishes and the model writes it again with the word. A follow-up turn did not repeat the word. |
| Steer on an idle session, then a prompt | 1 | Queued while idle; `steering_injected` at the next `turn_start`; obeyed. |
| Steered turn, kill the process, `session/load` in a new one, ask for the word | 1 | Recalled. Replay shows the steer as a `user_message_chunk` between the tool call and its result. |
| Steer on an idle session, kill the process before any turn, `session/load`, prompt | 1 | The queued steer **survived the restart** (replayed as a `user_message_chunk`) and was injected into the next turn; obeyed. |

Model behaviour around the steer:

- **Acknowledgement note.** In 16 of 18 answers that followed a steer, the model
  appended `[STEERING steer-<id>: …]` to its visible answer. An agent prompt instruction
  does not reliably stop it; the `messageId` from the steer response makes the note
  exactly recognisable if it has to be stripped.
- **Trust.** The steer reaches the model as a user message: no standing rule in the
  system instructions was needed, and no run treated it as tool output.

Cost: about 0.07–0.09 credit per tool scenario turn, 0.19–0.20 for the generation
scenario, 0.03 for short prompts.

## Consequences for the provider

- A pi steer that arrives with a tool result maps to `_session/steer` sent just before the
  tool result is returned over MCP: Kiro injects it right after that result.
- A queued steer is persisted with the session and outlives the process. A steer sent for
  a turn that then never consumes it (abort, lost tool result) reaches the *next* turn,
  so it must not also be replayed synthetically.
- Steering while the model only streams text duplicates the visible answer; avoid sending
  it outside a tool call.
- `_session/steer` is unadvertised, so a future build can drop it. A failed call needs
  the synthetic `<user_message_during_run>` path as a fallback.

What the provider does with that (`src/session.ts`, `src/v3/steer-echo.ts`):

- A resumption turn on V3 hands its steers to `deliverToolResults`, which queues each one
  with `_session/steer` *before* the tool result the model is waiting on is answered, and
  only when kiro answered `queued: true` with a `messageId`. Any error, timeout (10 s) or
  unqueued reply disables native steering for the session and puts that steer and every
  following one inside the tool result as the synthetic block — a steer is never sent both
  ways. A steer with no live `tools/call` (recovery prompt, image follow-up, no pending
  call) keeps the synthetic block, and v2 is untouched.
- The `messageId` of each queued steer is recorded and used to strip the model's
  `[STEERING <id>: …]` acknowledgement from `agent_message_chunk` output: only a note whose
  id matches is removed, together with the blank lines that introduced it. The filter holds
  back nothing until a steer has actually been queued, and everything it holds is released
  when the text block ends.
- The standing rule in `<system_instructions>` is still sent on V3: it is what makes the
  synthetic fallback trustworthy.

The free-RPC probe never sent `session/prompt`. A later real run (default pi model,
`claude-sonnet-4.6`, `PI_KIRO_ACP_AGENT_ENGINE=v3`) confirmed the turn itself: the agent was
selected, `v3 model set claude-sonnet-4.6` was logged, text streamed, the turn stopped, abort
worked, and both `session_info_update` kinds arrived — `turn_completion` (`elapsedTime`, and
`promptTurnSummaries` with 0.021 credits) *before* the stream ended, not after the
`stopReason`. No `session/request_permission` has been observed yet: every run so far had
`autopilot: on`, so the V3 option shape stays ACP-spec based. `memoryReflection`, `autopilot`
and `contentCollection` are left at their defaults.

Two properties the client has to enforce itself, because kiro reports nothing:

- **Clearing a level.** pi can turn reasoning off after a level was applied, and V3 has no
  "unset effort" value (neither does v2's `/effort`). The provider writes the model's
  `defaultEffortLevel` back and treats the level as unset again; a model that reports no
  default is logged and left alone.
- **Deciding what is live.** A restored session adopts `modelId` from the persisted record,
  which says nothing about the model the restored backend runs. When `configOptions` carry a
  `model` option its `currentValue` wins; the record is only a fallback for a response with
  no options at all. The cached options are dropped on a process restart and before every
  `session/new`/`session/load`, and every `config_option_update` is scoped to the current
  ACP session so a stale frame cannot replace them.

## Not verified

- Steer arriving while two `pi_host` tool calls run in parallel.
- Steer during a `session/request_permission` wait.
- Behaviour of models other than the default `auto` selection.
- Whether context compaction keeps an injected steer.
- The `session/request_permission` option shape on a live V3 session (`autopilot: off`).
- Whether `session/load` returns `configOptions` — handled defensively either way.
