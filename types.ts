import type { ChildProcess } from "node:child_process";
import type { Interface as ReadlineInterface } from "node:readline";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

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
  rawCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (result: { result: string; isError?: boolean; content?: ToolResultContentBlock[] }) => void;
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
  sessionCost?: { amount: number; currency: string };
  meteringUsage?: Array<{ unit: string; unitPlural?: string; value: number }>;
  turnDurationMs?: number;
}

export interface ToolResultInfo {
  toolCallId: string;
  toolName: string;
  text: string;
  content?: ToolResultContentBlock[];
  isError: boolean;
}

export interface StreamRequest {
  model: Model<any>;
  context: Context;
  options?: SimpleStreamOptions;
  output: AssistantMessage;
}

export interface AcpSessionStateFields {
  id: string;
  cwd: string;
  proc: ChildProcess | null;
  rl: ReadlineInterface | null;
  rpcId: number;
  rpcPending: Map<number, PendingRpc>;
  acpSessionId: string | null;
  systemPromptHash: string | null;
  currentModelId: string | null;
  currentEffort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  toolBridge: import("./tool-bridge.ts").ToolBridge | null;
  catalogProvider: (() => import("./tool-catalog.ts").ForwardedToolCatalog) | null;
  agentConfigPath: string | null;
  agentName: string;
  started: boolean;
  updateHandler: ((u: SessionUpdate) => void) | null;
  metadata: SessionMetadata | null;
  agentCapabilities: unknown;
  persistenceKey: string | null;
  pendingToolCalls: Map<string, PendingToolCall>;
  onToolCallFromBridge: ((call: PendingToolCall) => void) | null;
  activePromptDone: Promise<{ stopReason: string }> | null;
  streamGen: number;
  lastUsedAt: number;
}
