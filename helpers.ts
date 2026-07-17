import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { SessionMetadata, ToolResultContentBlock, ToolResultInfo } from "./types.ts";

const MAX_HISTORY_TEXT_CHARS = 12000;
const MAX_TOOL_RESULT_CHARS = 20000;

export function lastUserMessage(context: Context): string {
  const msgs = context.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      const content = msgs[i].content;
      if (typeof content === "string") return content;
      return (content as any[]).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    }
  }
  return "";
}

export function buildConversationPrompt(context: Context): string {
  const msgs = context.messages || [];
  const lastUserIdx = findLastUserIndex(context);

  if (lastUserIdx < 0) return "";

  const history = msgs.slice(0, lastUserIdx);
  const current = messageText(msgs[lastUserIdx], Infinity);
  const historyText = history.map(formatHistoryMessage).filter(Boolean).join("\n\n");

  if (!historyText) {
    return `<current_user_message>\n${escapeText(current)}\n</current_user_message>`;
  }

  return `<conversation_history>\n${historyText}\n</conversation_history>\n\n<current_user_message>\n${escapeText(current)}\n</current_user_message>`;
}

function findLastUserIndex(context: Context): number {
  const msgs = context.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return i;
  }
  return -1;
}

function formatHistoryMessage(msg: Context["messages"][number]): string {
  if (msg.role === "user") {
    return `<message role="user">\n${escapeText(messageText(msg, MAX_HISTORY_TEXT_CHARS))}\n</message>`;
  }

  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(`<text>\n${escapeText(truncate(block.text, MAX_HISTORY_TEXT_CHARS))}\n</text>`);
      } else if (block.type === "toolCall") {
        parts.push(`<tool_call id="${escapeAttr(block.id)}" name="${escapeAttr(block.name)}">\n${escapeText(safeJson(block.arguments))}\n</tool_call>`);
      }
    }
    return parts.length ? `<message role="assistant">\n${parts.join("\n")}\n</message>` : "";
  }

  if (msg.role === "toolResult") {
    return `<tool_result id="${escapeAttr(msg.toolCallId)}" name="${escapeAttr(msg.toolName)}" is_error="${msg.isError ? "true" : "false"}">\n${escapeText(messageText(msg, MAX_TOOL_RESULT_CHARS))}\n</tool_result>`;
  }

  return "";
}

function messageText(msg: Context["messages"][number], maxChars = MAX_HISTORY_TEXT_CHARS): string {
  const content = msg.content;
  const text = typeof content === "string"
    ? content
    : (content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join("\n");
  return truncate(text, maxChars);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...truncated ${text.length - maxChars} chars...]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function extractToolResults(context: Context): ToolResultInfo[] {
  const results: ToolResultInfo[] = [];
  const msgs = context.messages || [];

  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role === "toolResult") {
      const content = normalizeToolResultContent(msg.content as any[]);
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const hasImages = content.some((c) => c.type === "image");
      results.push({
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        text,
        ...(hasImages ? { content } : {}),
        isError: msg.isError,
      });
    } else if (msg.role === "assistant") {
      break;
    }
  }

  return results.reverse();
}

function normalizeToolResultContent(content: any[]): ToolResultContentBlock[] {
  const blocks: ToolResultContentBlock[] = [];
  for (const block of content || []) {
    if (block?.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

export function estimateUsage(
  output: AssistantMessage,
  contextWindow?: number,
  metadata?: SessionMetadata | null,
) {
  let chars = 0;
  for (const b of output.content) {
    if (b.type === "text") chars += b.text.length;
    else if (b.type === "thinking") chars += b.thinking.length;
  }

  const outputTokens = Math.round(chars / 4);
  const reportedContextTokens = typeof metadata?.contextUsed === "number"
    ? Math.max(0, Math.round(metadata.contextUsed))
    : typeof metadata?.contextUsagePercentage === "number" && contextWindow
      ? Math.round((Math.max(0, metadata.contextUsagePercentage) / 100) * contextWindow)
      : 0;
  const totalTokens = Math.max(outputTokens, reportedContextTokens);

  return {
    input: Math.max(0, totalTokens - outputTokens),
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function appendKiroMetadataDiagnostic(
  output: AssistantMessage,
  metadata?: SessionMetadata | null,
): void {
  if (!metadata) return;
  output.diagnostics = [
    ...(output.diagnostics ?? []),
    {
      type: "kiro_metadata",
      timestamp: Date.now(),
      details: {
        sessionId: metadata.sessionId,
        contextUsagePercentage: metadata.contextUsagePercentage,
        contextUsed: metadata.contextUsed,
        contextSize: metadata.contextSize,
        sessionCost: metadata.sessionCost,
        meteringUsage: metadata.meteringUsage,
        turnDurationMs: metadata.turnDurationMs,
        credits: metadata.meteringUsage?.find((m) => m.unit === "credit")?.value,
      },
    },
  ];
}

export function createOutputMessage(model: any): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
