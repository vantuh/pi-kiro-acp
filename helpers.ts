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
  // Everything after the current user message is work already performed for it
  // (tool calls Kiro made plus their results). Replaying without it makes a
  // fresh Kiro session redo that work — e.g. relaunching the same subagent.
  const done = msgs.slice(lastUserIdx + 1);

  const historyText = history.map(formatHistoryMessage).filter(Boolean).join("\n\n");
  const doneText = done.map(formatHistoryMessage).filter(Boolean).join("\n\n");

  const parts: string[] = [];
  if (historyText) parts.push(`<conversation_history>\n${historyText}\n</conversation_history>`);
  parts.push(`<current_user_message>\n${escapeText(current)}\n</current_user_message>`);
  if (doneText) parts.push(`<work_already_done>\n${WORK_ALREADY_DONE_NOTE}\n\n${doneText}\n</work_already_done>`);

  return parts.join("\n\n");
}

const WORK_ALREADY_DONE_NOTE =
  "You already ran the steps below while answering the current message, and their results are final. " +
  "Continue from them instead of repeating any of them.";

/**
 * Prompt used when Kiro dropped an in-flight pi_host tools/call (its MCP client
 * gave up before pi finished executing the tool) and the result therefore has to
 * be handed back as a new turn on the same ACP session.
 */
export function buildToolResultRecoveryPrompt(toolResults: ToolResultInfo[]): string {
  const blocks = toolResults
    .map((tr) =>
      `<tool_result name="${escapeAttr(tr.toolName)}" is_error="${tr.isError ? "true" : "false"}">\n` +
      `${escapeText(truncate(tr.text, MAX_TOOL_RESULT_CHARS))}\n</tool_result>`,
    )
    .join("\n\n");

  return (
    "<dropped_tool_result>\n" +
    "The tool call(s) you issued below did not return before your side of the connection gave up, " +
    "so you never saw the result. The tool did run to completion — its output follows. " +
    "Treat it exactly as the return value of your own tool call and continue the turn from there. " +
    "Do not call the tool again.\n\n" +
    `${blocks}\n` +
    "</dropped_tool_result>"
  );
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

/** Deep-sort object keys so structurally equal values serialize identically. */
export function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableValue);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = stableValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
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

/** Image blocks carried by tool results, for prompts that must re-attach them. */
export function imagesFromToolResults(
  toolResults: ToolResultInfo[],
): { type: "image"; data: string; mimeType: string }[] {
  return toolResults.flatMap((tr) =>
    (tr.content ?? []).filter(
      (b): b is { type: "image"; data: string; mimeType: string } => b.type === "image",
    )
  );
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
