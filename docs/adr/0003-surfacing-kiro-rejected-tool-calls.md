# 0003 — Showing the tool calls Kiro rejects itself

> **Pi copy** of this history. Identity and the sibling Oh My Pi tree:
> [README.md](../../README.md).

Status: accepted (2026-10)
Extends: [0001 — In-process HTTP MCP tool transport](0001-in-process-http-mcp-tool-transport.md)

## Context

Kiro's model sees only two tools of its own: `tool_load` and
`tool_call({tool_id, arguments})`. Every forwarded pi tool is invoked through
`tool_call`, and **Kiro validates that meta call before any `tools/call` exists**.

Two observed rejections (ACP `session/update`, `tool_call` / `tool_call_update`, status
`failed`):

- `arguments` arrived as a JSON string — `Invalid input for tool_call — arguments:
  expected object, received string`
- `tool_id` carried stray markup (`pi_host">\n</invoke>\n`) — `Unknown tool_id "…". Use an
  exact id from the deferred tools catalog …`

Neither ever reached `src/tool-bridge.ts`, so pi had nothing to show. The turn looked
successful, and the only trace of the failure was the model apologising in text afterwards:
the person saw "I made a mistake" with no call to attach it to.

## Decision

A failed update whose name normalizes to `tool_call` / `tool_load` (Kiro's titles are
`Tool Call` / `Tool Load`) and that carries no `mcpServer` — i.e. it never went through
`pi_host` — is queued as a **synthetic pending tool call** (`rejected: true`) with the id
namespace `${session.id}-<n>`. It travels the normal path: the stream's debounce batches it
with any real bridge call and ends the turn with `toolUse`.

Pi's agent loop answers a `toolCall` whose name is not a registered tool with an error tool
result and no side effects, so the transcript gets the failed (red) line for free, and the
loop continues into Kiro's still-running prompt on the next `stream()` call.

The synthetic call is deliberately unlike a real one on Kiro's side:

- Nothing in Kiro holds a `tool_use` for it, so `deliverToolResults` recognises the
  `rejected` flag and swallows pi's result instead of answering a `tools/call`
  (it would otherwise log `UNMATCHED tool result`).
- It is not persisted anywhere special: it shows up in history and in a full transcript
  replay as ordinary tool-call text (`<tool_call name="tool_call">…`, with `is_error`
  on the result), which is accurate — the model did issue a call that failed. Nothing is
  replayed to Kiro as a live call.
- Its name is Kiro's normalized meta tool name, deliberately not a pi tool name.

Arguments are exactly what Kiro received (`tool_id`, `arguments` as sent, string or
object) plus the error text, each clipped to 500 chars. The error text comes from the failed
update's `content` blocks, falling back to `rawOutput` / `error`; when Kiro sends none, a
generic message names the rejection and the input carries the rest.

## Consequences

- A malformed meta call is visible where it happened, and the model's apology is no longer
  the only record.
- One synthetic call per ACP call id: the name and input may arrive on the start update
  while only the failed update carries the status, so the stream remembers both.
- A rejected call is a pi turn, which costs one extra request: pi answers locally and
  re-attaches to the Kiro prompt, so no extra Kiro turn is spent.
- If Kiro's prompt already ended when the result comes back, the turn ends with `stop`
  instead of the "no active prompt" error that a matched-but-unreadable call would produce.
