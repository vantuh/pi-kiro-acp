import {
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { appendKiroMetadataDiagnostic, createOutputMessage, estimateUsage, lastUserMessage } from "./helpers.ts";
import { log, msSince } from "./logging.ts";
import {
  historyFingerprintAfterAssistantTurn,
  historyFingerprintBeforeCurrentUser,
  loadPersistedKiroSession,
  savePersistedKiroSession,
} from "./session-persistence.ts";
import { buildPromptParts, toKiroEffort } from "./session.ts";
import { pruneIdleSessions, routeSession } from "./session-manager.ts";

/**
 * Delay before emitting pending tool calls to pi.
 * 0 = next timer tick: still batches tools that arrive in the same I/O wave
 * (kiro often fires parallel MCP calls within one ms), without the old 50ms stall.
 */
const TOOL_CALL_DEBOUNCE_MS = 0;
/** Batch tiny ACP deltas before pushing to pi (smoother TUI; ~1 frame). */
const STREAM_COALESCE_MS = 24;

type CoalesceKind = "thinking" | "text";

export function streamKiroAcp(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const turnStartedAt = Date.now();
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
      const ensuredAt = Date.now();

      log("streamSimple called", {
        session: session.id,
        isResumption: routed.isResumption,
        toolResults: routed.toolResults.length,
        pendingToolCalls: session.pendingToolCalls.size,
        hasActivePrompt: !!session.activePromptDone,
        cwd: session.cwd,
        optionSessionId: options?.sessionId,
        ensureStartedMs: ensuredAt - turnStartedAt,
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
      const promptReadyAt = Date.now();

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
      let firstThinkingAt: number | null = null;
      let firstTextAt: number | null = null;
      let firstToolAt: number | null = null;
      let thinkingChars = 0;
      let textChars = 0;
      let thinkingChunks = 0;
      let textChunks = 0;
      let emittedThinkingDeltas = 0;
      let emittedTextDeltas = 0;

      let coalesceKind: CoalesceKind | null = null;
      let coalesceBuf = "";
      let coalesceIdx = -1;
      let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

      const flushCoalesced = () => {
        if (coalesceTimer) {
          clearTimeout(coalesceTimer);
          coalesceTimer = null;
        }
        if (!coalesceKind || !coalesceBuf) {
          coalesceKind = null;
          coalesceBuf = "";
          coalesceIdx = -1;
          return;
        }
        if (coalesceKind === "thinking") {
          stream.push({
            type: "thinking_delta",
            contentIndex: coalesceIdx,
            delta: coalesceBuf,
            partial: output,
          });
          emittedThinkingDeltas += 1;
        } else {
          stream.push({
            type: "text_delta",
            contentIndex: coalesceIdx,
            delta: coalesceBuf,
            partial: output,
          });
          emittedTextDeltas += 1;
        }
        coalesceKind = null;
        coalesceBuf = "";
        coalesceIdx = -1;
      };

      const queueDelta = (kind: CoalesceKind, idx: number, delta: string) => {
        if (coalesceKind && (coalesceKind !== kind || coalesceIdx !== idx)) {
          flushCoalesced();
        }
        coalesceKind = kind;
        coalesceIdx = idx;
        coalesceBuf += delta;
        if (!coalesceTimer) {
          coalesceTimer = setTimeout(() => {
            coalesceTimer = null;
            flushCoalesced();
          }, STREAM_COALESCE_MS);
        }
      };

      const endThinkingBlock = () => {
        if (!thinkingStarted) return;
        flushCoalesced();
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIdx,
          content: (output.content[thinkingIdx] as any).thinking,
          partial: output,
        });
        thinkingStarted = false;
      };

      const endTextBlock = () => {
        if (!textStarted) return;
        flushCoalesced();
        stream.push({
          type: "text_end",
          contentIndex: textIdx,
          content: (output.content[textIdx] as any).text,
          partial: output,
        });
        textStarted = false;
      };

      session.updateHandler = (update) => {
        if (suppressUpdates) return;
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = (update.content as any)?.text;
          const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
          if (text) {
            if (firstThinkingAt == null) {
              firstThinkingAt = Date.now();
              log("timing first thinking", {
                session: session.id,
                ttftMs: firstThinkingAt - turnStartedAt,
                sincePromptMs: firstThinkingAt - promptReadyAt,
              });
            }
            thinkingChars += text.length;
            thinkingChunks += 1;
            if (textStarted) endTextBlock();
            if (thinkingStarted && messageId && thinkingMessageId && messageId !== thinkingMessageId) {
              endThinkingBlock();
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
            queueDelta("thinking", thinkingIdx, text);
          }
        } else if (update.sessionUpdate === "agent_message_chunk") {
          const text = (update.content as any)?.text;
          const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
          if (text) {
            if (firstTextAt == null) {
              firstTextAt = Date.now();
              log("timing first text", {
                session: session.id,
                ttftMs: firstTextAt - turnStartedAt,
                sincePromptMs: firstTextAt - promptReadyAt,
                sinceThinkingMs: firstThinkingAt != null ? firstTextAt - firstThinkingAt : null,
              });
            }
            textChars += text.length;
            textChunks += 1;
            if (thinkingStarted) endThinkingBlock();
            if (textStarted && messageId && textMessageId && messageId !== textMessageId) {
              endTextBlock();
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
            queueDelta("text", textIdx, text);
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
          endThinkingBlock();
          endTextBlock();
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
          if (firstToolAt == null) {
            firstToolAt = Date.now();
            log("timing first tool", {
              session: session.id,
              sinceTurnMs: firstToolAt - turnStartedAt,
              sincePromptMs: firstToolAt - promptReadyAt,
              toolName: call.toolName,
            });
          }
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
      endThinkingBlock();
      endTextBlock();

      const turnMs = msSince(turnStartedAt);
      const streamMs = Math.max(0, turnMs - (promptReadyAt - turnStartedAt));
      log("outcome", {
        session: session.id,
        outcome,
        gen,
        streamGen: session.streamGen,
        timing: {
          turnMs,
          ensureStartedMs: ensuredAt - turnStartedAt,
          promptReadyMs: promptReadyAt - turnStartedAt,
          ttftThinkingMs: firstThinkingAt != null ? firstThinkingAt - turnStartedAt : null,
          ttftTextMs: firstTextAt != null ? firstTextAt - turnStartedAt : null,
          firstToolMs: firstToolAt != null ? firstToolAt - turnStartedAt : null,
          thinkingChars,
          textChars,
          thinkingChunks,
          textChunks,
          emittedThinkingDeltas,
          emittedTextDeltas,
          avgThinkingChunkChars: thinkingChunks ? Math.round(thinkingChars / thinkingChunks) : null,
          avgTextChunkChars: textChunks ? Math.round(textChars / textChunks) : null,
          avgEmittedThinkingChars: emittedThinkingDeltas ? Math.round(thinkingChars / emittedThinkingDeltas) : null,
          avgEmittedTextChars: emittedTextDeltas ? Math.round(textChars / emittedTextDeltas) : null,
          coalesceMs: STREAM_COALESCE_MS,
          streamMs,
        },
      });

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
