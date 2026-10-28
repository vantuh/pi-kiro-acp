function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

/** `@<server>/<tool>`, the title V3 gives an MCP tool call. */
const MCP_TITLE_RE = /^@([^/\s]+)\/(\S+)$/;

/** Kiro tags tool identity in several legacy shapes. One parser for all of
 * them, so permission gating and logging agree on the same answer:
 * - `toolCall`/`tool_call` params with `_meta.kiro.{toolName,mcpServerName}`
 * - top-level `_meta.kiro.{toolName,mcpServerName}` (stream tool_call updates)
 * - bare `_meta.{toolName,mcpServerName}` on the toolCall
 * - plain `toolCall.{toolName,name}` with no meta at all
 * - V3: `_meta.kiro.mcpTool.identity.{serverName,toolName}`,
 *   `_meta.kiro.serverName`, and a `title` of the form `@<server>/<tool>`
 *   (V3 tags an MCP call only that way and its meta tools — `Tool Load`,
 *   `tool_call` — carry neither, so they can never look like pi_host calls)
 * The first non-empty string wins, in the order above; the V3 shapes only fill
 * in what the legacy ones leave empty. */
export function kiroToolIdentity(value: unknown): {
  toolName: string | undefined;
  mcpServer: string | undefined;
} {
  const v = asRecord(value);
  const toolCall = asRecord(v?.toolCall) ?? asRecord(v?.tool_call);
  const meta =
    asRecord(toolCall?._meta?.kiro) ??
    asRecord(v?._meta?.kiro) ??
    asRecord(toolCall?._meta);
  const mcpToolIdentity = asRecord(asRecord(meta?.mcpTool)?.identity);
  const title =
    typeof v?.title === 'string'
      ? v.title
      : typeof toolCall?.title === 'string'
        ? toolCall.title
        : undefined;
  const titleMatch = title ? MCP_TITLE_RE.exec(title) : null;
  const firstString = (...candidates: unknown[]): string | undefined =>
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.length > 0,
    );
  return {
    toolName: firstString(
      meta?.toolName,
      toolCall?.toolName,
      toolCall?.name,
      mcpToolIdentity?.toolName,
      titleMatch?.[2],
    ),
    mcpServer: firstString(
      meta?.mcpServerName,
      asRecord(toolCall?._meta)?.mcpServerName,
      v?._meta?.mcpServerName,
      mcpToolIdentity?.serverName,
      meta?.serverName,
      titleMatch?.[1],
    ),
  };
}

export function mcpServerFromPermissionParams(
  params: unknown,
): string | undefined {
  return kiroToolIdentity(params).mcpServer;
}

export function kiroToolNameFromPermissionParams(
  params: unknown,
): string | undefined {
  return kiroToolIdentity(params).toolName;
}

/** True when this permission is for a pi_host / forwarded Pi tool, not a
 * Kiro builtin. Fail-safe: only an exact `pi_host` tag or an exact match in
 * the current forwarded catalog is allowed. Kiro 2.21 always tags MCP calls
 * with `_meta.kiro.mcpServerName`; an untagged call is a Kiro builtin (the
 * catalog only contains forwarded names — same-named specs were aliased or
 * dropped), so the untagged fallback is safe even against future builtins
 * that are not in the hardcoded registry. */
export function isPiHostPermission(
  params: unknown,
  forwardedKiroNames: Iterable<string>,
): boolean {
  if (mcpServerFromPermissionParams(params) === 'pi_host') return true;
  const name = kiroToolNameFromPermissionParams(params);
  if (!name) return false;
  return new Set(forwardedKiroNames).has(name);
}

/** V3 offers `{optionId, name, kind}` options. Only the one-shot kind is ever
 * selected: `allow_always` would let the tool run for the rest of the session
 * without pi seeing another request, so a missing one-shot option cancels. */
export function pickV3PermissionOptionId(
  options: Array<{ optionId?: string; kind?: string }>,
  allow: boolean,
): string | null {
  const wanted = allow ? 'allow_once' : 'reject_once';
  const match = options.find(
    (option) => option.kind === wanted || option.optionId === wanted,
  );
  return typeof match?.optionId === 'string' && match.optionId
    ? match.optionId
    : null;
}

export function pickPermissionOptionId(
  options: Array<{ id?: string }>,
  allow: boolean,
): string | null {
  const ids = options
    .map((option) => option.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (allow) {
    // Only explicit allow options — falling back to options[0] could pick a
    // reject option while logging allow: true; when neither is offered the
    // caller cancels (fail-safe).
    return (
      ids.find((id) => id === 'allow_always') ||
      ids.find((id) => id === 'allow_once') ||
      null
    );
  }
  return (
    ids.find((id) => id === 'reject_always') ||
    ids.find((id) => id === 'reject_once') ||
    null
  );
}
