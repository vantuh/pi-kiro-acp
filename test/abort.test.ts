// Test: streamKiroAcp handles AbortSignal without hanging.
// Run: jiti test/abort.test.ts

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
			{
				role: "user",
				content: "Count from 1 to 100 slowly, one number per word. Do not stop early.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "",
		tools: [],
	};

	try {
		const ac = new AbortController();
		const stream = streamKiroAcp(model, context, { signal: ac.signal });
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
