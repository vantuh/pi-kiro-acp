import type { MarkdownTransformer, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { KIRO_TOOL_FRAME_PREFIX, nativeToolFrameRegex } from "./native-tool-frame.ts";

const STATUS_LINE_RE = /^\[[a-z]+\]$/i;

/** Escape markdown metacharacters so tool output renders verbatim. */
function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_{}\[\]()#+\-.!|>~<])/g, "\\$1");
}

function backgroundFor(lines: string[]): "customMessageBg" | "toolErrorBg" | "toolPendingBg" {
	const status = lines.find((line) => STATUS_LINE_RE.test(line.trimEnd()))?.trim();
	if (status === "[failed]") return "toolErrorBg";
	if (status === "[aborted]") return "toolPendingBg";
	return "customMessageBg";
}

function borderColorFor(lines: string[]): ThemeColor {
	const status = lines.find((line) => STATUS_LINE_RE.test(line.trimEnd()))?.trim();
	if (status === "[failed]") return "error";
	if (status === "[aborted]") return "warning";
	return "customMessageLabel";
}

function paintBackground(theme: Theme | undefined, bg: ReturnType<typeof backgroundFor>, text: string): string {
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

function paintBorder(theme: Theme | undefined, color: ThemeColor, text: string): string {
	if (!theme) return text;
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function paintContent(theme: Theme | undefined, raw: string, kind: "title" | "body" | "status"): string {
	const text = escapeMarkdown(raw);
	if (!theme) return text;
	if (kind === "title") return theme.bold(theme.fg("toolTitle", text));
	if (kind === "status") return theme.fg("error", text);
	return theme.fg("toolOutput", text);
}

/**
 * Rewrites <!--kiro-tool--> marker blocks into width-aware ANSI cards with a
 * Unicode box border and pi's custom-message colors. Display-only — session
 * keeps the marker text while the context hook removes it before model calls.
 *
 * Theme is optional: without it the markers are still stripped so the
 * raw HTML comments never show as a gray paragraph.
 */
export function createKiroToolFrameTransformer(getTheme: () => Theme | undefined): MarkdownTransformer {
	return (markdown, context) => {
		if (context.messageType === "user") return markdown;
		if (!markdown.includes(KIRO_TOOL_FRAME_PREFIX)) return markdown;

		let theme: Theme | undefined;
		try {
			theme = getTheme();
		} catch {
			theme = undefined;
		}

		const width = Math.max(8, context.availableWidth - 2);

		return markdown.replace(nativeToolFrameRegex(), (_match, inner: string) => {
			const lines = inner.split(/\r?\n/).map((line) => line.replace(/\t/g, "   ").trimEnd());
			const bg = backgroundFor(lines);
			const borderColor = borderColorFor(lines);
			const innerWidth = Math.max(1, width - 4);
			const horizontal = "─".repeat(width - 2);
			const rendered = [
				paintBackground(theme, bg, paintBorder(theme, borderColor, `╭${horizontal}╮`)),
			];

			for (let i = 0; i < lines.length; i++) {
				const raw = lines[i];
				const kind = i === 0 ? "title" : STATUS_LINE_RE.test(raw) ? "status" : "body";
				for (const wrapped of wrapTextWithAnsi(raw, innerWidth)) {
					const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(wrapped)));
					const row =
						paintBorder(theme, borderColor, "│ ") +
						paintContent(theme, wrapped, kind) +
						pad +
						paintBorder(theme, borderColor, " │");
					rendered.push(paintBackground(theme, bg, row));
				}
			}

			rendered.push(paintBackground(theme, bg, paintBorder(theme, borderColor, `╰${horizontal}╯`)));
			// Hard break, not a blank paragraph: marked turns "  \n" into <br>.
			return `\n\n${rendered.join("  \n")}\n\n`;
		});
	};
}
