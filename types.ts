import type { ChildProcess } from "node:child_process";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Interface as ReadlineInterface } from "node:readline";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
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
}

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface SessionMetadata {
  sessionId: string;
  contextUsagePercentage?: number;
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

export interface IpcRequestHandlerArgs {
  req: IncomingMessage;
  res: ServerResponse;
}

export interface AcpSessionStateFields {
  id: string;
  cwd: string;
  proc: ChildProcess | null;
  rl: ReadlineInterface | null;
  rpcId: number;
  rpcPending: Map<number, PendingRpc>;
  acpSessionId: string | null;
  currentModelId: string | null;
  ipcServer: Server | null;
  ipcPort: number | null;
  ipcSecret: string;
  toolsFilePath: string | null;
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
