// Test: streamKiroAcp streams text from a real Kiro ACP session.
// Run: npm test -- test/stream.test.ts

import { test } from "vitest";
import { SessionManager } from "../src/session-manager.ts";
import { streamKiroAcp } from "../src/stream.ts";
import { assert, kiroContext, kiroModel } from "./support.ts";

const sessionManager = new SessionManager();

test("streamKiroAcp streams text from a real Kiro ACP session", async () => {
  const model = kiroModel();

  const context = kiroContext("Say 'hello world' and nothing else.");

  try {
    const pi = { getAllTools: () => [], getActiveTools: () => [] } as any;
    const stream = streamKiroAcp(pi, sessionManager, model, context, {});
    let textContent = "";
    let gotStart = false;
    let gotDone = false;
    let stopReason = "";

    for await (const event of stream) {
      if (event.type === "start") gotStart = true;
      if (event.type === "text_delta") textContent += (event as any).delta;
      if (event.type === "done") {
        gotDone = true;
        stopReason = (event as any).reason;
      }
    }

    assert(gotStart, "expected start event");
    console.log("✓ start event received");
    assert(gotDone, "expected done event");
    console.log("✓ done event received");
    assert(
      textContent.length > 0,
      `expected non-empty text, got: ${textContent.slice(0, 200)}`,
    );
    console.log(`✓ text streamed: "${textContent.trim().slice(0, 80)}"`);
    assert(
      stopReason === "stop",
      `expected stopReason "stop", got ${stopReason}`,
    );
    console.log(`✓ stopReason: ${stopReason}`);
    console.log("✓ stream test passed");
  } finally {
    await sessionManager.stopAllSessions();
  }
});
