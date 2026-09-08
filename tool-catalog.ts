import { createHash } from "node:crypto";

import { stableValue } from "./helpers.ts";

export interface PiToolMetadata {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: { source?: string };
}

export interface ForwardedTool {
  piName: string;
  kiroName: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ForwardedToolCatalog {
  tools: ForwardedTool[];
  /** Kiro-facing name → original Pi name. */
  piNameByKiroName: Map<string, string>;
  fingerprint: string;
  diagnostics: string[];
}

const KIRO_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_KIRO_NAME_LENGTH = 64;
const ALIAS_PREFIX = "pi_";

/** Kiro still registers these builtins even when the agent config is only
 * `@pi_host`. An MCP tool with the same name is dropped as
 * `NameCollision(BuiltIn(...))` and Kiro runs the native tool instead —
 * invisible in pi (no `pi_host` `tools/call`). Alias them so the forwarded
 * spec survives. Observed: `subagent` → AgentCrew, `read` → FsRead,
 * `write` → FsWrite, `web_search` → WebSearch. `delegate` is the crew-shaped
 * name in Kiro agent config examples. */
const KIRO_BUILTIN_NAMES = new Set([
  "aws",
  "delegate",
  "glob",
  "grep",
  "introspect",
  "knowledge",
  "read",
  "report",
  "shell",
  "subagent",
  "thinking",
  "todo",
  "web_fetch",
  "web_search",
  "write",
]);

export function isKiroToolName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_KIRO_NAME_LENGTH &&
    KIRO_NAME.test(name)
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(tools: ForwardedTool[]): string {
  const stable = tools
    .slice()
    .sort((a, b) => a.piName.localeCompare(b.piName))
    .map((tool) => ({
      piName: tool.piName,
      kiroName: tool.kiroName,
      description: tool.description,
      parameters: stableValue(tool.parameters),
    }));
  return digest(JSON.stringify(stable));
}

function fallbackDescription(name: string): string {
  return `Host Pi extension tool: ${name}`;
}

function schemaOrFallback(
  parameters: unknown,
  name: string,
  diagnostics: string[],
): Record<string, unknown> {
  if (
    parameters &&
    typeof parameters === "object" &&
    !Array.isArray(parameters)
  ) {
    return parameters as Record<string, unknown>;
  }
  diagnostics.push(
    `Tool ${name} has no object parameter schema; using an empty object schema.`,
  );
  return { type: "object", properties: {} };
}

function aliasFor(piName: string, used: Set<string>): string | undefined {
  if (KIRO_BUILTIN_NAMES.has(piName)) {
    const preferred = `${ALIAS_PREFIX}${piName}`;
    if (isKiroToolName(preferred) && !used.has(preferred)) return preferred;
  }
  const hex = digest(piName);
  for (let length = 16; length <= hex.length; length += 4) {
    const candidate = `${ALIAS_PREFIX}${hex.slice(0, length)}`;
    if (candidate.length <= MAX_KIRO_NAME_LENGTH && !used.has(candidate))
      return candidate;
  }
  return undefined;
}

function needsKiroAlias(piName: string): boolean {
  return !isKiroToolName(piName) || KIRO_BUILTIN_NAMES.has(piName);
}

/** Build the active tool catalog exposed to Kiro. Builtin (read/bash/…)
 * and extension tools are forwarded over pi_host and executed by pi (forwarded
 * transport, ADR 0001 amendment 2026-09-04), so Kiro must see pi's active set;
 * only host-SDK custom tools stay out of the catalog. */
export function buildForwardedToolCatalog(
  allTools: readonly PiToolMetadata[],
  activeToolNames: readonly string[],
): ForwardedToolCatalog {
  const active = new Set(activeToolNames);
  const diagnostics: string[] = [];
  const candidates = new Map<string, ForwardedTool>();

  for (const tool of allTools) {
    if (!active.has(tool.name)) continue;
    if (tool.sourceInfo?.source === "sdk") continue;
    if (candidates.has(tool.name)) {
      diagnostics.push(`Skipping duplicate active tool name ${tool.name}.`);
      continue;
    }
    const description =
      typeof tool.description === "string" ? tool.description : "";
    if (!description.trim())
      diagnostics.push(
        `Tool ${tool.name} has no description; using a safe fallback.`,
      );
    candidates.set(tool.name, {
      piName: tool.name,
      kiroName: tool.name,
      description: description.trim()
        ? description
        : fallbackDescription(tool.name),
      parameters: schemaOrFallback(tool.parameters, tool.name, diagnostics),
    });
  }

  const tools = [...candidates.values()].sort((a, b) =>
    a.piName.localeCompare(b.piName),
  );
  const used = new Set<string>();
  // Keep original names that are Kiro-safe and do not collide with builtins.
  for (const tool of tools)
    if (!needsKiroAlias(tool.piName)) used.add(tool.piName);
  for (const tool of tools) {
    if (!needsKiroAlias(tool.piName)) continue;
    const alias = aliasFor(tool.piName, used);
    if (!alias) {
      diagnostics.push(
        `Skipping ${tool.piName}: could not allocate a unique Kiro-safe alias.`,
      );
      continue;
    }
    if (KIRO_BUILTIN_NAMES.has(tool.piName)) {
      diagnostics.push(
        `Aliasing ${tool.piName} → ${alias} to avoid a Kiro builtin name collision.`,
      );
    }
    tool.kiroName = alias;
    used.add(alias);
  }

  const exposed = tools.filter((tool) => used.has(tool.kiroName));
  const piNameByKiroName = new Map(
    exposed.map((tool) => [tool.kiroName, tool.piName]),
  );
  return {
    tools: exposed,
    piNameByKiroName,
    fingerprint: fingerprint(exposed),
    diagnostics,
  };
}
