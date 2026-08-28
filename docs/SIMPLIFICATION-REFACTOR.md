# kiro-acp simplification refactor (2026-08-28)

Behavior-preserving cleanup pass over `kiro-acp/`, done in two waves.
Goal: remove duplication and dead indirection so future work starts from a
smaller surface. Verification: all 14 `test/*.test.ts` files pass under jiti.

## Wave 1 — commit `0359874` "extract common patterns, consolidate helpers"

- **`stableValue` / `stableJson` → `helpers.ts`** — previously duplicated across
  3 modules; single home now.
- **`terminateProcessTree(proc, timeoutMs)`** in `process-utils.ts` — graceful
  shutdown: close stdin → wait for exit (up to timeout) → SIGTERM root and all
  known descendants. Replaced ad-hoc kill sequences.
- **`deliverToolResults(results, { textOnly })`** — two near-identical variants
  merged behind one option. `textOnly` strips content blocks (image FUP path).
- **`settlePendingState(toolResultMsg, rpcRejectMsg)`** (session.ts) — shared
  cleanup for `stop()` and process-exit: fails every pending RPC/tool call and
  drops session state in one place.
- **`removeAgentFiles()`** — file cleanup extracted.
- **`toKiroEffort`** — replaced if/else chain with `KIRO_THINKING_LEVEL_MAP`
  lookup; unknown values coalesce to `null` (unset), same as before.
- **`tool-catalog.ts`** — `canonical` replaced with shared `stableValue`.

## Wave 2 — uncommitted at time of writing

- **`stream.ts` — `createBlockWriter(kind, endOther)` factory** — the biggest
  one. Four sets of near-duplicate block-streaming closures (`pushTextDelta`,
  `endTextBlock`, `endThinkingBlock`, inline thinking handling with their
  `textStarted/textIdx/textMessageId` mirrors) collapsed into one factory
  instantiated twice (`textWriter`, `thinkingWriter`). Same semantics: first
  delta opens the block, changed messageId closes it, a delta of one kind
  closes an open block of the other kind.
- **`stream.ts` outcome tail** — `estimateUsage` + `appendKiroMetadataDiagnostic`
  were called identically in all three outcome branches (toolUse / error /
  stop); hoisted to a single call before the branch.
- **`buildPromptParts` moved session.ts → helpers.ts** — it only touches
  `Context`, not session state; `stream.ts` no longer imports it from
  `session.ts` (breaks a layering wart: stream importing from session).
- **`helpers.ts lastUserMessage`** — reimplemented via `findLastUserIndex` +
  `messageText(msg, Infinity)`, deleting a copy of the content-unwrapping logic.
- **`session.ts` — `teardownBridgeAndFiles()`** — close readline/stdio, stop
  bridge, delete agent files; shared by `stop()` and the process-exit handler
  (previously two divergent copies).
- **`tool-bridge.ts` — pending-call simplification** — dropped the
  `PendingCall.reject` field and the wrapping `new Promise` executor; the
  `tools/call` handler now awaits `onToolCall` in a plain try/catch and always
  responds once. Client disconnects abort via AbortController only; the
  adapter-close path no longer double-rejects.
- **Re-export shims deleted** — `models.ts` and `models/index.ts` were pure
  re-export shims over `models/fallback.ts` / `models/discovery.ts`; callers
  (`index.ts`, `kiro-subagents-bridge/model-map.ts`) import directly now.
- **`types.ts` dead types removed** — `StreamRequest` and
  `AcpSessionStateFields` (a mirror of `AcpSession` fields with zero
  consumers) deleted along with their now-unused imports.

## Review fixes applied on top (post-review)

- `process-utils.ts` — `terminateProcessTree` uses the file's 2-space indent
  (was written with tabs); added optional `knownDescendants` param so `stop()`
  passes its already-logged pgrep snapshot instead of walking the tree twice.
- `session.ts toKiroEffort` — comment documenting the intentional `as`-cast
  fallback: unknown/future `reasoning` values coalesce to `null`.
- `session.ts deliverToolResults` — log lines use a structured
  `textOnly: true/false` field instead of ternary-interpolated message text.

## Known behavior deltas (reviewed, accepted)

- **`stop()` rejects in-flight RPCs with `"Stopped"` synchronously, before the
  5s kill wait** — previously rejection happened after the wait, so a late
  response could resolve the RPC and the exit handler could win with
  `"kiro-cli exited"`. No consumer depends on the old ordering; the new one is
  arguably more correct (early, explicit rejection with the right message).

## Leftovers / follow-ups

- `test/tool-bridge.test.ts` passes all assertions but the process doesn't
  exit (a handle keeps the event loop alive). Pre-existing on HEAD before this
  refactor — not introduced here, but worth a `--forceExit` or unref fix
  someday.
- `scripts/llama-run/llama-swap.yaml` references
  `Qwen3.8-27B-UD-IQ3_XeS.gguf` which does not exist on disk (only `IQ3_XXS`
  and `IQ3_S` do). Not a quant name; owner said skip for now.
