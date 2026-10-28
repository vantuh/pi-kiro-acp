# E2E live probe (`live.mjs`)

> **Pi copy.** See [../../README.md](../../README.md). Run this probe from
> this tree, not from `home/dot_omp/private_agent/extensions/kiro-acp`.

Verifies the kiro-acp transport assumptions against the **real kiro-cli
binary** — not mocks. The unit tests under `test/*.test.ts` cover the
extension's logic in isolation; this probe proves that kiro-cli itself still
behaves the way the extension requires (ADR 0001, amendments 4–5).

## What it does

Spawns `kiro-cli acp` the same way `session.ts` does, performs the JSON-RPC
handshake, registers an in-process HTTP MCP server named `pi_host` (the same
transport as `tool-bridge.ts`), and inspects:

- **`_kiro.dev/commands/available`** — the model's actual tool list
  (`tools[].source` is `built-in` or `mcp:<server>`). This is the ground
  truth for "what tools the model knows about".
- **`_kiro.dev/agent/not_found`** — the kiro_default fallback path.
- **`-v` stderr/stdout logs** — `NameCollision(BuiltIn(…))` filtering.
- A **real model-driven `tools/call`** round-trip (T5 only).

## Running

```sh
# free checks (no model call, no credit spend)
KIRO_E2E_LIVE=1 ./test/e2e/live.mjs

# full run, includes the T5 model tools/call (spends a tiny amount of credits)
KIRO_E2E_LIVE=full ./test/e2e/live.mjs
```

Requirements: `kiro-cli` on PATH and logged in. The probe is **not** part of
`npm test` (it only matches `test/*.test.ts`), and the script refuses
to run without `KIRO_E2E_LIVE` set, so it can never fire accidentally.

Each run creates an isolated throwaway agent dir under `$TMPDIR` (removed on
exit) and an ephemeral-port MCP server. The probe sessions remain in
kiro-cli's local session store (`kiro-cli chat --sessions`) — harmless.

## Checks

| # | Verifies | Extension layer it guards |
|---|---|---|
| **T1a** | A fresh session with `tools: ["@pi_host"]` registers **zero** Kiro builtins | forwarded transport (ADR 0001 am. 4/5) |
| **T1b** | The forwarded pi_host tools (`read`, `pi_probe_tool`) are the only tools the model sees | tool catalog |
| **T1c** | Same-named MCP tools are **not** dropped (`NameCollision`) in a fresh session | `pi_*` aliasing stays dormant |
| **T2a–c** | A missing agent config falls back to `kiro_default`, which registers all builtins | `KIRO AGENT NOT FOUND` loud log |
| **T3** | Under the fallback, the same-named MCP tool is dropped with `NameCollision(BuiltIn(FsRead))` | why aliasing exists |
| **T3b** | The aliased `pi_read` **survives** the fallback collision and stays model-visible while plain `read` is dropped | the aliasing defense working under leak |
| **T4-alt** | `session/load` across processes with the config still present does **not** leak builtins | persistence gate is sufficient here |
| **T4** | **The production leak mechanism**: session created under an agent whose config file is deleted before restore (the extension removes agent files on `stop()`) → fallback → all builtins leak into the model's tool list | `KIRO BUILTINS LEAKED` detection + config-fingerprint persistence gate + quarantine |
| **T5a–c** | The model actually calls a forwarded tool: `tools/call` reaches the MCP host, the update is tagged `pi_host`, and **zero** `session/request_permission` RPCs fire (`--trust-tools=@pi_host` costs nothing on the happy path) | bridge round-trip + execution gate |

T4 is the regression canary for the leak the extension defends against: if it
ever stops reproducing (e.g. a kiro-cli update removes the fallback), the
detection layers are guarding against a non-issue; if T1a starts failing
(builtins appear in fresh sessions), the forwarded-transport premise itself
broke and aliasing/permission-gate become load-bearing again.

## Exit code

`0` when every executed check passes, `1` otherwise. Checks skipped due to
`KIRO_E2E_LIVE=1` (T5) are reported separately and excluded from the pass
count.

## Pocket probe (`pocket.mjs`)

The Pocket probe loads `src/pocket.ts` into a real Pi Pocket through Pocket's
own `test/helpers.ts`, then turns the module on and off through the public host.
It uses an isolated temporary Pocket data folder and a thin generated wrapper in
that folder's `extensions/`. Only the Pocket data is isolated: `kiro-cli` uses
its normal sign-in and session store, so probe sessions appear in its session
history.

