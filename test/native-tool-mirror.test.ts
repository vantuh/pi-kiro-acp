// Test: native Kiro tool mirroring — event ordering, abort flush, concurrency.
// Run: test/run-all.sh test/native-tool-mirror.test.ts

import { createNativeToolMirror } from "../native-tool-mirror.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

/** Records the hook calls in order, the way stream.ts would drive the stream. */
function harness() {
  const calls: string[] = [];
  const mirror = createNativeToolMirror({
    pushText: (delta) => calls.push(`push:${delta.replace(/\n/g, "\\n")}`),
    endText: () => calls.push("endText"),
    endThinking: () => calls.push("endThinking"),
    setStatus: (text) => calls.push(`status:${text ?? "(cleared)"}`),
  });
  return { calls, mirror };
}

const start = (id: string, title: string, meta?: unknown) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  _meta: meta,
});
const chunk = (id: string, text: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  content: [{ content: { text } }],
});
const finish = (id: string, status: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status,
});

// A finished tool: status set on start, one framed block on completion.
{
  const { calls, mirror } = harness();
  mirror.update(start("t1", "Reading app.ts"));
  assert(
    calls.length === 1 && calls[0] === "status:🔧 Reading app.ts",
    "start only sets the footer status",
  );

  mirror.update(chunk("t1", "line one\n"));
  mirror.update(chunk("t1", "line two"));
  assert(
    calls.length === 1,
    "body chunks emit nothing until the tool finishes",
  );

  mirror.update(finish("t1", "completed"));
  const pushes = calls.filter((c) => c.startsWith("push:"));
  assert(pushes.length === 1, "exactly one push per finished tool");
  assert(
    pushes[0].includes("line one") && pushes[0].includes("line two"),
    "streamed chunks are concatenated",
  );
  assert(
    calls.slice(1, 5).join(",") ===
      "endThinking,endText," + pushes[0] + ",endText",
    "the card gets its own normal text block",
  );
  assert(
    calls[calls.length - 1] === "status:(cleared)",
    "footer status is cleared when nothing is running",
  );
}

// pi_host-forwarded tools render via real pi execution and must not be mirrored.
{
  const { calls, mirror } = harness();
  mirror.update(
    start("t1", "pi_host tool", { kiro: { mcpServerName: "pi_host" } }),
  );
  mirror.update(chunk("t1", "output"));
  mirror.update(finish("t1", "completed"));
  assert(calls.length === 0, "mcpServerName tools are ignored entirely");
}

// Two overlapping tools must produce two separate, non-nested blocks.
{
  const { calls, mirror } = harness();
  mirror.update(start("a", "tool A"));
  mirror.update(start("b", "tool B"));
  mirror.update(chunk("a", "body A"));
  mirror.update(chunk("b", "body B"));
  mirror.update(finish("a", "completed"));
  mirror.update(finish("b", "completed"));

  const pushes = calls.filter((c) => c.startsWith("push:"));
  assert(pushes.length === 2, "each tool gets its own block");
  assert(
    pushes[0].includes("tool A") && pushes[0].includes("body A"),
    "block A carries only A's body",
  );
  assert(
    pushes[1].includes("tool B") && pushes[1].includes("body B"),
    "block B carries only B's body",
  );
  assert(
    calls.filter((c) => c === "status:(cleared)").length === 1,
    "footer status is cleared once, after the last tool",
  );
  const clearedAt = calls.indexOf("status:(cleared)");
  assert(
    clearedAt > calls.lastIndexOf(pushes[1]) - 2,
    "footer status survives while a tool is still running",
  );
}

// An interrupted turn must not silently drop in-flight tools.
{
  const { calls, mirror } = harness();
  mirror.update(start("a", "tool A"));
  mirror.update(chunk("a", "partial output"));
  mirror.update(start("b", "tool B"));
  mirror.flush();

  const pushes = calls.filter((c) => c.startsWith("push:"));
  assert(pushes.length === 2, "flush emits a block for every in-flight tool");
  assert(
    pushes.every((p) => p.includes("[aborted]")),
    "in-flight tools are marked aborted",
  );
  assert(
    pushes[0].includes("partial output"),
    "partial output collected so far is kept",
  );
  assert(
    calls[calls.length - 1] === "status:(cleared)",
    "flush clears the footer status",
  );

  const before = calls.length;
  mirror.flush();
  assert(
    calls.length === before + 1,
    "a second flush emits no blocks, only the footer-status clear",
  );
}

// Malformed / unknown updates must not throw or leak.
{
  const { calls, mirror } = harness();
  mirror.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "ghost",
    status: "completed",
  });
  mirror.update({ sessionUpdate: "tool_call" });
  mirror.update(start("t1", "titleless tool"));
  mirror.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    content: "not an array",
  });
  mirror.update(finish("t1", "failed"));

  const pushes = calls.filter((c) => c.startsWith("push:"));
  assert(pushes.length === 1, "unknown ids and id-less updates are ignored");
  assert(pushes[0].includes("[failed]"), "failed status reaches the block");
}

// Falls back to the Kiro tool name when no title is given.
{
  const { calls, mirror } = harness();
  mirror.update({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    _meta: { kiro: { toolName: "grepSearch" } },
  });
  mirror.update(finish("t1", "completed"));
  assert(
    calls[0] === "status:🔧 grepSearch",
    "toolName is used as the title fallback",
  );
}

console.log("✓ native-tool-mirror tests passed");



// frame hook: child/headless sessions swap the HTML-comment card for a plain
// visible one-liner.
{
  const calls: string[] = [];
  const mirror = createNativeToolMirror({
    pushText: (delta) => calls.push(`push:${delta.replace(/\n/g, "\\n")}`),
    endText: () => calls.push("endText"),
    endThinking: () => calls.push("endThinking"),
    setStatus: () => {},
    frame: (title, _body, status) =>
      `🔧 ${title}${status === "completed" ? " ✓" : ` [${status}]`}`,
  });
  mirror.update(start("t9", "Reading auth.ts"));
  mirror.update(chunk("t9", "export const x = 1"));
  mirror.update(finish("t9", "completed"));
  const pushed = calls.filter((c) => c.startsWith("push:"));
  assert(
    pushed.length === 1 && pushed[0] === "push:🔧 Reading auth.ts ✓",
    `frame hook renders a visible one-liner, got: ${pushed[0]}`,
  );
  assert(!pushed[0].includes("export const x"), "body is omitted in plain mode");
}
