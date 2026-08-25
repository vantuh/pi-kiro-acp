// Test: markdown-safe rendering of native Kiro tools as thinking blocks.
// Run: test/run-all.sh test/native-tool-frame.test.ts
// (the runner resolves `marked` and pi packages from pi's own node_modules)

import { marked } from "marked";
import { nativeToolFrame } from "../native-tool-frame.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

/** The whole block must lex as a single code token, never hr/heading/paragraph. */
function lexTypes(src: string): string[] {
	return marked.lexer(src).map((t) => t.type);
}

const frame = nativeToolFrame("Running: echo hello", "hello\n", "completed");
assert(frame.includes("🔧 Running: echo hello"), "includes the title row");
assert(frame.includes("hello"), "includes the body");
assert(!frame.includes("completed"), "successful status is omitted");
assert(JSON.stringify(lexTypes(frame)) === '["code"]', "renders as one code block");

const failed = nativeToolFrame("cat /nope", "no such file", "failed");
assert(failed.includes("[failed]"), "failed status is shown");
assert(JSON.stringify(lexTypes(failed)) === '["code"]', "failed frame is still one code block");

// Tool output containing its own markdown must not escape the block.
const nested = nativeToolFrame("Reading README.md", "```js\ncode\n```\n# heading\n---", "completed");
assert(JSON.stringify(lexTypes(nested)) === '["code"]', "``` fences and hr in body cannot break out");

const evil = nativeToolFrame("Reading x", "~~~~\nevil\n   ~~~~~~", "completed");
assert(JSON.stringify(lexTypes(evil)) === '["code"]', "tilde lines in body cannot close the fence");
assert(evil.includes("~~~~\nevil"), "body tilde lines are preserved verbatim");
assert(evil.startsWith("~~~~~~~\n"), "fence grows past the longest tilde run in the body");

// Two tools in a row stay two separate blocks.
const both = nativeToolFrame("tool A", "a", "completed") + nativeToolFrame("tool B", "b", "completed");
assert(JSON.stringify(lexTypes(both)) === '["code","code"]', "consecutive tools are separate blocks");

console.log("✓ native-tool-frame tests passed");
