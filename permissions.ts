function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function toolCallFromPermissionParams(
  params: unknown,
): Record<string, any> | undefined {
  const p = asRecord(params);
  return asRecord(p?.toolCall) ?? asRecord(p?.tool_call);
}

function kiroMeta(params: unknown): Record<string, any> {
  const toolCall = toolCallFromPermissionParams(params);
  const p = asRecord(params);
  return (
    asRecord(toolCall?._meta?.kiro) ??
    asRecord(p?._meta?.kiro) ??
    asRecord(toolCall?._meta) ??
    {}
  );
}

export function mcpServerFromPermissionParams(
  params: unknown,
): string | undefined {
  const meta = kiroMeta(params);
  const toolCall = toolCallFromPermissionParams(params);
  const candidates = [
    meta.mcpServerName,
    asRecord(toolCall?._meta)?.mcpServerName,
    asRecord(params)?._meta?.mcpServerName,
  ];
  return candidates.find((value) => typeof value === "string" && value) as
    | string
    | undefined;
}

export function kiroToolNameFromPermissionParams(
  params: unknown,
): string | undefined {
  const meta = kiroMeta(params);
  const toolCall = toolCallFromPermissionParams(params);
  const candidates = [
    meta.toolName,
    toolCall?.toolName,
    toolCall?.name,
  ];
  return candidates.find((value) => typeof value === "string" && value) as
    | string
    | undefined;
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
  if (mcpServerFromPermissionParams(params) === "pi_host") return true;
  const name = kiroToolNameFromPermissionParams(params);
  if (!name) return false;
  return new Set(forwardedKiroNames).has(name);
}

export function pickPermissionOptionId(
  options: Array<{ id?: string }>,
  allow: boolean,
): string | null {
  const ids = options
    .map((option) => option.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (allow) {
    // Only explicit allow options — falling back to options[0] could pick a
    // reject option while logging allow: true; when neither is offered the
    // caller cancels (fail-safe).
    return (
      ids.find((id) => id === "allow_always") ||
      ids.find((id) => id === "allow_once") ||
      null
    );
  }
  return (
    ids.find((id) => id === "reject_always") ||
    ids.find((id) => id === "reject_once") ||
    null
  );
}
