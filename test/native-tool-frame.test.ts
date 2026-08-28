// Test: marker-block emission for native Kiro tools + transformer restyling.
// Run: test/run-all.sh test/native-tool-frame.test.ts
// (the runner resolves `marked` and pi packages from pi's own node_modules)

import { marked } from "marked";
import { KIRO_TOOL_FRAME_PREFIX, nativeToolFrame, stripNativeToolFrames } from "../native-tool-frame.ts";
import { createKiroToolFrameTransformer } from "../tool-frame-transformer.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

function lexTypes(src: string): string[] {
	return marked.lexer(src).map((t) => t.type);
}

// A minimal fake theme producing the same SGR shape as the real one.
type FakeTheme = Parameters<Parameters<typeof createKiroToolFrameTransformer>[0]>[0];
function fakeTheme(): FakeTheme {
	const wrap = (code: string, reset: string) => (text: string) => `\x1b[${code}${text}\x1b[${reset}`;
	return {
		bold: wrap("1m", "22m"),
		italic: wrap("3m", "23m"),
		fg: (color: string, text: string) => `\x1b[38;5;${hash(color)}m${text}\x1b[39m`,
		bg: (color: string, text: string) => `\x1b[48;5;${hash(color)}m${text}\x1b[49m`,
	} as unknown as FakeTheme;
}
function hash(s: string): number {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 200;
	return h;
}

const frame = nativeToolFrame("Running: echo hello", "hello\n", "completed");
assert(frame.startsWith(`${KIRO_TOOL_FRAME_PREFIX}\n`), "starts with the marker prefix");
assert(frame.includes("<!--/kiro-tool-->"), "ends with the end marker");
assert(frame.includes("🔧 Running: echo hello"), "includes the title row");
assert(frame.includes("hello"), "includes the body");
assert(!frame.includes("completed"), "successful status is omitted");
assert(stripNativeToolFrames(`before\n${frame}\nafter`) === "before\n\nafter", "display card is stripped from model context");
assert(stripNativeToolFrames("plain assistant text") === "plain assistant text", "plain assistant text survives stripping");

const failed = nativeToolFrame("cat /nope", "no such file", "failed");
assert(failed.includes("[failed]"), "failed status is shown");

// Transformer restyles the marker block.
const transform = createKiroToolFrameTransformer(fakeTheme);
const ctx = { messageType: "assistant-thinking" as const, isStreaming: false, availableWidth: 80 };
const styled = transform(failed, ctx);
assert(!styled.includes("<!--kiro-tool-->"), "transformer strips the start marker");
assert(!styled.includes("<!--/kiro-tool-->"), "transformer strips the end marker");
assert(styled.includes("\x1b[48;5;"), "output embeds background SGR codes");
assert(styled.includes("cat /nope"), "keeps the title text");
assert(styled.includes("no such file"), "keeps the body text");
assert(styled.includes("\\[failed\\]"), "keeps the status line (escaped)");
assert(styled.includes("╭") && styled.includes("╮") && styled.includes("╰") && styled.includes("╯"), "draws a full box border");
assert(styled.includes("│ ") && styled.includes(" │"), "draws left and right borders");
assert(styled.includes("  \n"), "rows joined by markdown hard breaks, not blank paragraphs");
assert(!/nope.*\n\n.*no such file/s.test(styled), "no blank line between title and body");

// Assistant text and thinking without markers pass through untouched.
const plain = transform("just **thinking** out loud", ctx);
assert(plain === "just **thinking** out loud", "plain thinking is untouched");
assert(!transform(failed, { ...ctx, messageType: "assistant" }).includes(KIRO_TOOL_FRAME_PREFIX), "assistant text also restyles markers (thinking can be mis-typed)");
assert(transform(failed, { ...ctx, messageType: "user" }) === failed, "user text is untouched");
assert(transform(failed, ctx) === styled, "transformer is pure");

const narrow = transform(nativeToolFrame("A long tool title that must wrap", "long-body-value-that-must-wrap", "completed"), { ...ctx, availableWidth: 20 });
assert(narrow.trim().split("  \n").length > 4, "long title and body wrap inside the border");
assert(narrow.match(/│ /g)?.length === narrow.match(/ │/g)?.length, "every wrapped row keeps both side borders");

// Marker body keeps arbitrary lines verbatim (no markdown eating).
const nested = nativeToolFrame("Reading README.md", "```js\ncode\n```\n# heading\n---", "completed");
const nestedStyled = transform(nested, ctx);
assert(nestedStyled.includes("\\`\\`\\`js"), "fence line survives (escaped)");
assert(nestedStyled.includes("# heading"), "heading line survives");
assert(nestedStyled.includes("\\-\\-\\-"), "hr line survives (escaped)");

// No theme: still strip markers so they never show as a gray paragraph.
const noTheme = createKiroToolFrameTransformer(() => undefined)(failed, ctx);
assert(!noTheme.includes("<!--kiro-tool-->"), "without theme the start marker is still stripped");
assert(noTheme.includes("cat /nope"), "without theme the title text remains");

// Two tools in a row are both restyled.
const both = transform(nativeToolFrame("tool A", "a", "completed") + nativeToolFrame("tool B", "b", "completed"), ctx);
assert(!both.includes(KIRO_TOOL_FRAME_PREFIX), "consecutive tools both restyled");

console.log("✓ native-tool-frame tests passed");
