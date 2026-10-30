import type { JsonObject } from '@earendil-works/pi-ai';

export interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  method: string;
}

export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface PendingToolCall {
  callId: string;
  toolName: string;
  args: JsonObject;
  resolve: (result: {
    result: string;
    isError?: boolean;
    content?: ToolResultContentBlock[];
  }) => void;
  emitted?: boolean;
  /** Kiro rejected the call itself (its `tool_call`/`tool_load` meta tool), so
   * pi is shown it but no tools/call holds the result. */
  rejected?: boolean;
  /** Date.now() when the pi_host bridge received Kiro's tools/call */
  receivedAt: number;
}

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type ContextBreakdownCategory =
  | 'contextFiles'
  | 'tools'
  | 'memory'
  | 'kiroResponses'
  | 'yourPrompts'
  | 'sessionFiles';

export interface ContextBreakdownEntry {
  category: ContextBreakdownCategory;
  tokens?: number;
  percent?: number;
  /** tools only: kiro's mcp/builtin split. */
  mcpTokens?: number;
  builtinTokens?: number;
}

export interface SessionMetadata {
  sessionId: string;
  contextUsagePercentage?: number;
  /** kiro's own compaction threshold, in percent of the context window. */
  summarizationThreshold?: number;
  /** Per-category share of the context. `percent` is reliable; on kiro-cli
   * 2.35.2 `tokens` is only trustworthy for tools.builtin. */
  contextBreakdown?: ContextBreakdownEntry[];
  contextUsed?: number;
  contextSize?: number;
  // NOTE: sessionCost / meteringUsage are per-turn session telemetry only —
  // NOT the account plan quota (credits, % used, reset date). ACP does not
  // expose plan usage; see usage.ts for how that is fetched.
  sessionCost?: { amount: number; currency: string };
  meteringUsage?: Array<{ unit: string; unitPlural?: string; value: number }>;
  turnDurationMs?: number;
  /** kiro's view of the session's thinking support, from
   * `_kiro.dev/metadata.reasoning`. `effort` is the level kiro actually has
   * applied — the only confirmation that pi's requested level took effect. */
  reasoning?: {
    support?: string;
    thinkingEnabled?: boolean;
    effort?: string;
    effortLevels?: string[];
  };
}

export interface ToolResultInfo {
  toolCallId: string;
  toolName: string;
  text: string;
  content?: ToolResultContentBlock[];
  isError: boolean;
}
