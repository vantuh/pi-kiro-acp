// Test: a tools/call that arrives after pi's turn closed is answered right away,
// and Kiro's outstanding calls are answered before its turn is cancelled.
//
// Both exist to keep Kiro's conversation free of a tool_use with no tool_result.
// Measured 2026-08-26: leaving one behind made the recovery prompt come back as a
// contentless `refusal` in 4-20ms (7 of 14 recoveries), which pi reported as a
// finished turn — the orchestrator stopped right after its subagent returned.
// Run: test/run-all.sh test/stranded-tool-call.test.ts

import { AcpSession } from "../session.ts";

let failed = false;

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		failed = true;
		return;
	}
	console.log(`✓ ${label}`);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Long enough to cover the handoff's tool-result drain (default 150ms). */
const DRAIN_WAIT_MS = (Number(process.env.PI_KIRO_ACP_DRAIN_MS) || 150) + 50;

/** A session with fake stdin and a live ACP conversation, so prompts and
 * notifications are captured instead of spawning kiro-cli. */
function fakeSession(): { session: AcpSession; written: any[] } {
	const session = new AcpSession("/tmp/kiro-acp-stranded");
	const written: any[] = [];
	session.proc = {
		stdin: {
			writable: true,
			write(chunk: string) {
				written.push(JSON.parse(chunk));
				return true;
			},
		},
	} as any;
	session.acpSessionId = "acp-1";
	session.currentModelId = "m1";
	session.started = true;
	return { session, written };
}

function bridgeCall(session: AcpSession, args: Record<string, unknown>, tool = "herdr_agent") {
	const abort = new AbortController();
	const result = (session as any).handleBridgeToolCall({
		requestId: 1,
		kiroName: tool,
		piName: tool,
		arguments: args,
		signal: abort.signal,
	}) as Promise<{ content: { text?: string }[]; isError?: boolean }>;
	return { abort, result };
}

async function main(): Promise<void> {
	// --- a call arriving after the turn closed is answered, and the dead turn ends ---
	{
		const { session, written } = fakeSession();
		await session.startPrompt("m1", "", "original question");
		assert(session.toolIntakeClosed === false, "a fresh prompt accepts tool calls");
		void session.activePromptDone?.catch(() => {});

		// The stream flushed its batch and closed; Kiro keeps running its prompt.
		session.toolIntakeClosed = true;

		const stranded = bridgeCall(session, { tabLabel: "Scout" });
		const answer = await stranded.result;
		assert(answer.isError === true, "the stranded call is answered instead of hanging");
		assert(
			(answer.content[0]?.text ?? "").includes("not executed"),
			"the answer says the call did not run",
		);
		assert(
			(answer.content[0]?.text ?? "").includes("end your turn"),
			"the answer tells Kiro to stop rather than improvise",
		);
		assert(session.pendingToolCalls.size === 0, "the stranded call is not left pending");
		assert(
			written.some((frame) => frame.method === "session/cancel"),
			"Kiro's turn is cancelled once it can no longer reach pi",
		);
	}

	// --- a still-live sibling call keeps the turn alive ---
	{
		const { session, written } = fakeSession();
		await session.startPrompt("m1", "", "original question");
		void session.activePromptDone?.catch(() => {});

		// One call was flushed into pi and is still running: it can beat Kiro's
		// deadline and be delivered normally, so the turn must not be cancelled.
		session.onToolCallFromBridge = (call) => { call.emitted = true; };
		const live = bridgeCall(session, { agent: "scout", task: "explore" });
		session.onToolCallFromBridge = null;
		session.toolIntakeClosed = true;

		const stranded = bridgeCall(session, { tabLabel: "Scout" });
		assert((await stranded.result).isError === true, "the stranded sibling is still answered");
		assert(
			!written.some((frame) => frame.method === "session/cancel"),
			"the turn survives while another pi tool call is still open",
		);
		assert(session.pendingToolCalls.size === 1, "the live call stays pending");
		live.abort.abort();
		await live.result;
	}

	// --- a call arriving before the stream attaches is queued, not answered ---
	{
		const { session } = fakeSession();
		await session.startPrompt("m1", "", "question");
		void session.activePromptDone?.catch(() => {});
		let resolved = false;
		const early = bridgeCall(session, { agent: "scout", task: "early" });
		void early.result.then(() => { resolved = true; });
		await tick();
		assert(resolved === false, "a call racing the stream attach is not answered early");
		assert(session.pendingToolCalls.size === 1, "it stays queued for the stream to flush");
		early.abort.abort();
		await early.result;
	}

	// --- pending calls are answered before the cancel, not after it ---
	{
		const { session, written } = fakeSession();
		await session.startPrompt("m1", "", "original question");
		const promptFrame = written.find((frame) => frame.method === "session/prompt");
		void session.activePromptDone?.catch(() => {});
		session.onToolCallFromBridge = (call) => { call.emitted = true; };
		const held = bridgeCall(session, { agent: "scout", task: "held" });
		session.onToolCallFromBridge = null;

		let answeredAt = -1;
		void held.result.then(() => { answeredAt = written.length; });

		const followUp = session.cancelAndStartFollowUp(
			"m1",
			"",
			"<dropped_tool_result>the report</dropped_tool_result>",
			[],
			200,
			undefined,
			"orphaned tool result",
		);
		await new Promise<void>((r) => setTimeout(r, DRAIN_WAIT_MS));
		const cancelAt = written.findIndex((frame) => frame.method === "session/cancel");
		assert(answeredAt >= 0, "the outstanding call is answered during the handoff");
		assert(cancelAt >= 0, "the in-flight prompt is still cancelled");
		assert(
			answeredAt <= cancelAt,
			`the tool result is delivered before the cancel (answered at ${answeredAt}, cancel at ${cancelAt})`,
		);

		session.handleStdoutLine(
			JSON.stringify({ jsonrpc: "2.0", id: promptFrame.id, result: { stopReason: "cancelled" } }),
		);
		await followUp;
		const prompts = written.filter((frame) => frame.method === "session/prompt");
		assert(prompts.length === 2, "the follow-up prompt is sent after the cancel settles");
	}

	if (failed) process.exit(1);
	console.log("✓ all stranded-tool-call tests passed");
}

main().catch((error) => {
	console.error(`✗ stranded-tool-call test failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