```sh
# free: registration, local catalog, discovery, reload ownership, disable
PI_POCKET_SOURCE=/path/to/pi-pocket KIRO_E2E_LIVE=1 node test/e2e/pocket.mjs

# full: also two concurrent read turns, one warm follow-up, and one turn after a reload
PI_POCKET_SOURCE=/path/to/pi-pocket KIRO_E2E_LIVE=full node test/e2e/pocket.mjs
```

Each read turn runs with the session cwd and a relative `probe.txt`, and gives an
explicit fresh instruction: the file may have changed, read it now, do not reuse
earlier contents. The probe submits through `app.commands.submit`, waits with a
bound, and requires status `done`. It then checks only the messages after the
latest user input, so an answer from memory cannot match an earlier turn's read
result. That turn must have a non-error `read` tool result with the file text,
and a final answer with it too; a mismatch prints the actual result and answer,
trimmed. One warm follow-up runs on the same provider and conversation before
the second reload. It must read the changed file again and also repeat, from
conversation history, the file text read earlier; its prompt contains
neither file text. The full run makes four user turns, not four model requests:
each read turn sends at least one more request after the tool result. Pocket can
also make background title requests for new conversations; the probe leaves those
enabled. The free run spends no model credits.

Both runs watch the `kiro-cli acp` processes that the adapter starts, at the Node
child-process boundary, and keep the real `ChildProcess` objects. The probe
observes the root ACP children only: descendants that `kiro-cli` starts are not
observed. A child counts as exited when Node sets its `exitCode` or
`signalCode`. A wait that times out reports `pid`, `args`, `exitCode`,
`signalCode`, and `killed` for each child that is still live. The bound is 20
seconds. The full run also checks that the children of the provider before the
second reload exit after that reload.

## Steer probe (`steer.mjs`)

Drives the **provider**, not raw ACP: `streamKiroAcp` plus a real
`SessionManager`, with one pi tool forwarded over `pi_host`. Turn 1 asks the
model to call `slow` and ends on `toolUse`; the probe "runs" that tool for 20
seconds, then sends turn 2 with the tool result followed by a user message that
asks for a random code word. A mid-run steer reaches the provider in exactly
that shape (tool result, then user message), so the code word can only appear in
the final visible answer if Kiro actually took the steer.

```sh
# v2, then v3, one child process each (two model turns per engine, spends credits)
KIRO_E2E_LIVE=full node test/e2e/steer.mjs

# one engine
KIRO_E2E_LIVE=full node test/e2e/steer.mjs --engine v3

# v3 with the native steer forced off: the synthetic block has to carry it
KIRO_E2E_LIVE=full node test/e2e/steer.mjs --engine v3 --fallback
```

Each engine runs in a child process because the provider reads the engine when
its module loads. `PI_KIRO_ACP_AGENT_ENGINE` selects it; `STEER_SLOW_MS` changes
the simulated tool run (default `20000`). The run uses a throwaway cwd and a
throwaway `XDG_DATA_HOME`, so provider session persistence stays out of your data
dir. `HOME` is untouched, so `kiro-cli` keeps its login and `~/.kiro` is never
written.

Reported per engine: whether turn 1 ended in the tool call, what the provider
sent for the steer (on v3 the accepted `_session/steer` `messageId`, or the fact
that nothing was queued and the steer went into the tool result block; on v2 the
block plus the standing `<user_message_during_run>` rule), the provider's own
debug log lines for the session, whether a `[STEERING …]` note survived the
filter, the final answer, credits, and PASS/FAIL. The log is only written when
`logger.debug` is on ([Debug logging](../../docs/DEBUG-LOGGING.md)); when it is
off the probe says so and reports the live session state instead. It fails when
the code word is missing or when the answer treats the steer as data, and exits
`1` on any failure.

`--fallback` flips the session's one-shot native-steer switch before turn 2. It
needs no source change but does reach into provider state: a run that still
queues a native steer fails loudly, which means the flag moved.

Cost: two model turns per engine (the tool call, then the answer); `--fallback`
is the same.

## Raw ACP V3 steer probe (`v3-native-steer.mjs`)

Bypasses the provider and speaks `_session/steer` to `kiro-cli acp
--agent-engine=v3` directly, to measure what the engine itself does: a steer
while a pi_host tool runs, while text streams, on an idle session, and across
`session/load`. Scenarios `tool`, `generation`, `idle`, `load`, `idle-load`
(default all); `STEER_RUNS` repeats the tool scenario.

```sh
KIRO_E2E_LIVE=full node test/e2e/v3-native-steer.mjs tool
```

The default run is seven steered turns (three tool runs plus four scenarios).
Findings are written up in
[../../docs/kiro-v3-acp-probes.md](../../docs/kiro-v3-acp-probes.md).
