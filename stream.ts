import {
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { appendKiroMetadataDiagnostic, createOutputMessage, estimateUsage, lastUserMessage } from "./helpers.ts";
import { log } from "./logging.ts";
import {
  historyFingerprintAfterAssistantTurn,
  historyFingerprintBeforeCurrentUser,
  loadPersistedKiroSession,
  savePersistedKiroSession,
} from "./session-persistence.ts";
import { buildPromptParts, toKiroEffort } from "./session.ts";
import { pruneIdleSessions, routeSession } from "./session-manager.ts";

const TOOL_CALL_DEBOUNCE_MS = 50;

export function streamKiroAcp(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  log("streamKiroAcp entry", {
    modelId: model.id,
    toolsCount: context.tools?.length ?? 0,
    messagesCount: context.messages?.length ?? 0,
    systemPromptLen: context.systemPrompt?.length ?? 0,
    sessionId: options?.sessionId,
  });
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = createOutputMessage(model);

    try {
      pruneIdleSessions();
      const routed = await routeSession(context, options);
      const session = routed.session;
      session.lastUsedAt = Date.now();
      await session.ensureStarted(context.tools, toKiroEffort(options?.reasoning));

      log("streamSimple called", {
        session: session.id,
        isResumption: routed.isResumption,
        toolResults: routed.toolResults.length,
        pendingToolCalls: session.pendingToolCalls.size,
        hasActivePrompt: !!session.activePromptDone,
        cwd: session.cwd,
        optionSessionId: options?.sessionId,
      });

      const prefixFingerprint = historyFingerprintBeforeCurrentUser(context);

      if (!routed.isResumption) {
        const currentPrompt = buildPromptParts(context, false);
        const replayPrompt = buildPromptParts(context, true);
        log("prompt parts", {
          session: session.id,
          promptChars: currentPrompt.userMessage.length,
          replayPromptChars: replayPrompt.userMessage.length,
          sessionBusy: session.busy,
          hasActivePrompt: !!session.activePromptDone,
          persistenceKey: session.persistenceKey,
        });
        await session.startPrompt(
          model.id,
          currentPrompt.systemPrompt,
          currentPrompt.userMessage,
          currentPrompt.images,
          {
            expectedHistoryFingerprint: prefixFingerprint,
            replayUserMessage: replayPrompt.userMessage,
            tools: context.tools,
          },
        );
      }

      if (options?.signal) {
        const handler = () => session.rpcNotify("session/cancel", { sessionId: session.acpSessionId });
        if (options.signal.aborted) handler();
        else options.signal.addEventListener("abort", handler, { once: true });
      }

      stream.push({ type: "start", partial: output });

      let textStarted = false;
      let textIdx = -1;
      let thinkingStarted = false;
      let thinkingIdx = -1;
      let textMessageId: string | undefined;
      let thinkingMessageId: string | undefined;
      let suppressUpdates = false;

      session.updateHandler = (update) => {
        if (suppressUpdates) return;
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = (update.content as any)?.text;
          const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
          if (text) {
            if (textStarted) {
              stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
              textStarted = false;
            }
            if (thinkingStarted && messageId && thinkingMessageId && messageId !== thinkingMessageId) {
              stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
              thinkingStarted = false;
            }
            if (!thinkingStarted) {
              output.content.push({ type: "thinking", thinking: "" } as any);
              thinkingIdx = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: output });
              thinkingStarted = true;
              thinkingMessageId = messageId;
            } else if (!thinkingMessageId && messageId) {
              thinkingMessageId = messageId;
            }
            (output.content[thinkingIdx] as any).thinking += text;
            stream.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta: text, partial: output });
          }
        } else if (update.sessionUpdate === "agent_message_chunk") {
          const text = (update.content as any)?.text;
          const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
          if (text) {
            if (thinkingStarted) {
              stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
              thinkingStarted = false;
            }
            if (textStarted && messageId && textMessageId && messageId !== textMessageId) {
              stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
              textStarted = false;
            }
            if (!textStarted) {
              output.content.push({ type: "text", text: "" });
              textIdx = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
              textStarted = true;
              textMessageId = messageId;
            } else if (!textMessageId && messageId) {
              textMessageId = messageId;
            }
            (output.content[textIdx] as any).text += text;
            stream.push({ type: "text_delta", contentIndex: textIdx, delta: text, partial: output });
          }
        }
      };

      if (routed.isResumption) {
        const imageBlocks = routed.toolResults.flatMap((tr) =>
          (tr.content ?? []).filter(
            (b): b is { type: "image"; data: string; mimeType: string } => b.type === "image",
          )
        );

        if (imageBlocks.length > 0) {
          log("image FUP: detected images in tool results", {
            session: session.id,
            imageCount: imageBlocks.length,
            tools: routed.toolResults.map((tr) => tr.toolName),
          });
          suppressUpdates = true;
          session.deliverToolResultsTextOnly(routed.toolResults);

          const userQ = lastUserMessage(context);
          const imageTools = routed.toolResults.filter((tr) =>
            (tr.content ?? []).some((b) => b.type === "image")
          );
          const toolNames = [...new Set(imageTools.map((tr) => tr.toolName))].join(", ");
          const textSummaries = imageTools
            .map((tr) => {
              const txt = tr.text.trim();
              return txt ? `[${tr.toolName}]: ${txt}` : `[${tr.toolName}]: (image result)`;
            })
            .join("\n");
          const followupText =
            `The user asked: ${userQ}\n\n` +
            `Tool(s) ${toolNames} returned image(s) attached to this message.` +
            (textSummaries ? `\n\nText summaries from tools:\n${textSummaries}` : "") +
            `\n\nPlease answer the user's question based on the attached image(s). ` +
            `Do not guess or describe what you think the image might show if you cannot see it — say so explicitly instead.`;

          const { systemPrompt } = buildPromptParts(context, false);
          try {
            await session.cancelAndStartFollowUp(
              model.id,
              systemPrompt,
              followupText,
              imageBlocks,
              15000,
              () => { suppressUpdates = false; },
            );
          } finally {
            suppressUpdates = false;
          }
        } else {
          session.deliverToolResults(routed.toolResults);
        }
      }

      const gen = ++session.streamGen;
      let promptError: Error | null = null;
      let toolFlushTimer: ReturnType<typeof setTimeout> | null = null;

      const outcome = await new Promise<"toolUse" | "stop" | "error">((resolve) => {
        let settled = false;
        const finish = (value: "toolUse" | "stop" | "error") => {
          if (settled) return;
          settled = true;
          if (toolFlushTimer) clearTimeout(toolFlushTimer);
          toolFlushTimer = null;
          session.onToolCallFromBridge = null;
          resolve(value);
        };

        const unemittedToolCalls = () => [...session.pendingToolCalls.values()].filter((call) => !call.emitted);
        const closeOpenBlocks = () => {
          if (thinkingStarted) {
            stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
            thinkingStarted = false;
          }
          if (textStarted) {
            stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
            textStarted = false;
          }
        };

        const flushToolCalls = () => {
          const calls = unemittedToolCalls();
          if (calls.length === 0) return false;
          log("tool calls → stream", { session: session.id, count: calls.length, callIds: calls.map((c) => c.callId) });

          closeOpenBlocks();

          for (const call of calls) {
            call.emitted = true;
            const tc = { type: "toolCall" as const, id: call.callId, name: call.toolName, arguments: call.args };
            output.content.push(tc);
            const idx = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });
          }

          finish("toolUse");
          return true;
        };

        const scheduleToolFlush = () => {
          if (toolFlushTimer) clearTimeout(toolFlushTimer);
          toolFlushTimer = setTimeout(() => {
            toolFlushTimer = null;
            flushToolCalls();
          }, TOOL_CALL_DEBOUNCE_MS);
        };

        session.onToolCallFromBridge = (call) => {
          log("tool call queued", { session: session.id, callId: call.callId, toolName: call.toolName });
          scheduleToolFlush();
        };
        if (unemittedToolCalls().length > 0) scheduleToolFlush();

        session.activePromptDone?.then(
          () => {
            if (gen === session.streamGen && !settled) {
              if (!flushToolCalls()) {
                log("prompt done → stop", { session: session.id });
                finish("stop");
              }
            }
          },
          (e) => {
            if (gen === session.streamGen && !settled) {
              promptError = e;
              if (!flushToolCalls()) {
                log("prompt error → error", { session: session.id, error: e?.message });
                finish("error");
              }
            }
          },
        );
      });

      session.updateHandler = null;

      if (thinkingStarted) {
        stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
      }
      if (textStarted) {
        stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
      }

      log("outcome", { session: session.id, outcome, gen, streamGen: session.streamGen });

      if (outcome === "toolUse") {
        output.stopReason = "toolUse";
        output.usage = estimateUsage(output, model.contextWindow, session.metadata);
        appendKiroMetadataDiagnostic(output, session.metadata);
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else if (outcome === "error") {
        session.activePromptDone = null;
        output.stopReason = "error";
        output.errorMessage = promptError?.message || "Kiro ACP prompt failed";
        output.usage = estimateUsage(output, model.contextWindow, session.metadata);
        appendKiroMetadataDiagnostic(output, session.metadata);
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        session.activePromptDone = null;
        output.stopReason = "stop";
        output.usage = estimateUsage(output, model.contextWindow, session.metadata);
        appendKiroMetadataDiagnostic(output, session.metadata);
        if (session.persistenceKey && session.acpSessionId) {
          const now = Date.now();
          const existingPersisted = loadPersistedKiroSession(session.persistenceKey);
          savePersistedKiroSession(session.persistenceKey, {
            version: 1,
            kiroSessionId: session.acpSessionId,
            historyFingerprint: historyFingerprintAfterAssistantTurn(context, output),
            modelId: session.currentModelId,
            createdAt: existingPersisted?.createdAt ?? now,
            lastUsed: now,
          });
        }
        stream.push({ type: "done", reason: "stop", message: output });
      }

      stream.end();
    } catch (error) {
      log("streamKiroAcp FATAL error", { error: error instanceof Error ? error.stack || error.message : String(error) });
      output.stopReason = "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();

  return stream;
}
