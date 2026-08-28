// Test: a recovery prompt that kiro-cli refuses without producing any content is
// re-sent instead of ending the turn.
//
// Measured 2026-08-26: 7 of 14 recoveries came back as `stopReason: "refusal"` in
// 4-20ms with zero thinking/text, which the stream reported to pi as a normal
// `stop`. The orchestrator then sat idle right after its subagent returned until
// the user typed "continue" — a second prompt on the same session goes through.
// Run: test/run-all.sh test/refusal-retry.test.ts

process.env.PI_KIRO_ACP_REFUSAL_RETRY_MS = "20";

let failed = false;

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    failed = true;
    return;
  }
  console.log(`✓ ${label}`);
}

const CWD = "/tmp/kiro-acp-refusal";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const model = {
  id: "m1",
  name: "fake",
  api: "kiro-acp-api",
  provider: "kiro-acp",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as any;

/** The context pi hands back once a tool Kiro had abandoned finally returns. */
const toolResultContext = () =>
  ({
    messages: [
      { role: "user", content: "delegate this" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "herdr_agent", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "herdr_agent",
        isError: false,
        content: [{ type: "text", text: "the report" }],
      },
    ],
    systemPrompt: "",
    tools: [],
  }) as any;

async function main(): Promise<void> {
  // Imported after the env override above so the retry delay is picked up.
  const { streamKiroAcp } = await import("../stream.ts");
  const { routeSession, stopAllSessions } =
    await import("../session-manager.ts");

  try {
    const opts = { sessionId: "S-refusal", cwd: CWD } as any;
    const routed = await routeSession(
      {
        messages: [{ role: "user", content: "delegate this" }],
        systemPrompt: "",
        tools: [],
      } as any,
      opts,
    );
    const session = routed.session;
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

    const pi = { getAllTools: () => [], getActiveTools: () => [] } as any;
    const events: string[] = [];
    let text = "";
    const consumed = (async () => {
      for await (const event of streamKiroAcp(
        pi,
        model,
        toolResultContext(),
        opts,
      )) {
        events.push(
          event.type === "done" ? `done:${(event as any).reason}` : event.type,
        );
        if (event.type === "text_delta") text += (event as any).delta;
      }
    })();

    // The recovery prompt goes out, then Kiro refuses it with no content at all.
    await wait(30);
    const first = written.filter((frame) => frame.method === "session/prompt");
    assert(
      first.length === 1,
      `the recovery prompt is sent (got ${first.length})`,
    );
    assert(
      String(first[0].params.prompt[0].text).includes("the report"),
      "the recovery prompt carries the recovered tool result",
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: first[0].id,
        result: { stopReason: "refusal" },
      }),
    );

    // It must be re-sent rather than reported as a finished turn.
    await wait(120);
    const retries = written.filter(
      (frame) => frame.method === "session/prompt",
    );
    assert(
      retries.length === 2,
      `the refused recovery prompt is re-sent (got ${retries.length})`,
    );
    assert(
      String(retries[1].params.prompt[0].text) ===
        String(first[0].params.prompt[0].text),
      "the retry carries the same recovery prompt",
    );
    assert(
      !events.some((e) => e.startsWith("done:")),
      "the turn is not finished while the retry runs",
    );

    // The retry goes through, exactly as the manual "continue" nudge did.
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "picking up where I left off" },
          },
        },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: retries[1].id,
        result: { stopReason: "end_turn" },
      }),
    );
    await consumed;

    assert(
      events.includes("done:stop"),
      `the retried turn completes normally (got ${events.join(",")})`,
    );
    assert(
      text.includes("picking up"),
      `the retry's text reaches pi (got "${text}")`,
    );

    // A second refusal is not retried again: end the turn instead of looping.
    const second = await (async () => {
      const evts: string[] = [];
      const before = written.length;
      const run = (async () => {
        for await (const event of streamKiroAcp(
          pi,
          model,
          toolResultContext(),
          opts,
        )) {
          evts.push(
            event.type === "done"
              ? `done:${(event as any).reason}`
              : event.type,
          );
        }
      })();
      await wait(30);
      const prompts = written
        .slice(before)
        .filter((frame) => frame.method === "session/prompt");
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: prompts[0].id,
          result: { stopReason: "refusal" },
        }),
      );
      await wait(120);
      const afterRetry = written
        .slice(before)
        .filter((frame) => frame.method === "session/prompt");
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: afterRetry[1].id,
          result: { stopReason: "refusal" },
        }),
      );
      await run;
      return {
        evts,
        prompts: written
          .slice(before)
          .filter((frame) => frame.method === "session/prompt").length,
      };
    })();
    assert(
      second.prompts === 2,
      `a refusal is retried at most once (got ${second.prompts} prompts)`,
    );
    assert(
      second.evts.includes("done:stop"),
      "a second refusal ends the turn instead of looping",
    );

    await stopAllSessions();
  } finally {
    const { stopAllSessions } = await import("../session-manager.ts");
    await stopAllSessions().catch(() => {});
  }

  if (failed) process.exit(1);
  console.log("✓ all refusal-retry tests passed");
}

main().catch((error) => {
  console.error(
    `✗ refusal-retry test failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exitCode = 1;
});
