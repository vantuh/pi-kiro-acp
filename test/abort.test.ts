// Test: streamKiroAcp handles AbortSignal without hanging.
// Run: test/run-all.sh test/abort.test.ts

import { streamKiroAcp } from "../stream.ts";
import { stopAllSessions } from "../session-manager.ts";
import { assert, kiroContext, kiroModel } from "./support.ts";

async function main() {
  const model = kiroModel();

  const context = kiroContext(
    "Count from 1 to 100 slowly, one number per word. Do not stop early.",
  );

  try {
    const ac = new AbortController();
    const pi = { getAllTools: () => [], getActiveTools: () => [] } as any;
    const stream = streamKiroAcp(pi, model, context, { signal: ac.signal });
    const eventTypes: string[] = [];
    let gotDelta = false;
    let streamEnded = false;

    const consume = (async () => {
      for await (const event of stream) {
        eventTypes.push(event.type);
        if (
          (event.type === "text_delta" || event.type === "thinking_delta") &&
          !gotDelta
        ) {
          gotDelta = true;
          ac.abort();
        }
      }
      streamEnded = true;
    })();

    // Fallback abort if no delta arrives quickly
    const fallback = setTimeout(() => ac.abort(), 5000);

    await Promise.race([
      consume,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("stream hung after abort")), 30000),
      ),
    ]);
    clearTimeout(fallback);

    console.log("Events received:", eventTypes);
    assert(streamEnded, "expected stream to end after abort");
    console.log("✓ stream ended without hanging");
    console.log("✓ abort test passed");
  } finally {
    await stopAllSessions();
  }
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exitCode = 1;
  return stopAllSessions().catch(() => {});
});
