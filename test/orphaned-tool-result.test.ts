// Test: recovery when Kiro abandons its own pi_host tools/call while pi is still
// running the tool (slow tools like subagents). Two failures used to combine into
// a relaunch loop: the session stayed `busy` forever because a late-settling
// prompt never cleared `activePromptDone`, and the orphaned result was answered by
// spawning a fresh Kiro session that replayed only the user's question.
// Run: test/run-all.sh test/orphaned-tool-result.test.ts

import type { Context } from "@earendil-works/pi-ai";
import { AcpSession } from "../session.ts";
import { routeSession, stopAllSessions } from "../session-manager.ts";

let failed = false;

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    failed = true;
    return;
  }
  console.log(`✓ ${label}`);
}

const CWD = "/tmp/kiro-acp-orphan";
const opts = (sessionId: string) => ({ sessionId, cwd: CWD }) as any;

const askedContext = (): Context =>
  ({
    messages: [{ role: "user", content: "compare A and B" }],
    systemPrompt: "",
    tools: [],
  }) as any;

/** The context pi hands back once the slow tool finally returns. */
const toolResultContext = (): Context =>
  ({
    messages: [
      { role: "user", content: "compare A and B" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "probe_tool", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "probe_tool",
        isError: false,
        content: [{ type: "text", text: "the report" }],
      },
    ],
    systemPrompt: "",
    tools: [],
  }) as any;

