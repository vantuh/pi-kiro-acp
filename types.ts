export interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  method: string;
}

export type ToolResultContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PendingToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (result: {
    result: string;
    isError?: boolean;
    content?: ToolResultContentBlock[];
  }) => void;
  emitted?: boolean;
  /** Date.now() when the pi_host bridge received Kiro's tools/call */
  receivedAt: number;
}

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface SessionMetadata {
  sessionId: string;
  contextUsagePercentage?: number;
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
