// Test: legacy native-tool frame readers — stripping marker blocks and
// one-liner frames from assistant content before it reaches the model.
// Run: test/run-all.sh test/native-tool-frame.test.ts

import {
  KIRO_TOOL_FRAME_PREFIX,
  KIRO_TOOL_FRAME_SUFFIX,
  isNativeToolTextFrameLine,
  nativeToolFrameRegex,
  stripAssistantContentFrames,
  stripNativeToolFrames,
} from "../native-tool-frame.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

/** Literal frame in the exact shape the removed mirror emitted. */
function frame(title: string, body: string, status = "completed"): string {
  const lines = [`🔧 ${title}`];
  if (body) lines.push(body);
  if (status !== "completed") lines.push(`[${status}]`);
  return `${KIRO_TOOL_FRAME_PREFIX}\n${lines.join("\n")}\n${KIRO_TOOL_FRAME_SUFFIX}\n`;
}

// --- frame structure and strip ---
{
  const completed = frame("Running: echo hello", "hello\n");
  assert(
    completed.startsWith(`${KIRO_TOOL_FRAME_PREFIX}\n`),
    "frame opens with the marker prefix",
  );
  assert(
    nativeToolFrameRegex().test(completed),
    "nativeToolFrameRegex matches the emitted frame",
  );
  assert(
    stripNativeToolFrames(`before\n${completed}\nafter`) === "before\n\nafter",
    "stripNativeToolFrames removes the whole card and its trailing newline",
  );
  assert(
    stripNativeToolFrames("plain assistant text") === "plain assistant text",
    "plain assistant text passes through unchanged",
  );
}

// --- statuses ---
{
  const failed = frame("cat /nope", "no such file", "failed");
  const aborted = frame("sleep", "stopped", "aborted");
  assert(nativeToolFrameRegex().test(failed), "failed frame matches");
  assert(nativeToolFrameRegex().test(aborted), "aborted frame matches");
  assert(
    stripNativeToolFrames(`x\n${failed}\ny`) === "x\n\ny",
    "failed card strips",
  );
}

// --- strip is non-greedy: two cards in one text block are both removed ---
{
  const both =
    frame("tool A", "a") + frame("tool B", "b");
  const strippedBoth = stripNativeToolFrames(`before\n${both}after`);
  assert(
    strippedBoth === "before\n\nafter",
    "two adjacent cards are both stripped (non-greedy match)",
  );
}

// --- stripAssistantContentFrames ---
{
  const strippedContent = stripAssistantContentFrames([
    { type: "text", text: "keep me" },
    { type: "text", text: frame("ls", "a.txt") },
  ]);
  assert(strippedContent.changed, "content with a frame reports changed");
  assert(
    strippedContent.content.length === 1 &&
      (strippedContent.content[0] as any).text === "keep me",
    "frame-only text block is dropped",
  );

  const onlyFrame = stripAssistantContentFrames([
    { type: "text", text: frame("ls", "a.txt") },
  ]);
  assert(onlyFrame.changed, "all-frame content reports changed");
  assert(
    onlyFrame.content.length === 0,
    "all-frame content strips to nothing",
  );

  const noFrame = stripAssistantContentFrames([
    { type: "text", text: "plain" },
    { type: "thinking", thinking: "hmm" },
  ]);
  assert(
    !noFrame.changed,
    "content without frames is untouched",
  );

  const mixedText = stripAssistantContentFrames([
    { type: "text", text: `before\n${frame("ls", "a.txt")}\nafter` },
  ]);
  assert(mixedText.changed, "mixed text reports changed");
  assert(
    (mixedText.content[0] as any).text === "before\n\nafter",
    "mixed text keeps the surrounding prose",
  );
}

// --- legacy one-liner text frames ---
{
  const ok = "🔧 read foo ✓\n";
  assert(isNativeToolTextFrameLine(ok), "completed one-liner matches");
  assert(
    isNativeToolTextFrameLine("🔧 cat /nope [failed]\n"),
    "failed one-liner matches",
  );
  assert(
    isNativeToolTextFrameLine("🔧 sleep 30 [aborted]"),
    "aborted one-liner without newline matches",
  );
  assert(
    !isNativeToolTextFrameLine("🔧 read foo\nmore context"),
    "multi-line text is not a one-liner frame",
  );
  assert(
    isNativeToolTextFrameLine("🔧 read foo [in_progress]\n"),
    "any bracket status token matches (defensive)",
  );

  const stripped = stripAssistantContentFrames([
    { type: "text", text: "answer" },
    { type: "text", text: ok },
  ]);
  assert(stripped.changed, "one-liner frame triggers strip");
  assert(
    stripped.content.length === 1,
    "one-liner frame block is dropped",
  );

  // stripNativeToolFrames (text-level) leaves one-liners alone: they are
  // block-scoped, stripped via stripAssistantContentFrames.
  assert(
    stripNativeToolFrames(`before\n${ok}after`) === `before\n${ok}after`,
    "stripNativeToolFrames leaves one-liners alone",
  );
}

console.log("✓ native-tool-frame tests passed");
