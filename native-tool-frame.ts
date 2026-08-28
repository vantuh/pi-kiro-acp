/**
 * Marker block for a display-only native Kiro tool.
 *
 * Assistant content is rendered as markdown, so tool output cannot keep its
 * layout (ASCII art from `-` and `|` gets eaten: a dashed line becomes an
 * <hr> / setext heading underline; ``` fences inside output would break out).
 *
 * HTML comments are used so a missed transformer does not look like a code
 * fence (`:::…` previously rendered as a gray code-like paragraph).
 * `createKiroToolFrameTransformer` rewrites the block into ANSI lines with
 * `customMessageBg` so the frame renders inline, mid-response.
 *
 * If the transformer is absent or fails, the block degrades to an HTML
 * comment in assistant text — no tool output is lost.
 */

export const KIRO_TOOL_FRAME_PREFIX = "<!--kiro-tool-->";
export const KIRO_TOOL_FRAME_SUFFIX = "<!--/kiro-tool-->";

export function nativeToolFrameRegex(): RegExp {
	return /^<!--kiro-tool-->\r?\n([\s\S]*?)\r?\n<!--\/kiro-tool-->[ \t]*\r?$/gm;
}

/** Remove display-only native tool cards before messages reach the model. */
export function stripNativeToolFrames(text: string): string {
	return text.replace(nativeToolFrameRegex(), "").replace(/\n{3,}/g, "\n\n").trim();
}

export function nativeToolFrame(title: string, body: string, status: string): string {
	const lines = [`🔧 ${title}`];
	const trimmed = body.trim();
	if (trimmed) lines.push(trimmed);
	if (status && status !== "completed") lines.push(`[${status}]`);
	return `${KIRO_TOOL_FRAME_PREFIX}\n${lines.join("\n")}\n${KIRO_TOOL_FRAME_SUFFIX}\n`;
}
