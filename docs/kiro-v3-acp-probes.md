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

## Not verified

- Steer arriving while two `pi_host` tool calls run in parallel.
- Steer during a `session/request_permission` wait.
- Behaviour of models other than the default `auto` selection.
- Whether context compaction keeps an injected steer.
