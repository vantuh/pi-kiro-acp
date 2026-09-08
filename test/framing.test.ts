// Test: newline-delimited JSON-RPC framing and stdout dispatch in AcpSession.
// Run: test/run-all.sh test/framing.test.ts

import type { SessionUpdate } from "../types.ts";
import { AcpSession } from "../session.ts";
import { assert, fakeSession, parseLines, settled } from "./support.ts";
async function main(): Promise<void> {
  // --- outbound framing ---
  {
    const { session, written } = fakeSession();
    const first = settled(
      session.rpcSend("initialize", { protocolVersion: 1 }),
    );
    const second = settled(session.rpcSend("session/new", { cwd: "/tmp" }));
    session.rpcNotify("notifications/initialized", {});
    session.rpcRespond(7, { ok: true });

    const frames = parseLines(written);
    assert(frames.length === 4, "one line written per rpc call");
    assert(
      written.every(
        (line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"),
      ),
      "each write is a single newline-delimited frame",
    );
    assert(
      frames.every((f) => f.jsonrpc === "2.0"),
      "every frame carries jsonrpc 2.0",
    );
    assert(
      frames[0].id === 0 && frames[0].method === "initialize",
      "first request uses id 0",
    );
    assert(
      frames[1].id === 1 && frames[1].method === "session/new",
      "request ids increment",
    );
    assert(!("id" in frames[2]), "notifications carry no id");
    assert(
      frames[3].id === 7 && frames[3].result.ok === true,
      "responses echo the request id",
    );
    assert(
      session.rpcPending.size === 2,
      "requests stay pending until answered",
    );

    // id 0 must match: a falsy-id check would leak this response as an orphan.
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        result: { agentCapabilities: {} },
      }),
    );
    const firstResult = await first;
    assert(firstResult.ok, "response for id 0 resolves its pending request");
    assert(
      (firstResult.value as any).agentCapabilities !== undefined,
      "resolved value is the result payload",
    );

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "boom" },
      }),
    );
    const secondResult = await second;
    assert(
      !secondResult.ok && secondResult.error?.message === "boom",
      "error response rejects with its message",
    );
    assert(
      session.rpcPending.size === 0,
      "answered requests are removed from the pending map",
    );
  }

  // --- out-of-order and malformed input ---
  {
    const { session } = fakeSession();
    const a = settled(session.rpcSend("a", {}));
    const b = settled(session.rpcSend("b", {}));

    session.handleStdoutLine("");
    session.handleStdoutLine("   ");
    session.handleStdoutLine("not json at all");
    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 99, result: 1 }),
    );
    assert(
      session.rpcPending.size === 2,
      "blank, malformed, and orphan lines leave pending requests intact",
    );

    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "second" }),
    );
    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 0, result: "first" }),
    );
    const [ra, rb] = [await a, await b];
    assert(
      ra.value === "first" && rb.value === "second",
      "out-of-order responses resolve the right request",
    );
  }

  // --- inbound requests get answered ---
  {
    const { session, written } = fakeSession();
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "session/request_permission",
        params: { options: [{ id: "reject_once" }, { id: "allow_always" }] },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "session/request_permission",
        params: { options: [{ id: "allow_once" }] },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "some/unknown",
        params: {},
      }),
    );

    const frames = parseLines(written);
    assert(frames.length === 3, "every inbound request gets exactly one reply");
    assert(
      frames[0].id === 5 &&
        frames[0].result.outcome.optionId === "reject_once",
      "unidentified permission is denied (reject_once)",
    );
    assert(
      frames[1].result.outcome.outcome === "cancelled",
      "denied permission with no reject option is cancelled",
    );
    assert(
      frames[2].id === 7 && frames[2].result === null,
      "unknown inbound requests are answered with null",
    );
  }

  {
    const { session, written } = fakeSession();
    session.catalogProvider = () =>
      ({
        tools: [{ kiroName: "bash", piName: "bash" }],
        piNameByKiroName: new Map([["bash", "bash"]]),
        fingerprint: "test",
        diagnostics: [],
      }) as any;
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "session/request_permission",
        params: {
          options: [{ id: "reject_always" }, { id: "allow_always" }],
          toolCall: {
            _meta: { kiro: { mcpServerName: "pi_host", toolName: "bash" } },
          },
        },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "session/request_permission",
        params: {
          options: [{ id: "reject_always" }, { id: "allow_always" }],
          toolCall: { toolName: "subagent" },
        },
      }),
    );
    const frames = parseLines(written);
    assert(
      frames[0].result.outcome.optionId === "allow_always",
      "pi_host bash is allowed",
    );
    assert(
      frames[1].result.outcome.optionId === "reject_always",
      "native subagent is rejected always",
    );
  }

  // --- notifications ---
  {
    const { session, written } = fakeSession();
    const updates: SessionUpdate[] = [];
    session.updateHandler = (u) => updates.push(u);

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hi" },
          },
        },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_kiro.dev/session/update",
        params: {
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "hmm" },
          },
        },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "unknown/notification",
        params: {},
      }),
    );

    assert(
      updates.length === 2,
      "both session/update spellings reach the update handler",
    );
    assert(
      updates[0].sessionUpdate === "agent_message_chunk",
      "session/update payload is unwrapped",
    );
    assert(
      updates[1].sessionUpdate === "agent_thought_chunk",
      "_kiro.dev/session/update is treated the same",
    );
    assert(written.length === 0, "notifications are never answered");
  }

  // --- _kiro.dev/agent/not_found + commands/available (leak detection) ---
  {
    const { session } = fakeSession();
    let threw = false;
    try {
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "_kiro.dev/agent/not_found",
          params: {
            sessionId: "x",
            requestedAgent: "pi-kiro-abcd",
            fallbackAgent: "kiro_default",
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert(!threw, "agent/not_found dispatches without crashing");
    assert(
      session.recoveryPending === true,
      "agent/not_found marks the backend as fallen back",
    );
    assert(
      session.backendQuarantined === false,
      "agent/not_found alone does not quarantine the backend",
    );
  }

  {
    const { session } = fakeSession();
    session.persistenceKey = null;
    const available = (tools: unknown[]) =>
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "_kiro.dev/commands/available",
          params: { sessionId: "x", tools },
        }),
      );

    available([{ name: "bash", source: "mcp:pi_host" }]);
    assert(
      session.recoveryPending === false,
      "mcp-only tools list is not a leak",
    );

    available([
      { name: "bash", source: "mcp:pi_host" },
      { name: "read", source: "built-in" },
      { name: "subagent", source: "built-in" },
    ]);
    assert(
      session.recoveryPending === true,
      "built-in tool entries mark the leak",
    );

    // Same list again: fingerprint dedup must not re-handle (state stable).
    available([
      { name: "bash", source: "mcp:pi_host" },
      { name: "read", source: "built-in" },
      { name: "subagent", source: "built-in" },
    ]);
    assert(
      session.recoveryPending === true,
      "repeated identical list is deduplicated",
    );

    // A clean list on the same process lifts the quarantine (fresh
    // session/new after a leaked restore is sound again).
    available([{ name: "bash", source: "mcp:pi_host" }]);
    assert(
      session.recoveryPending === false &&
        session.backendQuarantined === false,
      "clean tools list lifts the leak quarantine",
    );
  }

  {
    // Malformed / empty / foreign notifications are never authoritative:
    // they must not lift a quarantine set by a leak or agent fallback.
    const { session } = fakeSession();
    session.persistenceKey = null;
    session.recoveryPending = true;
    session.backendQuarantined = true;
    const post = (label: string) =>
      assert(
        session.recoveryPending === true &&
          session.backendQuarantined === true,
        label,
      );

    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: {} }),
    );
    post("missing tools payload does not lift quarantine");

    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { tools: null } }),
    );
    post("null tools payload does not lift quarantine");

    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { tools: [] } }),
    );
    post("empty tools list does not lift quarantine");

    session.acpSessionId = "current"; // for the foreign-id scoping check
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_kiro.dev/commands/available",
        params: { sessionId: "foreign", tools: [{ name: "bash", source: "mcp:pi_host" }] },
      }),
    );
    post("foreign-session notification does not lift quarantine");
  }

  {
    // A leak on a restored backend quarantines it (persistence suppressed)
    // and stop() resets the backend-scoped state.
    const { session } = fakeSession();
    session.persistenceKey = null;
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_kiro.dev/commands/available",
        params: {
          sessionId: "x",
          tools: [{ name: "read", source: "built-in" }],
        },
      }),
    );
    assert(
      session.recoveryPending === true && session.backendQuarantined === true,
      "restored-backend leak quarantines the backend",
    );
    session.proc = null; // no real process to terminate in this unit test
    await session.stop();
    assert(
      !session.recoveryPending && !session.backendQuarantined,
      "stop() resets backend-scoped leak state",
    );
  }

  // --- usage updates are scoped to the session's own ACP id ---
  {
    const { session } = fakeSession();
    session.acpSessionId = "acp-1";
    const usage = (sessionId: string, used: number) =>
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "usage_update", used, size: 200 },
          },
        }),
      );

    usage("acp-1", 50);
    assert(
      session.metadata?.contextUsed === 50,
      "usage_update records context usage",
    );
    assert(
      session.metadata?.contextUsagePercentage === 25,
      "usage percentage is used/size",
    );

    usage("acp-other", 180);
    assert(
      session.metadata?.contextUsed === 50,
      "usage for a foreign ACP session id is ignored",
    );
  }

  // --- request timeouts ---
  {
    const { session } = fakeSession();
    const timedOut = await settled(session.rpcSend("slow/method", {}, 10));
    assert(!timedOut.ok, "an unanswered request rejects on timeout");
    assert(
      /RPC timeout: slow\/method/.test(timedOut.error?.message || ""),
      "timeout error names the method",
    );
    assert(
      session.rpcPending.size === 0,
      "timed-out requests are dropped from the pending map",
    );
  }

  // --- writes are dropped when the process is gone ---
  {
    const session = new AcpSession("/tmp");
    const noProc = await settled(session.rpcSend("initialize", {}));
    assert(
      !noProc.ok && /not running/.test(noProc.error?.message || ""),
      "rpcSend rejects without a live process",
    );
    session.rpcNotify("notifications/initialized", {});
    session.rpcRespond(1, null);
    assert(true, "notify/respond are no-ops without a live process");
  }

  console.log("✓ all framing tests passed");
}

void main();
