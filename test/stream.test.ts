// Test: streamKiroAcp streams text from a real Kiro ACP session.
// Run: jiti test/stream.test.ts

import type { Context, Model } from "@earendil-works/pi-ai";
import { streamKiroAcp } from "../stream.ts";
import { stopAllSessions } from "../session-manager.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main() {
	const model: Model<any> = {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6 (Kiro)",
		api: "kiro-acp-api",
		provider: "kiro-acp",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 16384,
	};

	const context: Context = {
		messages: [
			{ role: "user", content: "Say 'hello world' and nothing else.", timestamp: Date.now() },
		],
		systemPrompt: "",
		tools: [],
	};

	try {
		const stream = streamKiroAcp(model, context, {});
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
		assert(textContent.length > 0, `expected non-empty text, got: ${textContent.slice(0, 200)}`);
		console.log(`✓ text streamed: "${textContent.trim().slice(0, 80)}"`);
		assert(stopReason === "stop", `expected stopReason "stop", got ${stopReason}`);
		console.log(`✓ stopReason: ${stopReason}`);
		console.log("✓ stream test passed");
	} finally {
		await stopAllSessions();
	}
}

main().catch((e) => {
	console.error("✗ test failed:", e);
	process.exitCode = 1;
	return stopAllSessions().catch(() => {});
});
