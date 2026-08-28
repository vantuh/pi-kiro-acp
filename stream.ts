import {
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendKiroMetadataDiagnostic,
  buildPromptParts,
  buildToolResultRecoveryPrompt,
  createOutputMessage,
  estimateUsage,
  imagesFromToolResults,
  lastUserMessage,
} from "./helpers.ts";
import { log, msSince } from "./logging.ts";
import { createNativeToolMirror } from "./native-tool-mirror.ts";
import {
  historyFingerprintAfterAssistantTurn,
  historyFingerprintBeforeCurrentUser,
  loadPersistedKiroSession,
  savePersistedKiroSession,
} from "./session-persistence.ts";
import { toKiroEffort } from "./session.ts";
import { buildForwardedToolCatalog } from "./tool-catalog.ts";
import { pruneIdleSessions, routeSession } from "./session-manager.ts";

/** Minimal structural view of the UI surface the native-tool mirror needs. */
type MirrorUi = { setWorkingMessage(message?: string): void };

/**
 * Phase 4: mirror Kiro's native (non-pi_host) tool activity into pi as
 * display-only text blocks so they interleave with assistant text and remain
 * visible when thinking is hidden. Each finished tool is emitted as one
 * `<!--kiro-tool-->` marker block that the markdown transformer restyles inline.
 * Never emits real toolcall_* (that would make pi execute it).
 * Disable with PI_KIRO_ACP_MIRROR=0.
 */
const MIRROR_NATIVE_TOOLS = process.env.PI_KIRO_ACP_MIRROR !== "0";

/**
 * How long to keep collecting tool calls before handing the batch to pi.
 *
 * Kiro does not emit a parallel batch in one I/O tick: measured gaps are 0ms
 * (several calls in the same millisecond) and 74ms. Flushing on the first call
 * strands its siblings — they land in `pendingToolCalls` with no stream to emit
 * them into, and Kiro drops them at its 120s deadline, which its model reports as
 * a transport error and then retries forever while the first tool still runs.
 *
 * Cost is this delay once per turn, before the first tool starts (model TTFT is
 * 5-10s for comparison). Override with PI_KIRO_ACP_TOOL_BATCH_MS; 0 restores the
 * old flush-immediately behaviour.
 */
