// Test: mid-stream usage refresh (onMetadata) and estimateUsage purity.
// Run: test/run-all.sh test/session-stream-metadata.test.ts

// Keep session.ts's persistence import hermetic before it loads.
process.env.XDG_DATA_HOME ??= "/tmp/kiro-acp-test-data";

import { tmpdir } from "node:os";
import { AcpSession } from "../session.ts";
import { estimateUsage } from "../helpers.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`✗ ${label}\n  expected: ${e}\n  actual:   ${a}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

// ── estimateUsage is a pure recompute ────────────────────────────────────────

function sampleOutput(text: string): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    model: "test",
    stopReason: "stop",
  };
}

const msg = sampleOutput("x".repeat(400));
const first = estimateUsage(msg, 1000);
// Production writes the estimate back onto the message (stream.ts refreshes
// output.usage on every metadata tick) — reproduce that before recomputing.
msg.usage = first;
const second = estimateUsage(msg, 1000);
assertEqual(first, second, "estimateUsage called twice yields identical usage (no accumulation)");
assert(msg.content.length === 1 && msg.content[0].text === "x".repeat(400), "recomputing leaves content untouched");
assert(first.output === 100, "output tokens = chars/4 (400 chars → 100)");
assertEqual(first.totalTokens, 100, "totalTokens defaults to output tokens without metadata");
assertEqual(first.input, 0, "input is 0 without reported context");

// Repeated refreshes on the same output must never grow the estimate.
let peak = 0;
for (let i = 0; i < 5; i++) {
  const u = estimateUsage(msg, 1000);
  peak = Math.max(peak, u.totalTokens);
}
assertEqual(peak, 100, "N refreshes do not inflate the estimate");

// ── metadata reporting feeds the estimate ────────────────────────────────────

const fromContext = estimateUsage(msg, 1_000_000, { contextUsed: 50_000 } as any);
assert(fromContext.totalTokens === 50_000, "contextUsed overrides the char-based floor");
assert(fromContext.input === 49_900, "input = total - output");

const fromPercent = estimateUsage(msg, 1_000_000, { contextUsagePercentage: 10 } as any);
assert(fromPercent.totalTokens === 100_000, "contextUsagePercentage × contextWindow used when contextUsed absent");

const negative = estimateUsage(msg, 1000, { contextUsed: -5 } as any);
assert(negative.totalTokens === 100, "negative contextUsed clamps to the char-based floor");

// ── contextBaseline turns the cumulative contextUsed snapshot into a
// per-turn delta, so summing usage.input across turns (as pi's status bar
// does) does not double count context already reported in earlier turns ──

const turn1 = estimateUsage(msg, 1_000_000, { contextUsed: 50_000 } as any, 0);
assert(turn1.totalTokens === 50_000, "first turn: no baseline yet, totalTokens = raw contextUsed");

// Turn 2 starts from the 50k the previous turn reached; kiro-cli now reports
// a cumulative 80k (30k of genuinely new context since turn 1).
const turn2 = estimateUsage(msg, 1_000_000, { contextUsed: 80_000 } as any, 50_000);
assert(turn2.totalTokens === 30_000, "turn 2 totalTokens is the delta above the baseline (max with this turn's output)");
assert(turn2.input === 30_000 - turn2.output, "turn 2 input is the delta minus this turn's own output tokens");

// A turn with no context growth (baseline caught all of it already) must not
// go negative — it floors at the char-based estimate.
const turn3 = estimateUsage(msg, 1_000_000, { contextUsed: 80_000 } as any, 80_000);
assert(turn3.totalTokens === 100, "turn 3 with zero delta floors at the char-based output estimate");
assert(turn3.input === 0, "turn 3 input is 0 when the baseline already covers the reported contextUsed");

// ── session.onMetadata fires on _kiro.dev/metadata updates ───────────────────
// stream.ts assigns session.onMetadata so partial frames carry live usage.

const session = new AcpSession(tmpdir());
session.acpSessionId = "acp-1";

let received: any = null;
session.onMetadata = (m) => {
  received = m;
};
(session as any).handleMetadata({ sessionId: "acp-1", contextUsagePercentage: 42 });
assert(received !== null, "onMetadata fires on a metadata update for the session");
assert(received.contextUsagePercentage === 42, "handler receives merged session metadata");

// ── handleMetadata swallows handler errors ───────────────────────────────────
// session.ts wraps the onMetadata invocation in try/catch so a broken
// usage-refresh handler can never break the stream.

const session2 = new AcpSession(tmpdir());
session2.acpSessionId = "acp-1";
let calls = 0;
session2.onMetadata = () => {
  calls++;
  throw new Error("boom");
};
let escaped = false;
try {
  (session2 as any).handleMetadata({ sessionId: "acp-1" });
} catch {
  escaped = true;
}
assert(!escaped, "handler error does not escape handleMetadata");
assert(calls === 1, "handler was invoked exactly once");

// ── foreign session updates are ignored ──────────────────────────────────────

const session3 = new AcpSession(tmpdir());
session3.acpSessionId = "acp-1";
let foreign = 0;
session3.onMetadata = () => {
  foreign++;
};
(session3 as any).handleMetadata({ sessionId: "acp-other" });
assert(foreign === 0, "metadata for a different sessionId does not reach the handler");

console.log("\nAll session-stream-metadata checks passed.");
