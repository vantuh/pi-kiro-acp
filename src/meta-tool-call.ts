import type { JsonObject } from '@earendil-works/pi-ai';

/**
 * Kiro's own meta tools — the only tools its model sees directly. `tool_load`
 * fetches a deferred tool's schema, `tool_call` runs one through the pi_host
 * bridge. Kiro validates the meta call itself, so a malformed one (`arguments`
 * sent as a string, a `tool_id` with stray markup) is answered by Kiro and
 * never becomes a `tools/call`: the bridge, and pi, never hear about it.
 */
const META_TOOL_NAMES = new Set(['tool_call', 'tool_load']);

const MAX_FIELD_CHARS = 500;

function clip(value: string): string {
  return value.length > MAX_FIELD_CHARS
    ? `${value.slice(0, MAX_FIELD_CHARS)}…`
    : value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

/** Raw input a tool update reports, in either of the shapes Kiro sends it. */
export function toolUpdateInput(
  update: Record<string, any>,
): Record<string, any> | undefined {
  return asRecord(update.rawInput) ?? asRecord(update.toolCall?.rawInput);
}

/** The meta tool name a failed update reports, or null when the update is not
 * a Kiro-side rejection. A call that reached the bridge is pi's own (Kiro is
 * reporting the result of a tool pi ran), and no other update is a rejection.
 * Kiro titles these calls `Tool Call` / `Tool Load`; the returned name is the
 * normalized `tool_call` / `tool_load` spelling. */
export function rejectedMetaToolName(
  update: Record<string, any>,
  identity: { toolName?: string; mcpServer?: string },
): string | null {
  if (update.status !== 'failed' || identity.mcpServer) return null;
  const raw = identity.toolName ?? update.title;
  if (typeof raw !== 'string') return null;
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return META_TOOL_NAMES.has(name) ? name : null;
}

/** What Kiro reported about its own rejection: ACP carries the message as
 * `content` blocks; other payloads keep it in `rawOutput` or a bare `error`.
 * Returns null when the provider sent no text at all. */
function errorTextOf(update: Record<string, any>): string | null {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) texts.push(value.trim());
  };
  for (const block of Array.isArray(update.content) ? update.content : [])
    push(block?.type === 'content' ? block?.content?.text : block?.text);
  const rawOutput = update.rawOutput;
  push(typeof rawOutput === 'string' ? rawOutput : rawOutput?.text);
  for (const candidate of [update.error, update.errorMessage])
    push(typeof candidate === 'string' ? candidate : candidate?.message);
  return texts.length > 0 ? clip(texts.join('\n')) : null;
}

const NO_ERROR_TEXT =
  'Kiro rejected this tool call before it reached pi (no message from Kiro).';

/** The arguments pi records for a rejected meta call: the meta tool's own input
 * (`tool_id`, `arguments`) plus Kiro's error, bounded so a huge argument blob
 * cannot flood the transcript. */
export function rejectedMetaCallArgs(
  update: Record<string, any>,
  input: Record<string, any> | undefined,
): JsonObject {
  const args: Record<string, string> = {};
  const toolId = input?.tool_id ?? input?.toolId;
  if (typeof toolId === 'string' && toolId) args.tool_id = clip(toolId);
  const callArguments = input?.arguments;
  if (callArguments !== undefined)
    args.arguments = clip(
      typeof callArguments === 'string'
        ? callArguments
        : safeJson(callArguments),
    );
  args.error = errorTextOf(update) ?? NO_ERROR_TEXT;
  return args;
}