const TOOL_CALL_DEBOUNCE_MS = (() => {
  const raw = Number(process.env.PI_KIRO_ACP_TOOL_BATCH_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
})();

/**
 * A recovery prompt that kiro-cli refuses without producing any content is a
 * broken handoff, not a finished turn. It is re-sent after this delay, at most
 * REFUSAL_RETRIES times, before falling back to ending the turn.
 */
const REFUSAL_RETRY_DELAY_MS =
  Number(process.env.PI_KIRO_ACP_REFUSAL_RETRY_MS) || 1500;
const REFUSAL_RETRIES = 1;

export function streamKiroAcp(
  pi: ExtensionAPI,
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
  getUi?: () => MirrorUi | undefined,
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
      // Capture before ensureStarted: a cold/parallel process gets an acpSessionId
      // for an empty conversation, which must not look like in-place recovery.
      const hadLiveConversation = !!session.acpSessionId;
      const catalogProvider = () =>
        buildForwardedToolCatalog(pi.getAllTools(), pi.getActiveTools());
      await session.ensureStarted(
        catalogProvider,
        toKiroEffort(options?.reasoning),
      );
      const ensuredAt = Date.now();

      log("streamSimple called", {
        session: session.id,
        isResumption: routed.isResumption,
        toolResults: routed.toolResults.length,
        pendingToolCalls: session.pendingToolCalls.size,
        hasActivePrompt: !!session.activePromptDone,
        hadLiveConversation,
        cwd: session.cwd,
        optionSessionId: options?.sessionId,
        ensureStartedMs: ensuredAt - turnStartedAt,
      });

      const prefixFingerprint = historyFingerprintBeforeCurrentUser(context);
      let recoverInPlace = false;
      // Kept for the empty-refusal retry below: the exact recovery prompt that was
      // sent, so it can be re-sent without rebuilding the routing decision.
      let recoveryPrompt: {
        systemPrompt: string;
        text: string;
        images: ReturnType<typeof imagesFromToolResults>;
      } | null = null;

      if (!routed.isResumption) {
        const currentPrompt = buildPromptParts(context, false);
        const replayPrompt = buildPromptParts(context, true);
        // Kiro abandoned its own tools/call for these results, so they can no
        // longer be answered into that MCP request. Re-asking the user's question
        // would make Kiro redo whatever the tool just did (e.g. relaunch the same
        // subagent), so hand the result back instead: as its own turn when the ACP
        // session still holds the conversation, otherwise as a full replay that
        // now carries the completed work.
        recoverInPlace = routed.orphanedToolResults && hadLiveConversation;
        const recoveryText = recoverInPlace
          ? buildToolResultRecoveryPrompt(routed.toolResults)
          : null;
        log("prompt parts", {
          session: session.id,
          promptChars: currentPrompt.userMessage.length,
          replayPromptChars: replayPrompt.userMessage.length,
          orphanedToolResults: routed.orphanedToolResults,
          recoverInPlace,
          hadLiveConversation,
          sessionBusy: session.busy,
          hasActivePrompt: !!session.activePromptDone,
          persistenceKey: session.persistenceKey,
        });
        if (recoveryText) {
          // Kiro is often still running the original session/prompt (it dropped
          // only the tools/call). A second prompt without cancel is "Internal
          // error" in ~1ms. Keep abandoned-call records until this turn lands
          // so a retry of the same tool is answered, not dispatched again.
          recoveryPrompt = {
            systemPrompt: currentPrompt.systemPrompt,
            text: recoveryText,
            images: imagesFromToolResults(routed.toolResults),
          };
          await session.cancelAndStartFollowUp(
            model.id,
            recoveryPrompt.systemPrompt,
            recoveryPrompt.text,
            recoveryPrompt.images,
            30000,
            undefined,
            "orphaned tool result",
          );
        } else {
          await session.startPrompt(
            model.id,
            currentPrompt.systemPrompt,
            currentPrompt.userMessage,
            currentPrompt.images,
            routed.orphanedToolResults
              ? // No live ACP session to recover into: force the replay path so the
                // completed tool call cannot be dropped by resuming a persisted
                // session from before it (the fingerprint ignores trailing results).
                { replayUserMessage: replayPrompt.userMessage }
              : {
                  expectedHistoryFingerprint: prefixFingerprint,
                  replayUserMessage: replayPrompt.userMessage,
                },
          );
        }
      }
      const promptReadyAt = Date.now();

      if (options?.signal) {
        const handler = () =>
          session.rpcNotify("session/cancel", {
            sessionId: session.acpSessionId,
          });
        if (options.signal.aborted) handler();
        else options.signal.addEventListener("abort", handler, { once: true });
      }

      stream.push({ type: "start", partial: output });

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

      const mirrorUi = MIRROR_NATIVE_TOOLS ? getUi?.() : undefined;

      /** Streams one kind of assistant content block (text or thinking): opens
       * it on the first delta, appends, and closes it on demand. A changed
       * messageId closes the block so the next delta opens a new one; a text
       * delta always closes an open thinking block and vice versa. */
      const createBlockWriter = (
        kind: "text" | "thinking",
        endOther: () => void,
      ) => {
        const startType = kind === "text" ? "text_start" : "thinking_start";
        const deltaType = kind === "text" ? "text_delta" : "thinking_delta";
        const endType = kind === "text" ? "text_end" : "thinking_end";
        let started = false;
        let idx = -1;
        let messageId: string | undefined;

        const end = () => {
          if (!started) return;
          const block = output.content[idx] as any;
          stream.push({
            type: endType,
            contentIndex: idx,
            content: kind === "text" ? block.text : block.thinking,
            partial: output,
          });
          started = false;
        };

        const delta = (text: string, id?: string) => {
          if (!text) return;
          endOther();
          if (started && id && messageId && id !== messageId) end();
          if (!started) {
            output.content.push(
              kind === "text"
                ? { type: "text", text: "" }
                : ({ type: "thinking", thinking: "" } as any),
            );
            idx = output.content.length - 1;
            stream.push({
              type: startType,
              contentIndex: idx,
              partial: output,
            });
            started = true;
            messageId = id;
          } else if (!messageId && id) {
            messageId = id;
          }
          const block = output.content[idx] as any;
          if (kind === "text") block.text += text;
          else block.thinking += text;
          stream.push({
            type: deltaType,
            contentIndex: idx,
            delta: text,
            partial: output,
          });
        };

        return { end, delta };
      };

      let endTextBlock: () => void = () => {};
      let endThinkingBlock: () => void = () => {};
      const textWriter = createBlockWriter("text", () => endThinkingBlock());
      const thinkingWriter = createBlockWriter("thinking", () =>
        endTextBlock(),
      );
      endTextBlock = () => textWriter.end();
      endThinkingBlock = () => thinkingWriter.end();

      const nativeToolMirror = createNativeToolMirror({
        pushText: (delta) => textWriter.delta(delta),
        endText: endTextBlock,
        endThinking: endThinkingBlock,
        setWorkingMessage: (message) => mirrorUi?.setWorkingMessage(message),
      });

      session.updateHandler = (update) => {
        if (suppressUpdates) return;
        if (
          MIRROR_NATIVE_TOOLS &&
          (update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update")
        ) {
          nativeToolMirror.update(update);
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = (update.content as any)?.text;
          const messageId =
            typeof update.messageId === "string" ? update.messageId : undefined;
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
            thinkingWriter.delta(text, messageId);
            emittedThinkingDeltas += 1;
          }
        } else if (update.sessionUpdate === "agent_message_chunk") {
          const text = (update.content as any)?.text;
          const messageId =
            typeof update.messageId === "string" ? update.messageId : undefined;
          if (text) {
            if (firstTextAt == null) {
              firstTextAt = Date.now();
              log("timing first text", {
                session: session.id,
                ttftMs: firstTextAt - turnStartedAt,
                sincePromptMs: firstTextAt - promptReadyAt,
                sinceThinkingMs:
                  firstThinkingAt != null
                    ? firstTextAt - firstThinkingAt
                    : null,
              });
            }
            textChars += text.length;
            textChunks += 1;
            textWriter.delta(text, messageId);
            emittedTextDeltas += 1;
          }
        }
      };

      if (routed.isResumption) {
        const imageBlocks = imagesFromToolResults(routed.toolResults);

        if (imageBlocks.length > 0) {
          log("image FUP: detected images in tool results", {
            session: session.id,
            imageCount: imageBlocks.length,
            tools: routed.toolResults.map((tr) => tr.toolName),
          });
          suppressUpdates = true;
          session.deliverToolResults(routed.toolResults, { textOnly: true });

          const userQ = lastUserMessage(context);
          const imageTools = routed.toolResults.filter((tr) =>
            (tr.content ?? []).some((b) => b.type === "image"),
          );
          const toolNames = [
            ...new Set(imageTools.map((tr) => tr.toolName)),
          ].join(", ");
          const textSummaries = imageTools
            .map((tr) => {
              const txt = tr.text.trim();
              return txt
                ? `[${tr.toolName}]: ${txt}`
                : `[${tr.toolName}]: (image result)`;
            })
            .join("\n");
          const followupText =
            `The user asked: ${userQ}\n\n` +
            `Tool(s) ${toolNames} returned image(s) attached to this message.` +
            (textSummaries
              ? `\n\nText summaries from tools:\n${textSummaries}`
              : "") +
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
              () => {
                suppressUpdates = false;
              },
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

      const outcome = await new Promise<"toolUse" | "stop" | "error">(
        (resolve) => {
          let settled = false;
          const finish = (value: "toolUse" | "stop" | "error") => {
            if (settled) return;
            settled = true;
            if (toolFlushTimer) clearTimeout(toolFlushTimer);
            toolFlushTimer = null;
            session.onToolCallFromBridge = null;
            // From here on a tools/call from Kiro cannot reach pi, so the session
            // answers it instead of letting it hang until Kiro's own deadline.
            session.toolIntakeClosed = true;
            resolve(value);
          };

          const unemittedToolCalls = () =>
            [...session.pendingToolCalls.values()].filter(
              (call) => !call.emitted,
            );
          const closeOpenBlocks = () => {
            endThinkingBlock();
            endTextBlock();
          };

          const flushToolCalls = () => {
            const calls = unemittedToolCalls();
            if (calls.length === 0) return false;
            log("tool calls → stream", {
              session: session.id,
              count: calls.length,
              callIds: calls.map((c) => c.callId),
            });

            closeOpenBlocks();

            for (const call of calls) {
              call.emitted = true;
              const tc = {
                type: "toolCall" as const,
                id: call.callId,
                name: call.toolName,
                arguments: call.args,
              };
              output.content.push(tc);
              const idx = output.content.length - 1;
              stream.push({
                type: "toolcall_start",
                contentIndex: idx,
                partial: output,
              });
              stream.push({
                type: "toolcall_end",
                contentIndex: idx,
                toolCall: tc,
                partial: output,
              });
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
            log("tool call queued", {
              session: session.id,
              callId: call.callId,
              toolName: call.toolName,
            });
            scheduleToolFlush();
          };
          if (unemittedToolCalls().length > 0) scheduleToolFlush();

          // kiro-cli answers a prompt sent while its own conversation still holds an
          // unanswered tool_use with an instant, contentless `refusal` (measured
          // 4-20ms, 7 of 14 recoveries on 2026-08-26). Reporting that as a finished
          // turn is what left the orchestrator stopped right after its subagent
          // returned, waiting for the user to say "continue". A second prompt on the
          // same session goes through — that is exactly what the manual nudge did.
          const isEmptyRefusal = (stopReason: string | undefined) =>
            stopReason === "refusal" &&
            thinkingChars === 0 &&
            textChars === 0 &&
            output.content.length === 0;

          let refusalRetries = 0;

          const retryAfterRefusal = () => {
            if (!recoveryPrompt || refusalRetries >= REFUSAL_RETRIES) {
              log("empty refusal → stop", {
                session: session.id,
                retried: refusalRetries,
                recoverable: !!recoveryPrompt,
              });
              finish("stop");
              return;
            }
            refusalRetries += 1;
            log("empty refusal → resending recovery prompt", {
              session: session.id,
              attempt: refusalRetries,
              delayMs: REFUSAL_RETRY_DELAY_MS,
              promptChars: recoveryPrompt.text.length,
            });
            setTimeout(() => {
              if (settled || gen !== session.streamGen) return;
              session
                .startPrompt(
                  model.id,
                  recoveryPrompt!.systemPrompt,
                  recoveryPrompt!.text,
                  recoveryPrompt!.images,
                )
                .then(attachPromptSettle, (e: Error) => {
                  if (settled || gen !== session.streamGen) return;
                  promptError = e;
                  log("empty refusal retry failed → error", {
                    session: session.id,
                    error: e?.message,
                  });
                  finish("error");
                });
            }, REFUSAL_RETRY_DELAY_MS);
          };

          function attachPromptSettle(): void {
            session.activePromptDone?.then(
              (result) => {
                if (gen === session.streamGen && !settled) {
                  if (!flushToolCalls()) {
                    if (isEmptyRefusal(result?.stopReason)) {
                      retryAfterRefusal();
                      return;
                    }
                    log("prompt done → stop", { session: session.id });
                    finish("stop");
                  }
                }
              },
              (e) => {
                if (gen === session.streamGen && !settled) {
                  promptError = e;
                  if (!flushToolCalls()) {
                    log("prompt error → error", {
                      session: session.id,
                      error: e?.message,
                    });
                    finish("error");
                  }
                }
              },
            );

            // No prompt in flight: settle now instead of awaiting a promise that never arrives.
            if (!session.activePromptDone && !settled) {
              if (!flushToolCalls()) {
                promptError =
                  session.lastPromptError ??
                  new Error("Kiro ACP session has no active prompt");
                log("no active prompt → error", {
                  session: session.id,
                  error: promptError.message,
                });
                finish("error");
              }
            }
          }

          attachPromptSettle();
        },
      );

      session.updateHandler = null;
      if (MIRROR_NATIVE_TOOLS) {
        nativeToolMirror.flush();
      }
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
          ttftThinkingMs:
            firstThinkingAt != null ? firstThinkingAt - turnStartedAt : null,
          ttftTextMs: firstTextAt != null ? firstTextAt - turnStartedAt : null,
          firstToolMs: firstToolAt != null ? firstToolAt - turnStartedAt : null,
          thinkingChars,
          textChars,
          thinkingChunks,
          textChunks,
          emittedThinkingDeltas,
          emittedTextDeltas,
          avgThinkingChunkChars: thinkingChunks
            ? Math.round(thinkingChars / thinkingChunks)
            : null,
          avgTextChunkChars: textChunks
            ? Math.round(textChars / textChunks)
            : null,
          streamMs,
        },
      });

      if (recoverInPlace && outcome !== "error") {
        session.clearAbandonedToolCalls(routed.toolResults);
      }

      output.usage = estimateUsage(
        output,
        model.contextWindow,
        session.metadata,
      );
      appendKiroMetadataDiagnostic(output, session.metadata);

      if (outcome === "toolUse") {
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else if (outcome === "error") {
        session.activePromptDone = null;
        output.stopReason = "error";
        output.errorMessage = promptError?.message || "Kiro ACP prompt failed";
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        session.activePromptDone = null;
        output.stopReason = "stop";
        if (session.persistenceKey && session.acpSessionId) {
          const now = Date.now();
          const existingPersisted = loadPersistedKiroSession(
            session.persistenceKey,
          );
          savePersistedKiroSession(session.persistenceKey, {
            version: 1,
            kiroSessionId: session.acpSessionId,
            historyFingerprint: historyFingerprintAfterAssistantTurn(
              context,
              output,
            ),
            modelId: session.currentModelId,
            createdAt: existingPersisted?.createdAt ?? now,
            lastUsed: now,
          });
        }
        stream.push({ type: "done", reason: "stop", message: output });
      }

      stream.end();
    } catch (error) {
      log("streamKiroAcp FATAL error", {
        error:
          error instanceof Error ? error.stack || error.message : String(error),
      });
      output.stopReason = "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();

  return stream;
}
