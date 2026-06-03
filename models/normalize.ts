import { ZERO_COST, KIRO_MODELS, type KiroModelConfig } from "./fallback.ts";

type AvailableKiroModel = {
  modelId?: string;
  id?: string;
  name?: string;
  description?: string;
};

const FALLBACK_BY_ID = new Map(KIRO_MODELS.map((model) => [model.id, model]));

export function normalizeDiscoveredModel(model: AvailableKiroModel): KiroModelConfig | null {
  const id = typeof model.modelId === "string" ? model.modelId : typeof model.id === "string" ? model.id : undefined;
  if (!id) return null;

  const fallback = FALLBACK_BY_ID.get(id);
  if (fallback) {
    return { ...fallback, name: formatModelName(model.name || fallback.name) };
  }

  return {
    id,
    name: formatModelName(model.name || id),
    reasoning: false,
    input: supportsImages(id) ? ["text", "image"] as any : ["text"] as any,
    cost: ZERO_COST,
    contextWindow: inferContextWindow(id),
    maxTokens: inferMaxTokens(id),
  };
}

export function dedupeModels(models: KiroModelConfig[]): KiroModelConfig[] {
  const seen = new Set<string>();
  const result: KiroModelConfig[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result.length > 0 ? result : KIRO_MODELS;
}

function formatModelName(name: string): string {
  const displayName = name === "auto" ? "Auto" : name;
  return /\(Kiro\)$/i.test(displayName) ? displayName : `${displayName} (Kiro)`;
}

function supportsImages(id: string): boolean {
  return id === "auto" || id.startsWith("claude-");
}

function inferContextWindow(id: string): number {
  if (id === "auto") return 1000000;
  if (/^claude-(opus|sonnet)-4\.[6-9]/.test(id)) return 1000000;
  if (id.startsWith("deepseek-")) return 164000;
  if (id.startsWith("minimax-")) return 196000;
  if (id.startsWith("qwen")) return 256000;
  return 200000;
}

function inferMaxTokens(id: string): number {
  if (id === "auto") return 32000;
  if (id.startsWith("claude-opus-")) return 32000;
  if (id.startsWith("claude-sonnet-")) return 16384;
  return 8192;
}
