# kiro-acp (Pi)

This directory is the **Pi** copy of the Kiro ACP provider. Edit it when the
host is `pi`. Chezmoi maps it to `~/.pi/agent/extensions/kiro-acp`.

It is **not** the Oh My Pi copy. The two trees started as the same extension
and then diverged. A change here does not appear in omp.

| | Pi (this tree) | Oh My Pi |
|---|---|---|
| Repo | [`home/dot_pi/agent/extensions/kiro-acp`](.) | [`home/dot_omp/private_agent/extensions/kiro-acp`](../../../../dot_omp/private_agent/extensions/kiro-acp) |
| Loaded from | `~/.pi/agent/extensions/kiro-acp` | `~/.omp/agent/extensions/kiro-acp` |
| Config | `~/.pi/agent/kiro-acp.json` | `~/.omp/agent/kiro-acp.json` |
| Host binary | `pi` | `omp` |

## Docs

- [ADR 0001](docs/adr/0001-in-process-http-mcp-tool-transport.md)
- [ADR 0002](docs/adr/0002-surviving-kiro-mcp-tool-call-deadline.md)
- [Debug logging](docs/DEBUG-LOGGING.md)
- [E2E live probe](test/e2e/README.md)

## Runtime paths (this copy)

| What | Path |
|---|---|
| Debug log | `$TMPDIR/kiro-acp-debug.log` |
| Persisted ACP sessions | `~/.local/share/pi-kiro-acp/` |
| Agent scratch dir | `$TMPDIR/kiro-acp/agent-root-<id>` |

The omp copy namespaces its log, persistence dir, and scratch dir so the two
hosts do not share files. MCP server name `pi_host` is per-process in both.
