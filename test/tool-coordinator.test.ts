// Test: suspended Kiro-to-Pi handoff state machine.
// Run: jiti test/tool-coordinator.test.ts

import { KiroToolCoordinator } from "../tool-coordinator.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
	const PREFIX = "s-abcd1234-";
	const coordinator = new KiroToolCoordinator(PREFIX);
	coordinator.startPrompt();

	const resultPromise = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: { role: "tester", message: "hello" },
		signal: new AbortController().signal,
	});
	const handoff = await coordinator.waitForHandoff();
	assert(handoff.piToolCallId === `${PREFIX}1`, "handoff gets a prefixed monotonic Pi tool call id");
	assert(handoff.piToolCallId.startsWith("s-abcd1234-"), "piToolCallId carries the session prefix");
	assert(handoff.piName === "peer_send" && handoff.kiroName === "peer_send", "handoff preserves both tool names");
	assert(handoff.arguments.message === "hello", "handoff preserves arguments");
	assert(coordinator.resolveToolResult("wrong", "peer_send", { content: [{ type: "text", text: "no" }] }) === false, "mismatched tool result is ignored");
	assert(coordinator.resolveToolResult(handoff.piToolCallId, "peer_send", { content: [{ type: "text", text: "sent" }] }), "matching tool result resolves the pending call");
	const result = await resultPromise;
	assert(result.content[0]?.text === "sent", "resolved result returns MCP content");

	const nextHandoff = coordinator.waitForHandoff();
	const nextResult = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: new AbortController().signal,
	});
	const next = await nextHandoff;
	assert(next.piToolCallId === `${PREFIX}2` && next.piToolCallId !== handoff.piToolCallId, "reused MCP ids still get distinct Pi ids");
	assert(coordinator.resolveToolResult(next.piToolCallId, "peer_send", { content: [{ type: "text", text: "second" }] }), "second matching result resolves independently");
	assert((await nextResult).content[0]?.text === "second", "second result matches the second Pi id");

	// Verify cross-session isolation: different prefix → different piToolCallId namespace
	const otherCoordinator = new KiroToolCoordinator("s-other999-");
	otherCoordinator.startPrompt();
	const otherResult = otherCoordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: new AbortController().signal,
	});
	const otherHandoff = await otherCoordinator.waitForHandoff();
	assert(otherHandoff.piToolCallId === "s-other999-1", "different session prefix produces different piToolCallId");
	assert(otherHandoff.piToolCallId !== handoff.piToolCallId, "different sessions never collide on piToolCallId");
	otherCoordinator.resolveToolResult(otherHandoff.piToolCallId, "peer_send", { content: [{ type: "text", text: "isolated" }] });
	assert((await otherResult).content[0]?.text === "isolated", "cross-session resolution is isolated");
	otherCoordinator.finishPrompt();

	// Aborting the call's signal (bridge does this on client disconnect) must
	// reject the suspended pending call rather than leave it hanging.
	const abortController = new AbortController();
	const abortedResult = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: abortController.signal,
	});
	const abortedHandoff = await coordinator.waitForHandoff();
	abortController.abort();
	await abortedResult.then(() => assert(false, "aborted call must not resolve"), () => console.log("✓ aborting the signal rejects the pending call"));
	assert(coordinator.resolveToolResult(abortedHandoff.piToolCallId, "peer_send", { content: [{ type: "text", text: "stale" }] }) === false, "a late result cannot resolve an already-aborted call");

	// A signal already aborted before dispatch is rejected without suspending.
	const preAborted = new AbortController();
	preAborted.abort();
	await coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: preAborted.signal,
	}).then(() => assert(false, "pre-aborted call must not resolve"), () => console.log("✓ a pre-aborted signal is rejected before dispatch"));

	const cancelledResult = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: new AbortController().signal,
	});
	await coordinator.waitForHandoff();
	coordinator.rejectPending(new Error("cancelled"));
	await cancelledResult.then(() => assert(false, "rejected pending call must not resolve"), () => console.log("✓ rejected pending call propagates an error"));

	coordinator.finishPrompt();
	await coordinator.waitForHandoff().then(() => assert(false, "finished prompt must not yield a handoff"), () => console.log("✓ finished prompt rejects future handoff waits"));

	console.log("✓ all coordinator tests passed");
}

main().catch((error) => {
	console.error(`✗ coordinator test failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
