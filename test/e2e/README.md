# E2E live probe (`live.mjs`)

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
`test/run-all.sh` (it only matches `test/*.test.ts`), and the script refuses
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
| **T4-alt** | `session/load` across processes with the config still present does **not** leak builtins | persistence gate is sufficient here |
| **T4** | **The production leak mechanism**: session created under an agent whose config file is deleted before restore (the extension removes agent files on `stop()`) → fallback → all builtins leak into the model's tool list | `KIRO BUILTINS LEAKED` detection + config-fingerprint persistence gate + quarantine |
| **T5a–c** | The model actually calls a forwarded tool: `tools/call` reaches the MCP host, the update is tagged `pi_host`, and **zero** `session/request_permission` RPCs fire (`--trust-tools=@pi_host` costs nothing on the happy path) | bridge round-trip + execution gate |

T4 is the regression canary for the leak the extension defends against: if it
ever stops reproducing (e.g. a kiro-cli update removes the fallback), the
detection layers are guarding against a non-issue; if T1a starts failing
(builtins appear in fresh sessions), the forwarded-transport premise itself
broke and aliasing/permission-gate become load-bearing again.

## Exit code

`0` when every non-skipped check passes, `1` otherwise (T5 checks are skipped,
not failed, when `KIRO_E2E_LIVE=1`).
