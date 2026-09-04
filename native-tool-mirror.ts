import {
  nativeToolFrame,
  nativeToolTextFrame,
} from "./native-tool-frame.ts";

/** Stream-writing hooks the mirror needs, injected so the logic stays testable. */
export type NativeToolMirrorHooks = {
  pushText(delta: string): void;
  endText(): void;
  endThinking(): void;
  setStatus(text?: string): void;
  /**
   * Frame renderer override. Default paints the HTML-comment card that the
   * main TUI transformer restyles; sessions without that transformer
   * (subagent children, headless) supply nativeToolTextFrame instead, since
   * markdown hides comments and the card would be invisible there.
   */
  frame?(title: string, body: string, status: string): string;
};

/**
 * Tracks Kiro's native (non-pi_host) tool calls and mirrors each finished one
 * into the stream as a self-contained text block. Display only — it never
 * emits toolcall_* events, which would make pi try to execute the tool itself.
 *
 * Live progress while a tool is running goes through `setStatus` (a footer
 * status slot), never `setWorkingMessage`/`setWorkingIndicator` — those
 * overwrite pi's own "Working..." text, which external tools (e.g. Herdr)
 * pattern-match on to detect whether the agent is still busy.
 */
export function createNativeToolMirror(hooks: NativeToolMirrorHooks) {
  const tracked = new Map<string, { title: string; text: string }>();

  /** Own text block per tool, so hide-thinking never hides the rendered card. */
  const emit = (title: string, body: string, status: string) => {
    hooks.endThinking();
    hooks.endText();
    hooks.pushText(
      hooks.frame ? hooks.frame(title, body, status) : nativeToolFrame(title, body, status),
    );
    hooks.endText();
  };

  return {
    update(update: any): void {
      const toolCallId = update.toolCallId;
      if (typeof toolCallId !== "string") return;

      if (update.sessionUpdate === "tool_call") {
        // pi_host-forwarded tools already render via real pi execution; only
        // mirror Kiro's native tools, which carry no mcpServerName.
        if (update._meta?.kiro?.mcpServerName) return;
        const title =
          typeof update.title === "string"
            ? update.title
            : (update._meta?.kiro?.toolName ?? "tool");
        tracked.set(toolCallId, { title, text: "" });
        hooks.setStatus(`🔧 ${title}`);
        return;
      }

      const entry = tracked.get(toolCallId);
      if (!entry) return;

      if (Array.isArray(update.content)) {
        for (const block of update.content) {
          const text = block?.content?.text;
          if (typeof text === "string") entry.text += text;
        }
      }

      if (update.status === "completed" || update.status === "failed") {
        tracked.delete(toolCallId);
        emit(entry.title, entry.text, update.status);
        if (tracked.size === 0) hooks.setStatus();
      }
    },

    /** Close out tools still running when the turn ends (cancel, error, stop). */
    flush(): void {
      for (const entry of tracked.values())
        emit(entry.title, entry.text, "aborted");
      tracked.clear();
      hooks.setStatus();
    },
  };
}


