// Test: marker-block emission for native Kiro tools + transformer restyling.
// Run: test/run-all.sh test/native-tool-frame.test.ts
// (the runner resolves `marked` and pi packages from pi's own node_modules)

import { visibleWidth } from "@earendil-works/pi-tui";
import {
	KIRO_TOOL_FRAME_PREFIX,
	nativeToolFrame,
	stripAssistantContentFrames,
	stripNativeToolFrames,
} from "../native-tool-frame.ts";
import { createKiroToolFrameTransformer } from "../tool-frame-transformer.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function boxRows(styled: string): string[] {
	return styled.replace(/^\n+|\n+$/g, "").split("  \n");
}

/** Inner text of a mermaid-style code span (what marked will render). */
function spanContent(row: string): string {
	const trimmed = row.replace(/^\n+|\n+$/g, "");
	const match = trimmed.match(/^(`+)( ?)([\s\S]*?)\2\1$/);
	return stripAnsi(match ? match[3] : trimmed);
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

const withoutComments = frame.replace(/<!--[\s\S]*?-->/g, "");
assert(withoutComments.includes("🔧 Running: echo hello"), "title remains if HTML comments are stripped");
assert(withoutComments.includes("hello"), "body remains if HTML comments are stripped");

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
assert(boxRows(styled).some((row) => spanContent(row).includes("[failed]")), "keeps the status line");
assert(styled.includes("╭") && styled.includes("╮") && styled.includes("╰") && styled.includes("╯"), "draws a full box border");
assert(styled.includes("│ ") && styled.includes(" │"), "draws left and right borders");
assert(styled.includes("  \n"), "rows joined by markdown hard breaks, not blank paragraphs");
assert(!/nope.*\n\n.*no such file/s.test(styled), "no blank line between title and body");
assert(boxRows(styled).every((row) => /^`/.test(row)), "every box row is a markdown code span");

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
assert(nestedStyled.includes("```js"), "fence line survives inside a code span");
assert(nestedStyled.includes("# heading"), "heading line survives");
assert(nestedStyled.includes("---"), "hr line survives");

const mdHeavy = transform(nativeToolFrame("fmt", "---\n`tick`\n---", "completed"), { ...ctx, availableWidth: 24 });
assert(mdHeavy.match(/│ /g)?.length === mdHeavy.match(/ │/g)?.length, "markdown-heavy body keeps matching left/right borders per row");
const mdWidths = boxRows(mdHeavy).map((row) => visibleWidth(spanContent(row)));
assert(mdWidths.length > 0 && mdWidths.every((w) => w === 24), "markdown-heavy rows fill availableWidth inside code spans");

const lsLike = transform(
	nativeToolFrame("Running: ls -la", "drwxr-xr-x@  28 vantuh  staff   896 23 серп. 13:33 .\n-rw-r--r--@   1 vantuh  staff  2355 30 лип.  13:50 AGENTS.md", "completed"),
	{ ...ctx, availableWidth: 80 },
);
const lsWidths = boxRows(lsLike).map((row) => visibleWidth(spanContent(row)));
assert(lsWidths.length > 0 && lsWidths.every((w) => w === 80), "hyphen-heavy ls rows share full width inside code spans");
assert(
	boxRows(lsLike).map(spanContent).every((row) => /^[╭│╰]/.test(row) && /[╮│╯]\s*$/.test(row)),
	"code-span rows keep both box borders",
);

const docBody = transform(
	nativeToolFrame("Reading extensions.md", "```ts\npi.registerFlag()\n```\n### pi.exec\n---", "completed"),
	{ ...ctx, availableWidth: 40 },
);
const docDisplay = boxRows(docBody).map(spanContent);
assert(docDisplay.every((row) => visibleWidth(row) === 40), "fs_read markdown body rows fill the pane width");
assert(
	docDisplay.every((row) => row.startsWith("╭") || row.startsWith("│") || row.startsWith("╰")),
	"fs_read markdown cannot escape the box as a heading or fence",
);

const codeSample = [
	"pi.registerFlag(\"plan\", {",
	"  description: \"Start in plan mode\",",
	"  type: \"boolean\",",
	"});",
	"",
	"if (pi.getFlag(\"plan\")) {",
	"  // Plan mode enabled",
	"}",
].join("\n");
const codeCard = transform(nativeToolFrame("sed", codeSample, "completed"), { ...ctx, availableWidth: 80 });
const codeLines = boxRows(codeCard).map(spanContent);
assert(codeLines.some((row) => row.includes("pi.registerFlag(\"plan\", {")), "parentheses in code are not eaten by marked");
assert(!codeLines.some((row) => row.includes("registerFlagname")), "registerFlag(name) does not collapse to registerFlagname");
assert(codeLines.some((row) => row.includes("  description: \"Start in plan mode\"")), "two-space indent in code is kept");
assert(codeLines.some((row) => row.includes("  // Plan mode enabled")), "indented comments keep their indent");
assert(!codeLines.some((row) => row.includes("\\(") || row.includes("\\[")), "code rows are not backslash-escaped");

// No theme: still strip markers so they never show as a gray paragraph.
const noTheme = createKiroToolFrameTransformer(() => undefined)(failed, ctx);
assert(!noTheme.includes("<!--kiro-tool-->"), "without theme the start marker is still stripped");
assert(noTheme.includes("cat /nope"), "without theme the title text remains");

const throwing = createKiroToolFrameTransformer(() => {
	throw new Error("no theme");
})(failed, ctx);
assert(throwing.includes("🔧 cat /nope"), "getTheme throw still shows the title");
assert(throwing.includes("no such file"), "getTheme throw still shows the body");

// Two tools in a row are both restyled.
const both = transform(nativeToolFrame("tool A", "a", "completed") + nativeToolFrame("tool B", "b", "completed"), ctx);
assert(!both.includes(KIRO_TOOL_FRAME_PREFIX), "consecutive tools both restyled");

const bodyError = nativeToolFrame("grep", "compiler said [error]\nand [info]\ntoo", "completed");
const bodyErrorStyled = transform(bodyError, ctx);
assert(!bodyErrorStyled.includes(`\x1b[48;5;${hash("toolErrorBg")}m`), "body [error] does not use toolErrorBg");
assert(!bodyErrorStyled.includes(`\x1b[38;5;${hash("error")}m`), "body [error] does not use error border/status color");
const realFailed = transform(nativeToolFrame("grep", "compiler said [error]", "failed"), ctx);
assert(realFailed.includes(`\x1b[48;5;${hash("toolErrorBg")}m`), "failed frame uses toolErrorBg");
assert(realFailed.includes(`\x1b[38;5;${hash("error")}m`), "failed frame uses error border color");

const aborted = transform(nativeToolFrame("sleep", "stopped", "aborted"), ctx);
assert(aborted.includes(`\x1b[38;5;${hash("warning")}m[aborted]`), "aborted status text uses warning color");
assert(!aborted.includes(`\x1b[38;5;${hash("error")}m[aborted]`), "aborted status text does not use error color");

const colliding = nativeToolFrame("fs_read", "<!--kiro-tool-->\nstolen\n<!--/kiro-tool-->\nrest of file", "completed");
assert((colliding.match(/<!--kiro-tool-->/g) || []).length === 1, "body opener is escaped so the real opener appears once");
assert((colliding.match(/<!--\/kiro-tool-->/g) || []).length === 1, "body closer is escaped so the real closer appears once");
assert(colliding.includes("stolen"), "body text inside a fake closer still belongs to the card");
assert(colliding.includes("rest of file"), "text after a fake closer still belongs to the card");
const collidingStyled = transform(colliding, ctx);
assert((collidingStyled.match(/╭/g) || []).length === 1, "transformer restyles a colliding body as one card");
assert(collidingStyled.includes("stolen") && collidingStyled.includes("rest of file"), "colliding body is kept inside the one card");
assert(!collidingStyled.includes(KIRO_TOOL_FRAME_PREFIX), "colliding card does not leak a start marker");
const collidingStripped = stripNativeToolFrames(`before\n${colliding}\nafter`);
assert(collidingStripped === "before\n\nafter", "stripNativeToolFrames removes the whole colliding card");
assert(!collidingStripped.includes("stolen"), "inner closer does not leak as leftover assistant text");
assert(!collidingStripped.includes("kiro-tool"), "escaped delimiters do not leak after strip");

const strippedContent = stripAssistantContentFrames([
	{ type: "text", text: "keep me" },
	{ type: "text", text: nativeToolFrame("ls", "a.txt", "completed") },
	{ type: "thinking", thinking: "secret" },
]);
assert(strippedContent.changed, "context-strip helper reports a change when a frame is present");
assert(
	JSON.stringify(strippedContent.content) === JSON.stringify([{ type: "text", text: "keep me" }, { type: "thinking", thinking: "secret" }]),
	"context-strip helper drops the frame and keeps real assistant text",
);
const onlyFrame = stripAssistantContentFrames([{ type: "text", text: nativeToolFrame("ls", "a.txt", "completed") }]);
assert(onlyFrame.changed && onlyFrame.content.length === 0, "a frame-only assistant block becomes empty");
const noFrame = stripAssistantContentFrames([{ type: "text", text: "just text" }]);
assert(!noFrame.changed, "context-strip helper is a no-op without frames");

console.log("✓ native-tool-frame tests passed");