/** Marks a routed session as having a live Kiro conversation, without spawning. */
function markLive(session: AcpSession, acpSessionId: string): void {
  session.started = true;
  session.acpSessionId = acpSessionId;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  // --- an orphaned tool result reuses the live session instead of forking ---
  {
    const first = await routeSession(askedContext(), opts("S1"));
    markLive(first.session, "acp-1");
    assert(
      first.orphanedToolResults === false,
      "a plain turn is not flagged as orphaned",
    );

    // Kiro dropped its tools/call, so nothing is pending when the result lands.
    assert(
      first.session.pendingToolCalls.size === 0,
      "no pending bridge call remains after the drop",
    );

    const recovered = await routeSession(toolResultContext(), opts("S1"));
    assert(
      recovered.session === first.session,
      "the orphaned result is routed back to the live session",
    );
    assert(
      recovered.isResumption === false,
      "there is no MCP request left to resume",
    );
    assert(
      recovered.orphanedToolResults === true,
      "the orphaned result is flagged for recovery",
    );
    assert(
      recovered.toolResults.length === 1,
      "the tool result is carried through",
    );
    await stopAllSessions();
  }

  // --- a matching pending call still takes the normal resumption path ---
  {
    const routed = await routeSession(askedContext(), opts("S2"));
    markLive(routed.session, "acp-2");
    routed.session.pendingToolCalls.set("c1", {
      callId: "c1",
      toolName: "probe_tool",
      args: {},
      receivedAt: Date.now(),
      resolve: () => {},
    });

    const resumed = await routeSession(toolResultContext(), opts("S2"));
    assert(
      resumed.session === routed.session,
      "resumption stays on the same session",
    );
    assert(
      resumed.isResumption === true,
      "a matching pending call resumes normally",
    );
    assert(
      resumed.orphanedToolResults === false,
      "resumption is not treated as orphaned",
    );
    await stopAllSessions();
  }

  // --- no live session to recover into: still flagged, so the replay is forced ---
  {
    const routed = await routeSession(toolResultContext(), opts("S3"));
    assert(routed.isResumption === false, "a cold start cannot resume");
    assert(
      routed.orphanedToolResults === true,
      "a cold start with tool results is flagged as orphaned",
    );
    assert(
      routed.session.acpSessionId === null,
      "the cold session has no ACP conversation yet",
    );
    await stopAllSessions();
  }

  // --- a retry of an abandoned call is answered, not run twice ---
  // Kiro drops a tools/call at its own deadline (measured: 120s on kiro-cli
  // 2.19.1) and its model then reissues the identical call while pi is still
  // executing the first one. Dispatching that retry is what multiplied the
  // subagent launches.
  {
    const session = new AcpSession(CWD);
    const dispatched: string[] = [];
    // Production sets emitted when the call is flushed into pi's stream.
    // Dedup only remembers emitted calls — an unemitted one never ran.
    session.onToolCallFromBridge = (call) => {
      call.emitted = true;
      dispatched.push(call.callId);
    };
    // Abandonments are only remembered for a live session, so a shutdown burst
    // cannot leave stale dedup records behind.
    session.started = true;

    const bridgeCall = (args: Record<string, unknown>) => {
      const abort = new AbortController();
      const result = (session as any).handleBridgeToolCall({
        requestId: 1,
        kiroName: "probe_tool",
        piName: "probe_tool",
        arguments: args,
        signal: abort.signal,
      }) as Promise<{ content: { text?: string }[]; isError?: boolean }>;
      return { abort, result };
    };

    const first = bridgeCall({ agent: "reviewer", task: "compare" });
    assert(dispatched.length === 1, "the first call is dispatched to pi");
    assert(session.pendingToolCalls.size === 1, "the first call is pending");
    first.abort.abort();
    const aborted = await first.result;
    assert(aborted.isError === true, "the abandoned call resolves as an error");
    assert(
      session.pendingToolCalls.size === 0,
      "the abandoned call stops being pending",
    );

    // Same call, arguments written in a different order.
    const retry = bridgeCall({ task: "compare", agent: "reviewer" });
    const retryResult = await retry.result;
    assert(
      dispatched.length === 1,
      "the retry is not dispatched to pi a second time",
    );
    assert(retryResult.isError === true, "the retry is answered as an error");
    assert(
      (retryResult.content[0]?.text ?? "").includes("already running"),
      "the retry is told the call is already running",
    );
    assert(
      (retryResult.content[0]?.text ?? "").includes("end your turn"),
      "the retry is told to stop instead of finding another way",
    );

    const different = bridgeCall({ agent: "reviewer", task: "something else" });
    assert(
      dispatched.length === 2,
      "a genuinely different call is still dispatched",
    );
    different.abort.abort();
    await different.result;

    session.clearAbandonedToolCalls([
      {
        toolCallId: "x",
        toolName: "probe_tool",
        text: "done",
        isError: false,
      },
    ]);
    const afterRecovery = bridgeCall({ agent: "reviewer", task: "compare" });
    assert(
      dispatched.length === 3,
      "after recovery the same call may run again",
    );
    afterRecovery.abort.abort();
    await afterRecovery.result;

    // A stopped session must not keep suppressing calls.
    session.started = false;
    const onDeadSession = bridgeCall({ agent: "reviewer", task: "dead" });
    onDeadSession.abort.abort();
    await onDeadSession.result;
    session.started = true;
    const afterRestart = bridgeCall({ agent: "reviewer", task: "dead" });
    assert(
      dispatched.length === 5,
      "a call aborted while stopped leaves no dedup record",
    );
    afterRestart.abort.abort();
    await afterRestart.result;
  }

  // --- a late-settling prompt releases the session ---
  {
    const session = new AcpSession(CWD);
    const written: string[] = [];
    session.proc = {
      stdin: {
        writable: true,
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        },
      },
    } as any;
    session.acpSessionId = "acp-4";
    session.currentModelId = "m1";

    await session.startPrompt("m1", "", "hi");
    const frame = JSON.parse(written[0]);
    assert(session.busy === true, "a session with an in-flight prompt is busy");

    // Kiro finishes its turn while pi is still executing the tool it asked for.
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: { stopReason: "end_turn" },
      }),
    );
    await tick();
    assert(
      session.activePromptDone === null,
      "a settled prompt is no longer recorded as active",
    );
    assert(
      session.busy === false,
      "the session becomes reusable instead of busy forever",
    );
  }

  // --- a settled prompt does not clear a newer one ---
  {
    const session = new AcpSession(CWD);
    const written: string[] = [];
    session.proc = {
      stdin: {
        writable: true,
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        },
      },
    } as any;
    session.acpSessionId = "acp-5";
    session.currentModelId = "m1";

    await session.startPrompt("m1", "", "first");
    const firstFrame = JSON.parse(written[0]);
    void session.activePromptDone?.catch(() => {});
    await session.startPrompt("m1", "", "second");
    const secondPrompt = session.activePromptDone;

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: firstFrame.id,
        result: { stopReason: "end_turn" },
      }),
    );
    await tick();
    assert(
      session.activePromptDone === secondPrompt,
      "an older prompt settling leaves the newer one in place",
    );
  }

  // --- recovery cancels the in-flight prompt instead of overlapping it ---
  // Measured 2026-08-26: a second session/prompt while the original was still
  // running (Kiro had dropped only the tools/call) came back as Internal error
  // in 1ms, then Kiro relaunched the subagent.
  {
    const session = new AcpSession(CWD);
    const written: string[] = [];
    session.proc = {
      stdin: {
        writable: true,
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        },
      },
    } as any;
    session.acpSessionId = "acp-6";
    session.currentModelId = "m1";
    session.started = true;

    await session.startPrompt("m1", "", "original question");
    const firstFrame = JSON.parse(written[0]);
    assert(session.busy === true, "the original prompt is still in flight");

    const followUp = session.cancelAndStartFollowUp(
      "m1",
      "",
      "<dropped_tool_result>the report</dropped_tool_result>",
      [],
      200,
      undefined,
      "orphaned tool result",
    );
    await tick();
    assert(
      session.busy === true,
      "the session stays busy while the old prompt is cancelled",
    );
    const methods = written.map((line) => JSON.parse(line).method);
    assert(
      methods.includes("session/cancel"),
      "an in-flight prompt is cancelled before recovery",
    );

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: firstFrame.id,
        result: { stopReason: "cancelled" },
      }),
    );
    await followUp;

    const frames = written.map((line) => JSON.parse(line));
    const prompts = frames.filter((frame) => frame.method === "session/prompt");
    assert(
      prompts.length === 2,
      "recovery sends a new prompt after cancel, not on top of it",
    );
    assert(
      String(prompts[1].params.prompt[0].text).includes("dropped_tool_result"),
      "the follow-up prompt carries the dropped tool result",
    );
    assert(
      session.busy === true,
      "the recovery prompt is now the in-flight one",
    );
  }

  await stopAllSessions();
  if (failed) process.exit(1);
  console.log("✓ all orphaned-tool-result tests passed");
}

main().catch((error) => {
  console.error(
    `✗ orphaned-tool-result test failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exitCode = 1;
  return stopAllSessions().catch(() => {});
});
