import { nativeToolFrame } from "./native-tool-frame.ts";

/** Stream-writing hooks the mirror needs, injected so the logic stays testable. */
export type NativeToolMirrorHooks = {
	pushThinking(delta: string): void;
	endThinking(): void;
	setWorkingMessage(message?: string): void;
};

/**
 * Tracks Kiro's native (non-pi_host) tool calls and mirrors each finished one into
 * the stream as a self-contained thinking block. Display only — it never emits
 * toolcall_* events, which would make pi try to execute the tool itself.
 */
export function createNativeToolMirror(hooks: NativeToolMirrorHooks) {
	const tracked = new Map<string, { title: string; text: string }>();

	/** Own thinking block per tool, so nothing can nest inside a rendered block. */
	const emit = (title: string, body: string, status: string) => {
		hooks.endThinking();
		hooks.pushThinking(nativeToolFrame(title, body, status));
		hooks.endThinking();
	};

	return {
		update(update: any): void {
			const toolCallId = update.toolCallId;
			if (typeof toolCallId !== "string") return;

			if (update.sessionUpdate === "tool_call") {
				// pi_host-forwarded tools already render via real pi execution; only
				// mirror Kiro's native tools, which carry no mcpServerName.
				if (update._meta?.kiro?.mcpServerName) return;
				const title = typeof update.title === "string" ? update.title : (update._meta?.kiro?.toolName ?? "tool");
				tracked.set(toolCallId, { title, text: "" });
				hooks.setWorkingMessage(`🔧 ${title}`);
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
				if (tracked.size === 0) hooks.setWorkingMessage();
			}
		},

		/** Close out tools still running when the turn ends (cancel, error, stop). */
		flush(): void {
			for (const entry of tracked.values()) emit(entry.title, entry.text, "aborted");
			tracked.clear();
			hooks.setWorkingMessage();
		},
	};
}
