// Test: newline-delimited JSON-RPC framing and stdout dispatch in AcpSession.
// Run: test/run-all.sh test/framing.test.ts

import type { SessionUpdate } from "../types.ts";
import { AcpSession } from "../session.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

/** A session with a fake stdin so rpc* writes are captured instead of spawned. */
function fakeSession(): { session: AcpSession; written: string[] } {
  const session = new AcpSession("/tmp");
  const written: string[] = [];
  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    },
  } as any;
  return { session, written };
}

/** Parses captured writes, requiring each to be exactly one newline-terminated line. */
function parseLines(written: string[]): any[] {
  return written.map((line) => {
    if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
      console.error(
        `✗ write is not a single newline-delimited frame: ${JSON.stringify(line)}`,
      );
      process.exit(1);
    }
    return JSON.parse(line);
  });
}

async function settled<T>(
  promise: Promise<T>,
): Promise<{ ok: boolean; value?: T; error?: Error }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

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
        frames[0].result.outcome.optionId === "allow_always",
      "permission prefers allow_always",
    );
    assert(
      frames[1].result.outcome.optionId === "allow_once",
      "permission falls back to the first option",
    );
    assert(
      frames[2].id === 7 && frames[2].result === null,
      "unknown inbound requests are answered with null",
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
