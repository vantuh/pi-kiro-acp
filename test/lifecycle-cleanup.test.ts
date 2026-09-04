// Test: per-session bridge isolation and resource cleanup on stop / idle prune.
// Covers Symptom 6 from docs/MCP-UNIFIED-PLAN.md: no cross-session tool-call mixing,
// no leaked HTTP ports.
// Run: test/run-all.sh test/lifecycle-cleanup.test.ts

import { connect } from "node:net";
import { AcpSession } from "../session.ts";
import {
  activeSessionCount,
  pruneIdleSessions,
  routeSession,
  stopAllSessions,
} from "../session-manager.ts";
import { startToolBridge, type ToolBridge } from "../tool-bridge.ts";
import { buildForwardedToolCatalog } from "../tool-catalog.ts";
import type { PendingToolCall, ToolResultInfo } from "../types.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

const catalog = () =>
  buildForwardedToolCatalog(
    [
      {
        name: "web_search",
        description: "search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        sourceInfo: { source: "package" },
      },
    ],
    ["web_search"],
  );

function attachBridge(session: AcpSession): Promise<ToolBridge> {
  return startToolBridge({
    catalog,
    onToolCall: async () => ({ content: [{ type: "text", text: "unused" }] }),
  }).then((bridge) => {
    session.toolBridge = bridge;
    return bridge;
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPortClosed(
  port: number,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isListening(port))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function pendingCall(
  session: AcpSession,
  seq: number,
  toolName: string,
): {
  callId: string;
  settled: Promise<{ result: string; isError?: boolean }>;
} {
  const callId = `${session.id}-${seq}`;
  let resolveFn!: (value: { result: string; isError?: boolean }) => void;
  const settled = new Promise<{ result: string; isError?: boolean }>((r) => {
    resolveFn = r;
  });
  const call: PendingToolCall = {
    callId,
    toolName,
    args: {},
    receivedAt: Date.now(),
    emitted: true,
    resolve: resolveFn,
  };
  session.pendingToolCalls.set(callId, call);
  return { callId, settled };
}

const toolResult = (
  toolCallId: string,
  toolName: string,
  text = "ok",
): ToolResultInfo => ({
  toolCallId,
  toolName,
  text,
  isError: false,
});

async function main(): Promise<void> {
  // --- each session gets its own bridge port and token ---
  const a = new AcpSession("/tmp");
  const b = new AcpSession("/tmp");
  const bridgeA = await attachBridge(a);
  const bridgeB = await attachBridge(b);

  assert(
    bridgeA.port !== bridgeB.port,
    "concurrent sessions listen on different ports",
  );
  assert(
    bridgeA.token !== bridgeB.token,
    "concurrent sessions use different bearer tokens",
  );
  assert(a.id !== b.id, "sessions have distinct ids");
  assert(await isListening(bridgeA.port), "session A bridge is listening");
  assert(await isListening(bridgeB.port), "session B bridge is listening");

  // --- tool-call ids are namespaced per session ---
  const callA = pendingCall(a, 1, "web_search");
  assert(
    callA.callId.startsWith(`${a.id}-`),
    "pending tool call ids carry the session prefix",
  );

  // A result minted by another session must not be matched by name.
  a.deliverToolResults([toolResult(`${b.id}-1`, "web_search")]);
  assert(
    a.pendingToolCalls.size === 1,
    "a foreign-prefixed tool result cannot resolve another session's call",
  );

  // Own-prefixed but unknown id falls back to a unique name match (image-follow-up case).
  a.deliverToolResults([toolResult(`${a.id}-99`, "web_search", "delivered")]);
  const deliveredA = await callA.settled;
  assert(
    deliveredA.result === "delivered",
    "own-prefixed id resolves via unique tool-name match",
  );
  assert(a.pendingToolCalls.size === 0, "resolved calls leave the pending map");

  // matchingToolResults is what routeSession uses to pick a resumption target.
  const callB = pendingCall(b, 1, "web_search");
  assert(
    b.matchingToolResults([toolResult(callB.callId, "web_search")]).length ===
      1,
    "own tool result matches its session",
  );
  assert(
    b.matchingToolResults([toolResult(`${a.id}-1`, "web_search")]).length === 0,
    "foreign tool result matches no session",
  );

  // --- stop() closes the bridge and settles everything in flight ---
  const rejected = new Promise<Error>((resolve) => {
    b.rpcPending.set(1, {
      resolve: () => {},
      reject: resolve,
      timer: null,
      startedAt: Date.now(),
      method: "session/prompt",
    } as any);
  });

  await b.stop();
  const settledB = await callB.settled;
  assert(settledB.isError === true, "pending tool calls are failed on stop");
  assert(
    /Shutting down/.test(settledB.result),
    "stopped calls report shutdown",
  );
  assert(
    /Stopped/.test((await rejected).message),
    "in-flight RPCs are rejected on stop",
  );
  assert(b.toolBridge === null, "stop clears the session's bridge reference");
  assert(await waitForPortClosed(bridgeB.port), "stop closes session B's port");
  assert(
    await isListening(bridgeA.port),
    "stopping one session leaves the other's bridge alive",
  );

  await a.stop();
  assert(await waitForPortClosed(bridgeA.port), "stop closes session A's port");

  // --- idle prune closes bridges of sessions it drops ---
  const routed = await routeSession(
    { messages: [] } as any,
    { cwd: "/tmp" } as any,
  );
  const bridgeC = await attachBridge(routed.session);
  assert(activeSessionCount() >= 1, "routeSession registers the session");
  routed.session.lastUsedAt = Date.now() - 60_000;
  pruneIdleSessions(1000);
  assert(
    await waitForPortClosed(bridgeC.port),
    "pruned idle sessions release their port",
  );

  // --- stopAllSessions leaves nothing behind ---
  const routed2 = await routeSession(
    { messages: [] } as any,
    { cwd: "/tmp" } as any,
  );
  const bridgeD = await attachBridge(routed2.session);
  await stopAllSessions();
  assert(activeSessionCount() === 0, "stopAllSessions empties the registry");
  assert(
    await waitForPortClosed(bridgeD.port),
    "stopAllSessions releases every port",
  );

  console.log("✓ all lifecycle-cleanup tests passed");
}

void main();
