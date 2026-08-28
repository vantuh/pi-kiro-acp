import type {
  MarkdownTransformer,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  KIRO_TOOL_FRAME_PREFIX,
  nativeToolFrameRegex,
} from "./native-tool-frame.ts";

type FrameStatus = "failed" | "aborted" | undefined;

function frameStatus(lines: string[]): FrameStatus {
  const last = lines[lines.length - 1]?.trim();
  if (last === "[failed]") return "failed";
  if (last === "[aborted]") return "aborted";
  return undefined;
}

function backgroundFor(
  status: FrameStatus,
): "customMessageBg" | "toolErrorBg" | "toolPendingBg" {
  if (status === "failed") return "toolErrorBg";
  if (status === "aborted") return "toolPendingBg";
  return "customMessageBg";
}

function borderColorFor(status: FrameStatus): ThemeColor {
  if (status === "failed") return "error";
  if (status === "aborted") return "warning";
  return "customMessageLabel";
}

function paintBackground(
  theme: Theme | undefined,
  bg: ReturnType<typeof backgroundFor>,
  text: string,
): string {
  if (!theme) return text;
  try {
    return theme.bg(bg, text);
  } catch {
    try {
      return theme.bg("selectedBg", text);
    } catch {
      return text;
    }
  }
}

function paintBorder(
  theme: Theme | undefined,
  color: ThemeColor,
  text: string,
): string {
  if (!theme) return text;
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

function paintContent(
  theme: Theme | undefined,
  text: string,
  kind: "title" | "body" | "status",
  status: FrameStatus,
): string {
  if (!theme) return text;
  if (kind === "title") return theme.bold(theme.fg("toolTitle", text));
  if (kind === "status")
    return theme.fg(status === "aborted" ? "warning" : "error", text);
  return theme.fg("toolOutput", text);
}

/**
 * Encode a box row as an inline code span so marked keeps spaces, (), #, fences,
 * and SGR `[` as literal text. Same delimiter rule as pi's mermaid transformer.
 */
function codeSpan(line: string): string {
  const content = line || "\u00a0";
  const longest = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

function renderFrame(
  inner: string,
  theme: Theme | undefined,
  width: number,
): string {
  const lines = inner
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "   ").trimEnd());
  const status = frameStatus(lines);
  const bg = backgroundFor(status);
  const borderColor = borderColorFor(status);
  const innerWidth = Math.max(1, width - 4);
  const horizontal = "─".repeat(width - 2);
  const rendered = [
    paintBackground(
      theme,
      bg,
      paintBorder(theme, borderColor, `╭${horizontal}╮`),
    ),
  ];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const kind =
      i === 0 ? "title" : i === lines.length - 1 && status ? "status" : "body";
    for (const wrapped of wrapTextWithAnsi(raw, innerWidth)) {
      const piece = truncateToWidth(wrapped, innerWidth, "", false);
      const painted = paintContent(theme, piece, kind, status);
      const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(piece)));
      const row =
        paintBorder(theme, borderColor, "│ ") +
        painted +
        pad +
        paintBorder(theme, borderColor, " │");
      rendered.push(paintBackground(theme, bg, row));
    }
  }

  rendered.push(
    paintBackground(
      theme,
      bg,
      paintBorder(theme, borderColor, `╰${horizontal}╯`),
    ),
  );
  // Hard break + code span: marked will not reflow or re-indent tool output.
  return `\n\n${rendered.map(codeSpan).join("  \n")}\n\n`;
}

/**
 * Rewrites <!--kiro-tool--> marker blocks into width-aware ANSI cards with a
 * Unicode box border and pi's custom-message colors. Display-only — session
 * keeps the marker text while the context hook removes it before model calls.
 *
 * Theme is optional: without it the markers are still stripped so the
 * raw HTML comments never show as a gray paragraph. Inner title/body stay
 * visible. If restyle throws, the inner lines are emitted as plain text.
 */
export function createKiroToolFrameTransformer(
  getTheme: () => Theme | undefined,
): MarkdownTransformer {
  return (markdown, context) => {
    if (context.messageType === "user") return markdown;
    if (!markdown.includes(KIRO_TOOL_FRAME_PREFIX)) return markdown;

    let theme: Theme | undefined;
    try {
      theme = getTheme();
    } catch {
      theme = undefined;
    }

    // availableWidth is already Markdown's content width (padding subtracted).
    const width = Math.max(8, context.availableWidth);

    return markdown.replace(nativeToolFrameRegex(), (_match, inner: string) => {
      try {
        return renderFrame(inner, theme, width);
      } catch {
        return `\n${inner}\n`;
      }
    });
  };
}
