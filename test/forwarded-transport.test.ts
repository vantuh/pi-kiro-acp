// Test: forwarded tool transport (ADR 0001 amendment 2026-09-04). Kiro has no
// native tools — the agent config exposes only @pi_host, and every bridged
// tools/call lands in pendingToolCalls (session-prefixed id) whose resolution
// maps back to an MCP result for Kiro.
// Run: test/run-all.sh test/forwarded-transport.test.ts

import { readFileSync } from "node:fs";
import { AcpSession } from "../session.ts";
import { stableJson } from "../helpers.ts";
import {
  agentConfigFingerprint,
  canRestorePersisted,
} from "../session-persistence.ts";
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
  assert(
    JSON.stringify(config.excludedTools) === JSON.stringify(["@builtin"]),
    "agent config excludedTools strips Kiro builtins (honored on CLI 3+)",
  );
  assert(
    /^[0-9a-f]{64}$/.test(session.agentConfigFingerprint ?? ""),
    "agent config fingerprint is SHA-256 hex",
  );
  (session as any).removeAgentFiles();
}

{
  // The persisted-session gate hashes the semantic config only: the random
  // per-session `name` must not affect resumability, any semantic change must,
  // and key order must not matter (canonical serialization).
  const semantic = {
    tools: ["@pi_host"],
    allowedTools: ["@pi_host"],
    excludedTools: ["@builtin"],
    includeMcpJson: false,
    mcpServers: {},
    prompt: "p",
  };
  assert(
    agentConfigFingerprint(semantic) === agentConfigFingerprint(semantic),
    "same semantic config yields the same fingerprint",
  );
  assert(
    agentConfigFingerprint({ name: "pi-kiro-aaaa", ...semantic }) ===
      agentConfigFingerprint({ name: "pi-kiro-bbbb", ...semantic }),
    "random per-session name does not affect the fingerprint",
  );
  assert(
    agentConfigFingerprint(semantic) !==
      agentConfigFingerprint({ ...semantic, tools: ["@pi_host", "@other"] }),
    "a config change changes the fingerprint",
  );
}

{
  // Restore gate: history match AND config match; records without a config
  // fingerprint predate the gate and never resume.
  const record = {
    version: 1 as const,
    kiroSessionId: "k",
    historyFingerprint: "h",
    agentConfigFingerprint: "c",
    createdAt: 0,
    lastUsed: Date.now(),
  };
  assert(
    canRestorePersisted(record, "h", "c").canUse,
    "matching history and config allows restore",
  );
  assert(
    !canRestorePersisted(record, "h", "other").configMatch,
    "config fingerprint mismatch refuses restore",
  );
  assert(
    !canRestorePersisted(
      { ...record, agentConfigFingerprint: undefined },
      "h",
      "c",
    ).canUse,
    "record without a config fingerprint never resumes",
  );
  assert(
    !canRestorePersisted(record, undefined, "c").canUse,
    "missing history fingerprint never resumes",
  );
  assert(
    !canRestorePersisted(null, "h", "c").canUse,
    "no record never resumes",
  );
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
  // Aborted before dispatch: answered as an MCP error, never queued. A fresh
  // dispatch spy is attached (replacing the previous block's handler) so a
  // regression of the abort-before-dispatch guard fails these assertions
  // instead of being masked by a stale handler or a map clear().
  const controller = new AbortController();
  controller.abort();
  const delivered: any[] = [];
  session.onToolCallFromBridge = (pending) => {
    delivered.push(pending);
    pending.resolve({ result: "", isError: false });
  };
  const result = await (session as any).handleBridgeToolCall({
    requestId: 8,
    kiroName: "read",
    piName: "read",
    arguments: { path: "/tmp/x" },
    signal: controller.signal,
  } satisfies ToolBridgeCall);
  assert(
    delivered.length === 0,
    "aborted call is never handed to the pi stream",
  );
  assert(result.isError === true, "aborted call resolves as an MCP error");
  assert(
    session.pendingToolCalls.size === 0,
    "aborted call never enters pendingToolCalls",
  );
}

{
  // Abandoned-call dedup is single-use: after one repeat has been answered
  // with the already-running note, the record is dropped so the next
  // identical call is dispatched normally instead of suppressed for the
  // whole TTL (matters for builtin calls like read/ls/bash that repeat).
  // Mirrors the module-private callFingerprint(toolName, args).
  const fingerprint = `ls\u0000${stableJson({ path: "." })}`;
  // rememberAbandonedToolCall only records on a started session.
  (session as any).started = true;
  (session as any).rememberAbandonedToolCall(fingerprint, "old-id", "ls");
  const makeCall = () =>
    (session as any).handleBridgeToolCall({
      requestId: 0,
      kiroName: "ls",
      piName: "ls",
      arguments: { path: "." },
      signal: new AbortController().signal,
    } satisfies ToolBridgeCall);
  const firstRepeat = await makeCall();
  assert(
    firstRepeat.isError === true &&
      firstRepeat.content[0]?.text.includes("already running"),
    "repeat of an abandoned call is answered with the already-running note",
  );
  assert(
    (session as any).abandonedToolCalls.size === 0,
    "answering the repeat consumes the dedup record",
  );
  const dispatched: any[] = [];
  session.onToolCallFromBridge = (pending) => {
    dispatched.push(pending);
    pending.resolve({ result: "ok", isError: false });
  };
  await makeCall();
  assert(
    dispatched.length === 1,
    "next identical call after the note is dispatched normally",
  );
}

if (failed) process.exit(1);
console.log("✓ all forwarded-transport tests passed");
process.exit(0);
