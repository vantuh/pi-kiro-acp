import { createHash } from "node:crypto";

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

export function isKiroToolName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_KIRO_NAME_LENGTH && KIRO_NAME.test(name);
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
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
			parameters: canonical(tool.parameters),
		}));
	return digest(JSON.stringify(stable));
}

function fallbackDescription(name: string): string {
	return `Host Pi extension tool: ${name}`;
}

function schemaOrFallback(parameters: unknown, name: string, diagnostics: string[]): Record<string, unknown> {
	if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
		return parameters as Record<string, unknown>;
	}
	diagnostics.push(`Tool ${name} has no object parameter schema; using an empty object schema.`);
	return { type: "object", properties: {} };
}

function aliasFor(piName: string, used: Set<string>): string | undefined {
	const hex = digest(piName);
	for (let length = 16; length <= hex.length; length += 4) {
		const candidate = `${ALIAS_PREFIX}${hex.slice(0, length)}`;
		if (candidate.length <= MAX_KIRO_NAME_LENGTH && !used.has(candidate)) return candidate;
	}
	return undefined;
}

/** Build the active, extension-only tool catalog exposed to Kiro. */
export function buildForwardedToolCatalog(
	allTools: readonly PiToolMetadata[],
	activeToolNames: readonly string[],
): ForwardedToolCatalog {
	const active = new Set(activeToolNames);
	const diagnostics: string[] = [];
	const candidates = new Map<string, ForwardedTool>();

	for (const tool of allTools) {
		if (!active.has(tool.name)) continue;
		if (tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk") continue;
		if (candidates.has(tool.name)) {
			diagnostics.push(`Skipping duplicate active tool name ${tool.name}.`);
			continue;
		}
		const description = typeof tool.description === "string" ? tool.description : "";
		if (!description.trim()) diagnostics.push(`Tool ${tool.name} has no description; using a safe fallback.`);
		candidates.set(tool.name, {
			piName: tool.name,
			kiroName: tool.name,
			description: description.trim() ? description : fallbackDescription(tool.name),
			parameters: schemaOrFallback(tool.parameters, tool.name, diagnostics),
		});
	}

	const tools = [...candidates.values()].sort((a, b) => a.piName.localeCompare(b.piName));
	const used = new Set<string>();
	// Preserve every valid original name. Invalid names alias around them.
	for (const tool of tools) if (isKiroToolName(tool.piName)) used.add(tool.piName);
	for (const tool of tools) {
		if (isKiroToolName(tool.piName)) continue;
		const alias = aliasFor(tool.piName, used);
		if (!alias) {
			diagnostics.push(`Skipping ${tool.piName}: could not allocate a unique Kiro-safe alias.`);
			continue;
		}
		tool.kiroName = alias;
		used.add(alias);
	}

	const exposed = tools.filter((tool) => used.has(tool.kiroName));
	const piNameByKiroName = new Map(exposed.map((tool) => [tool.kiroName, tool.piName]));
	return { tools: exposed, piNameByKiroName, fingerprint: fingerprint(exposed), diagnostics };
}
