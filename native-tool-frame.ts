/**
 * Legacy marker block for a display-only native Kiro tool.
 *
 * Kiro used to run some tools natively; each finished one was mirrored into
 * the transcript as a self-contained `<!--kiro-tool-->` HTML-comment block
 * (assistant content is markdown, so only a marker block kept tool output
 * layout intact). Since the forwarded transport (ADR 0001 amendment,
 * 2026-09-04) every tool crosses pi_host and no new frames are produced, but
 * historical transcripts still contain them — these readers strip the
 * markers before content reaches the model or persistence.
 */

export const KIRO_TOOL_FRAME_PREFIX = "<!--kiro-tool-->";
export const KIRO_TOOL_FRAME_SUFFIX = "<!--/kiro-tool-->";

export function nativeToolFrameRegex(): RegExp {
  return /^<!--kiro-tool-->\r?\n([\s\S]*?)\r?\n<!--\/kiro-tool-->[ \t]*\r?$/gm;
}

/** Remove display-only native tool cards before messages reach the model. */
export function stripNativeToolFrames(text: string): string {
  return text
    .replace(nativeToolFrameRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Legacy one-liner frame emitted by sessions without a markdown transformer. */
const TEXT_FRAME_REGEX = /^🔧 .+ (?:✓|\[[a-z_]+\])\n?$/;

/** True for a legacy one-liner native-tool frame line. */
export function isNativeToolTextFrameLine(raw: string): boolean {
  return TEXT_FRAME_REGEX.test(raw);
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
      (!block.text.includes(KIRO_TOOL_FRAME_PREFIX) &&
        !TEXT_FRAME_REGEX.test(block.text))
    ) {
      next.push(block);
      continue;
    }
    changed = true;
    if (!block.text.includes(KIRO_TOOL_FRAME_PREFIX)) continue;
    const text = stripNativeToolFrames(block.text);
    if (text) next.push({ ...block, text });
  }
  return { content: next, changed };
}
