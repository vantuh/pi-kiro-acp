# kiro-acp (Pi)

This repository is the **Pi** copy of the Kiro ACP provider, extracted from the
dotfiles repository.

## Install

```sh
pi install ~/projects/personal/pi-kiro-acp
```

It is **not** the Oh My Pi copy. The two trees started as the same extension
and then diverged. A change here does not appear in omp.

| | Pi (this tree) | Oh My Pi |
|---|---|---|
| Repo | this repository | `dotfiles: home/dot_omp/private_agent/extensions/kiro-acp` |
| Config | `~/.pi/agent/kiro-acp.json` | `~/.omp/agent/kiro-acp.json` |
| Host binary | `pi` | `omp` |

## Docs

- [ADR 0001](docs/adr/0001-in-process-http-mcp-tool-transport.md)
- [ADR 0002](docs/adr/0002-surviving-kiro-mcp-tool-call-deadline.md)
- [Debug logging](docs/DEBUG-LOGGING.md)
- [E2E live probe](test/e2e/README.md)

## Tests

Run `./test/run-all.sh`. For a managed Pi installation, set `PI_NODE_MODULES`
to its `node_modules` directory containing `jiti` and `@earendil-works/pi-ai`.
The default lookup assumes a global npm installation. Live E2E tests require
an authenticated Kiro CLI; see the [live probe guide](test/e2e/README.md).

## Runtime paths

| What | Path |
|---|---|
| Debug log | `$TMPDIR/kiro-acp-debug.log` |
| Persisted ACP sessions | `~/.local/share/pi-kiro-acp/` |
| Agent scratch dir | `$TMPDIR/kiro-acp/agent-root-<id>` |

The omp copy namespaces its log, persistence dir, and scratch dir so the two
hosts do not share files. MCP server name `pi_host` is per-process in both.
