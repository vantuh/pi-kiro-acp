/**
 * Marker block for a display-only native Kiro tool.
 *
 * Assistant content is rendered as markdown, so tool output cannot keep its
 * layout (ASCII art from `-` and `|` gets eaten: a dashed line becomes an
 * <hr> / setext heading underline; ``` fences inside output would break out).
 *
 * Start/end markers are one-line HTML comments. Inner title/body/status sit
 * between them as plain lines so a missed transformer still paints the wrench
 * title and body (comments themselves are not a display fallback — marked/TUI
 * hide `<!--…-->`, and a transformer throw is swallowed by Pi).
 * `createKiroToolFrameTransformer` rewrites the block into ANSI lines with
 * `customMessageBg` so the frame renders inline, mid-response.
 */

export const KIRO_TOOL_FRAME_PREFIX = "<!--kiro-tool-->";
export const KIRO_TOOL_FRAME_SUFFIX = "<!--/kiro-tool-->";

/** Visible stand-ins so body/title cannot close or reopen the marker block. */
const ESCAPED_PREFIX = "‹!--kiro-tool--›";
const ESCAPED_SUFFIX = "‹!--/kiro-tool--›";

export function nativeToolFrameRegex(): RegExp {
  return /^<!--kiro-tool-->\r?\n([\s\S]*?)\r?\n<!--\/kiro-tool-->[ \t]*\r?$/gm;
}

function escapeFrameDelimiters(text: string): string {
  return text
    .split(KIRO_TOOL_FRAME_PREFIX)
    .join(ESCAPED_PREFIX)
    .split(KIRO_TOOL_FRAME_SUFFIX)
    .join(ESCAPED_SUFFIX);
}

/** Remove display-only native tool cards before messages reach the model. */
export function stripNativeToolFrames(text: string): string {
  return text
    .replace(nativeToolFrameRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Same strip the context hook applies to assistant content arrays. */
export function stripAssistantContentFrames(content: unknown): {
  content: unknown[];
  changed: boolean;
} {
  if (!Array.isArray(content)) return { content: [], changed: false };
  let changed = false;
  const next: unknown[] = [];
  for (const block of content as any[]) {
    if (
      block?.type !== "text" ||
      typeof block.text !== "string" ||
      !block.text.includes(KIRO_TOOL_FRAME_PREFIX)
    ) {
      next.push(block);
      continue;
    }
    changed = true;
    const text = stripNativeToolFrames(block.text);
    if (text) next.push({ ...block, text });
  }
  return { content: next, changed };
}

export function nativeToolFrame(
  title: string,
  body: string,
  status: string,
): string {
  const lines = [`🔧 ${escapeFrameDelimiters(title.replace(/\r?\n/g, " "))}`];
  const trimmed = escapeFrameDelimiters(body.trim());
  if (trimmed) lines.push(trimmed);
  if (status && status !== "completed") lines.push(`[${status}]`);
  return `${KIRO_TOOL_FRAME_PREFIX}\n${lines.join("\n")}\n${KIRO_TOOL_FRAME_SUFFIX}\n`;
}
