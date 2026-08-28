// Test: a failing session/prompt (or a throwing update handler) degrades the
// turn instead of killing the pi process.
// Run: test/run-all.sh test/prompt-failure.test.ts

import { AcpSession } from "../session.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

/** A session with a fake stdin and an existing ACP session, so startPrompt
 * writes session/prompt without spawning kiro-cli. */
function fakeSession(modelId: string): {
  session: AcpSession;
  written: string[];
} {
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
  session.acpSessionId = "acp-1";
  session.currentModelId = modelId;
  return { session, written };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    // --- a prompt error with no consumer must not become an unhandled rejection ---
    {
      const { session, written } = fakeSession("m1");
      await session.startPrompt("m1", "", "hi");
      const frame = JSON.parse(written[0]);
      assert(
        frame.method === "session/prompt",
        "startPrompt sends session/prompt",
      );
      assert(
        session.activePromptDone !== null,
        "startPrompt records the in-flight prompt",
      );

      // Nobody attaches handlers (the stream never got that far).
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32603, message: "Internal error" },
        }),
      );
      await tick();

      assert(
        unhandled.length === 0,
        "a prompt error with no consumer raises no unhandled rejection",
      );
      assert(
        session.lastPromptError?.message === "Internal error",
        `prompt failure is recorded on the session, got ${session.lastPromptError?.message}`,
      );
    }

    // --- consumers still observe the failure ---
    {
      const { session, written } = fakeSession("m1");
      await session.startPrompt("m1", "", "hi");
      const frame = JSON.parse(written[0]);
      const settled = session.activePromptDone!.then(
        () => "resolved",
        (e: Error) => e.message,
      );
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32603, message: "boom" },
        }),
      );
      assert(
        (await settled) === "boom",
        "the safety net does not swallow the error from real consumers",
      );
    }

    // --- a successful prompt still resolves and clears the recorded error ---
    {
      const { session, written } = fakeSession("m1");
      session.lastPromptError = new Error("stale");
      await session.startPrompt("m1", "", "hi");
      const frame = JSON.parse(written[0]);
      assert(
        session.lastPromptError === null,
        "startPrompt clears the previous turn's error",
      );
      const settled = session.activePromptDone!.then((r) => r.stopReason);
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { stopReason: "end_turn" },
        }),
      );
      assert(
        (await settled) === "end_turn",
        "a successful prompt resolves with its stopReason",
      );
    }

    // --- a throwing update handler cannot escape through readline ---
    {
      const { session } = fakeSession("m1");
      session.updateHandler = () => {
        throw new Error("consumer blew up");
      };
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
      assert(true, "a throwing update handler is contained to its stdout line");
    }

    await tick();
    assert(
      unhandled.length === 0,
      "no unhandled rejections across the whole test",
    );
    console.log("✓ all prompt-failure tests passed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

void main();
