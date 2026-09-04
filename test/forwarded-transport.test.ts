// Test: forwarded tool transport (ADR 0001 amendment 2026-09-04). Kiro has no
// native tools — the agent config exposes only @pi_host, and every bridged
// tools/call lands in pendingToolCalls (session-prefixed id) whose resolution
// maps back to an MCP result for Kiro.
// Run: test/run-all.sh test/forwarded-transport.test.ts

import { readFileSync } from "node:fs";
import { AcpSession } from "../session.ts";
import type { ToolBridgeCall } from "../tool-bridge.ts";

let failed = false;

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    failed = true;
    return;
  }
  console.log(`✓ ${label}`);
}

const session = new AcpSession("/tmp/kiro-acp-forwarded");

{
  (session as any).writeAgentCfg();
  const config = JSON.parse(readFileSync(session.agentConfigPath!, "utf8"));
  assert(
    JSON.stringify(config.tools) === JSON.stringify(["@pi_host"]),
    `agent config tools list only @pi_host (got ${JSON.stringify(config.tools)})`,
  );
  assert(
    JSON.stringify(config.allowedTools) === JSON.stringify(["@pi_host"]),
    "agent config allowedTools list only @pi_host",
  );
  (session as any).removeAgentFiles();
}

{
  const controller = new AbortController();
  const call: ToolBridgeCall = {
    requestId: 7,
    kiroName: "bash",
    piName: "bash",
    arguments: { command: "echo hi" },
    signal: controller.signal,
  };
  const delivered: any[] = [];
  session.onToolCallFromBridge = (pending) => {
    delivered.push(pending);
    pending.resolve({ result: "hi", isError: false });
  };

  const resultPromise: Promise<any> = (session as any).handleBridgeToolCall(
    call,
  );
  assert(delivered.length === 1, "bridged call is handed to the pi stream");
  assert(
    delivered[0]?.toolName === "bash",
    "pending call carries the Pi tool name",
  );
  assert(
    typeof delivered[0]?.callId === "string" &&
      delivered[0].callId.startsWith(`${session.id}-`),
    "pending call id is session-prefixed",
  );
  const result = await resultPromise;
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
    "resolution maps back to a successful MCP result",
  );
  // pi delivers the tool's own result later, as a toolResult message; that is
  // what removes the pending entry (resolve alone only settles the MCP call).
  session.deliverToolResults([
    {
      toolCallId: delivered[0].callId,
      toolName: "bash",
      text: "hi",
      isError: false,
    },
  ]);
  assert(
    session.pendingToolCalls.size === 0,
    "deliverToolResults removes the resolved call",
  );
}

{
  // Aborted before dispatch: answered as an MCP error, never queued.
  const controller = new AbortController();
  controller.abort();
  const result = await (session as any).handleBridgeToolCall({
    requestId: 8,
    kiroName: "read",
    piName: "read",
    arguments: { path: "/tmp/x" },
    signal: controller.signal,
  } satisfies ToolBridgeCall);
  session.pendingToolCalls.clear(); // isolate from the block above
  assert(result.isError === true, "aborted call resolves as an MCP error");
  assert(
    session.pendingToolCalls.size === 0,
    "aborted call never enters pendingToolCalls",
  );
}

if (failed) process.exit(1);
console.log("✓ all forwarded-transport tests passed");
process.exit(0);
