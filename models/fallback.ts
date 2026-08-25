export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const KIRO_THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

export const KIRO_MODELS = [
  { id: "auto", name: "Auto (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text", "image"] as any, cost: ZERO_COST, contextWindow: 1000000, maxTokens: 32000 },
  { id: "claude-opus-5", name: "Claude Opus 5 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text", "image"] as any, cost: ZERO_COST, contextWindow: 1000000, maxTokens: 32000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text", "image"] as any, cost: ZERO_COST, contextWindow: 1000000, maxTokens: 16384 },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text", "image"] as any, cost: ZERO_COST, contextWindow: 1000000, maxTokens: 32000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text"] as any, cost: ZERO_COST, contextWindow: 272000, maxTokens: 8192 },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text", "image"] as any, cost: ZERO_COST, contextWindow: 1000000, maxTokens: 16384 },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text", "image"] as any, cost: ZERO_COST, contextWindow: 200000, maxTokens: 8192 },
  { id: "deepseek-3.2", name: "DeepSeek 3.2 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text"] as any, cost: ZERO_COST, contextWindow: 164000, maxTokens: 8192 },
  { id: "minimax-m2.5", name: "MiniMax M2.5 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text"] as any, cost: ZERO_COST, contextWindow: 196000, maxTokens: 8192 },
  { id: "minimax-m2.1", name: "MiniMax M2.1 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text"] as any, cost: ZERO_COST, contextWindow: 196000, maxTokens: 8192 },
  { id: "glm-5", name: "GLM-5 (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text"] as any, cost: ZERO_COST, contextWindow: 200000, maxTokens: 8192 },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next (Kiro)", reasoning: true, thinkingLevelMap: KIRO_THINKING_LEVEL_MAP, input: ["text"] as any, cost: ZERO_COST, contextWindow: 256000, maxTokens: 8192 },
];

export type KiroModelConfig = (typeof KIRO_MODELS)[number];
