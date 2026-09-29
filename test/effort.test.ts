// Test: the thinking level reaches kiro-cli in-band, through the intercepted
// `/effort` command prompt — including after session/set_model clears it —
// while the command's reply never reaches pi's update handler. Clearing a
// level is the one case kiro cannot express in-band, so it restarts.
// Run: test/run-all.sh test/effort.test.ts

// Keep session-persistence's import hermetic before it loads.
process.env.XDG_DATA_HOME ??= "/tmp/kiro-acp-test-data";

import { AcpSession, toKiroEffort } from "../session.ts";
import type { ForwardedToolCatalog } from "../tool-catalog.ts";
import type { SessionUpdate } from "../types.ts";
import { assert, fakeSession, parseLines, tick, wait } from "./support.ts";

// pi's logging module resolves DEBUG once at load with no env override, so the
// log lines cannot be captured cheaply. Everything the effort cluster logs has
// an observable effect on session state — the frames written to kiro, the
// applied level, the pending-reconciliation flag, whether the command reply
// reached the update handler — and the assertions below pin that state instead.

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

/** What fakeSession hands back, named here so tests read it as a contract. */
interface FakeSession {
  session: AcpSession;
  written: string[];
}

const catalogProvider = (): ForwardedToolCatalog => ({
  tools: [],
  piNameByKiroName: new Map<string, string>(),
  fingerprint: "effort-test",
  diagnostics: [],
});

/** One captured JSON-RPC frame written to kiro. */
interface Frame {
  id?: number;
  method?: string;
  params?: { prompt?: Array<{ text?: string }> };
}

function frames(written: string[]): Frame[] {
  return parseLines(written);
}

function promptText(frame: Frame): string {
  return frame.params?.prompt?.[0]?.text ?? "";
}

/** The `session/prompt` frames carrying the intercepted `/effort` command. */
function commandFrames(written: string[]): Frame[] {
  return frames(written).filter(
    (f) => f.method === "session/prompt" && promptText(f).startsWith("/effort"),
  );
}

/** The reconciliation ensureStarted owed to the next pre-prompt sync. */
function reconcilePending(session: AcpSession): boolean {
  return (session as any).effortReconcilePending === true;
}

/** Text of an `agent_message_chunk` update — how kiro answers a command. */
function chunkText(update: SessionUpdate): string {
  const content = update.content;
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function messageChunk(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function rpcResult(id: number, result: unknown = { stopReason: "end_turn" }) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** A started, idle ACP session whose writes are captured, not spawned. */
function startedSession(): FakeSession {
  const fake = fakeSession({ started: true, acpSessionId: "acp-1" });
  fake.session.currentModelId = "m1";
  return { session: fake.session, written: fake.written };
}

/** Settles the command RPC the way kiro does: reply chunk first, then result. */
async function answerCommand(
  session: AcpSession,
  written: string[],
  reply: string,
): Promise<void> {
  const pending = commandFrames(written).at(-1)!;
  session.handleStdoutLine(messageChunk(reply));
  session.handleStdoutLine(rpcResult(pending.id!));
  await tick();
}

/** A JSON-RPC error response for a frame still in flight. */
function rpcError(id: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

/** A `_kiro.dev/metadata` tick reporting one effort level. */
function effortTick(effort: string): string {
  return metadataTick({
    support: "toggleable",
    thinkingEnabled: true,
    effort,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  });
}

function metadataTick(reasoning: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "_kiro.dev/metadata",
    params: { sessionId: "acp-1", reasoning },
  });
}

async function main(): Promise<void> {
  // --- pi's reasoning level maps onto kiro's /effort levels ---
  assert(toKiroEffort("max") === "max", "max maps to the kiro max level");
  assert(
    toKiroEffort(undefined) === null,
    "a turn without a reasoning level asks for no effort",
  );

  // --- 1. an effort change on a live idle session goes out in-band ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";
    const updates: SessionUpdate[] = [];
    session.updateHandler = (u) => updates.push(u);
    const procBefore = session.proc;

    const starting = session.ensureStarted(catalogProvider, "xhigh");
    await tick();

    const commands = commandFrames(written);
    assert(
      commands.length === 1,
      `an effort change sends exactly one command prompt (got ${commands.length})`,
    );
    assert(
      promptText(commands[0]) === "/effort xhigh",
      "the command prompt carries the requested level",
    );
    assert(
      session.started === true && session.proc === procBefore,
      "the process is neither stopped nor replaced for an effort change",
    );

    await answerCommand(session, written, "Effort set to xhigh\n");
    await starting;

    assertEqual(
      session.currentEffort,
      "xhigh",
      "the level kiro confirmed becomes the session's current effort",
    );
    assert(
      updates.length === 0,
      `the command reply never reaches pi's update handler (got ${updates.length})`,
    );

    // A later, unrelated chunk is still streamed.
    session.handleStdoutLine(messageChunk("hello"));
    assert(
      updates.length === 1 && chunkText(updates[0]) === "hello",
      "a normal chunk after the command is still forwarded",
    );

    // No further RPC while the level already matches.
    const writesBefore = written.length;
    await session.ensureStarted(catalogProvider, "xhigh");
    assert(
      written.length === writesBefore,
      "an unchanged level costs no extra RPC",
    );
  }

  // --- 2. a refused command leaves the session untouched ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";
    const starting = session.ensureStarted(catalogProvider, "max");
    await tick();
    await answerCommand(
      session,
      written,
      "Effort is not available on this model.\n",
    );
    await starting;

    assertEqual(
      session.currentEffort,
      "low",
      "a refused level is not recorded as applied (a later turn retries)",
    );
    assert(
      reconcilePending(session) === false,
      "a refusal costs one command, so nothing is left owed for this turn",
    );
  }

  // --- 3. session/set_model clears the level, so it is re-applied ---
  {
    const { session, written } = startedSession();
    session.desiredEffort = "high";
    session.currentEffort = "high";
    const prompting = session.startPrompt("m2", "", "hi");
    await tick();
    const afterSetModel = frames(written);
    const setModelIndex = afterSetModel.findIndex(
      (f) => f.method === "session/set_model",
    );
    assert(setModelIndex >= 0, "a model change sends session/set_model");
    session.handleStdoutLine(rpcResult(afterSetModel[setModelIndex].id!));
    await tick();

    const commandIndex = frames(written).findIndex(
      (f) => f.method === "session/prompt" && promptText(f) === "/effort high",
    );

    assert(
      commandIndex >= 0 && commandIndex > setModelIndex,
      "the effort command is re-applied after session/set_model",
    );

    await answerCommand(session, written, "Effort set to high\n");
    const realPrompt = frames(written).find(
      (f) => f.method === "session/prompt" && promptText(f) === "hi",
    );
    assert(
      realPrompt !== undefined,
      "the turn's own prompt is still sent after the effort command",
    );
    session.handleStdoutLine(rpcResult(realPrompt!.id!));
    await prompting;
    assertEqual(
      session.currentEffort,
      "high",
      "the re-applied level is held for the turn",
    );
  }

  // --- 3b. a turn that asked for no effort adds no command prompt ---
  {
    const { session, written } = startedSession();
    session.currentEffort = null;
    session.desiredEffort = null;

    const prompting = session.startPrompt("m2", "", "hi");
    await tick();
    const setModel = frames(written).find(
      (f) => f.method === "session/set_model",
    );
    assert(
      setModel !== undefined,
      "a model change still sends session/set_model",
    );
    assert(
      commandFrames(written).length === 0,
      "no /effort command is sent when no level was ever applied",
    );
    session.handleStdoutLine(rpcResult(setModel!.id!));
    await tick();
    const realPrompt = frames(written).find(
      (f) => f.method === "session/prompt" && promptText(f) === "hi",
    );
    session.handleStdoutLine(rpcResult(realPrompt!.id!));
    await prompting;
    assertEqual(
      session.currentEffort,
      null,
      "a turn with no reasoning keeps the session without a level",
    );
  }

  // --- 4. clearing an applied level restarts (kiro has no in-band clear) ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "max";
    let stopped = 0;
    // Seamed so the restart does not spawn a real kiro-cli: the observable
    // under test is that a clear reaches stop() instead of kiro.
    session.stop = async () => {
      stopped++;
    };

    await session.ensureStarted(catalogProvider, null);

    assertEqual(
      stopped,
      1,
      "clearing the level restarts the process",
    );
    assertEqual(
      session.desiredEffort,
      null,
      "the clear is what the session now wants applied",
    );
    assert(
      commandFrames(written).length === 0,
      "no command prompt is sent for a clear kiro cannot express",
    );
    assert(
      session.desiredEffort === null && session.currentEffort === "max",
      "the seam leaves the level for the replacement process to re-apply",
    );
  }

  // --- 5. kiro's reported reasoning is recorded and mismatches are loud ---
  {
    const { session } = startedSession();
    // A level we actually applied: kiro reporting a different one is real
    // drift, not the model's own default (which a fresh backend also reports,
    // with nothing applied — covered in test 11b).
    session.currentEffort = "xhigh";
    session.desiredEffort = "xhigh";
    const seen: unknown[] = [];
    session.onMetadata = (m) => seen.push(m);
    const reported = {
      support: "toggleable",
      thinkingEnabled: true,
      effort: "low",
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    };

    session.handleStdoutLine(metadataTick(reported));

    assertEqual(
      session.metadata?.reasoning?.effort,
      "low",
      "the reported effort level is recorded on the session metadata",
    );
    assertEqual(
      session.metadata?.reasoning?.effortLevels?.length,
      5,
      "the model's effort levels are recorded too",
    );
    assert(seen.length === 1, "the reasoning update reaches onMetadata");
    assertEqual(
      session.currentEffort,
      null,
      "a level kiro did not take invalidates the applied belief",
    );
    assert(
      reconcilePending(session),
      "the invalid belief hands a re-apply to the next pre-prompt sync",
    );

    // The same reasoning on a later tick changes nothing.
    session.handleStdoutLine(metadataTick(reported));
    assert(
      session.currentEffort === null,
      "a repeated identical tick leaves the recorded state alone",
    );

    // Now the level matches: the belief survives.
    session.currentEffort = "xhigh";
    session.handleStdoutLine(metadataTick({ ...reported, effort: "xhigh" }));
    assertEqual(
      session.currentEffort,
      "xhigh",
      "a matching reported level raises no mismatch",
    );
  }

  // --- 6. a refused level costs one command per turn, not two ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";

    const runTurn = async (message: string) => {
      const starting = session.ensureStarted(catalogProvider, "max");
      await tick();
      await answerCommand(
        session,
        written,
        "Effort is not available on this model.\n",
      );
      const prompting = session.startPrompt("m1", "", message);
      await tick();
      const real = frames(written).find(
        (f) => f.method === "session/prompt" && promptText(f) === message,
      );
      assert(real !== undefined, `the turn's own prompt (${message}) is sent`);
      session.handleStdoutLine(rpcResult(real!.id!));
      await Promise.all([starting, prompting]);
    };

    await runTurn("hi");
    assertEqual(
      commandFrames(written).length,
      1,
      "one /effort command in a turn whose level was refused",
    );

    await runTurn("again");
    assertEqual(
      commandFrames(written).length,
      2,
      "the next turn retries the refused level exactly once more",
    );
    assertEqual(
      session.currentEffort,
      "low",
      "a refused level is still not recorded as applied",
    );
  }

  // --- 7. a failed command releases suppression and is logged ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";
    const updates: SessionUpdate[] = [];
    session.updateHandler = (u) => updates.push(u);

    const starting = session.ensureStarted(catalogProvider, "high");
    await tick();
    const command = commandFrames(written).at(-1)!;
    session.handleStdoutLine(rpcError(command.id!, "Internal error"));
    await starting;

    assertEqual(
      session.currentEffort,
      "low",
      "a failed command leaves the applied level alone",
    );
    assert(
      reconcilePending(session) === false,
      "a failed command owes no second attempt in this turn",
    );

    session.handleStdoutLine(messageChunk("model output"));
    assert(
      updates.length === 1 && chunkText(updates[0]) === "model output",
      "suppression is released when the command RPC fails",
    );
  }

  // --- 8. a command that is never answered times out instead of hanging ---
  {
    process.env.PI_KIRO_ACP_EFFORT_COMMAND_TIMEOUT_MS = "60";
    try {
      const { session, written } = startedSession();
      session.currentEffort = "low";
      const updates: SessionUpdate[] = [];
      session.updateHandler = (u) => updates.push(u);

      const starting = session.ensureStarted(catalogProvider, "high");
      await wait(300);
      await starting;

      assertEqual(
        commandFrames(written).length,
        1,
        "the unanswered command was sent once",
      );
      assertEqual(
        session.currentEffort,
        "low",
        "a timed-out command leaves the applied level unchanged",
      );

      // Suppression is not stuck, and a reply that arrives after the timeout
      // is still recognised as the command's, not as model output.
      session.handleStdoutLine(messageChunk("Effort set to high"));
      assert(
        updates.length === 0,
        "a late command reply is dropped by the grace window",
      );
      session.handleStdoutLine(messageChunk("model output"));
      assert(
        updates.length === 1 && chunkText(updates[0]) === "model output",
        "normal chunks flow again after the timeout",
      );
    } finally {
      delete process.env.PI_KIRO_ACP_EFFORT_COMMAND_TIMEOUT_MS;
    }
  }

  // --- 9. one command at a time: overlapping reconciliations serialise ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";

    const first = session.ensureStarted(catalogProvider, "high");
    const second = session.ensureStarted(catalogProvider, "high");
    await tick();
    assertEqual(
      commandFrames(written).length,
      1,
      "two callers wanting the same level share one command",
    );
    await answerCommand(session, written, "Effort set to high\n");
    await Promise.all([first, second]);
    assertEqual(
      commandFrames(written).length,
      1,
      "the second caller sends no command once the level is applied",
    );
    assertEqual(
      session.currentEffort,
      "high",
      "the shared command's level is applied",
    );
  }

  // --- 9b. a level that changes mid-command still ends up applied ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";

    const first = session.ensureStarted(catalogProvider, "high");
    const second = session.ensureStarted(catalogProvider, "xhigh");
    await tick();
    await answerCommand(session, written, "Effort set to high\n");
    await tick();

    const commands = commandFrames(written);
    assert(
      commands.length === 2 &&
        promptText(commands[0]) === "/effort high" &&
        promptText(commands[1]) === "/effort xhigh",
      `the superseded level is re-synced to the newest one (got ${commands.map(promptText).join(", ")})`,
    );
    await answerCommand(session, written, "Effort set to xhigh\n");
    await Promise.all([first, second]);
    assertEqual(
      session.currentEffort,
      "xhigh",
      "the newest requested level is the one left applied",
    );
  }

  // --- 10. mismatch handling is deduped, silent mid-command, and never
  // adopts a level nothing asked for ---
  {
    const { session, written } = startedSession();
    session.currentEffort = "low";
    session.desiredEffort = "xhigh";

    session.handleStdoutLine(effortTick("low"));
    assertEqual(
      session.currentEffort,
      null,
      "the same desired/reported pair invalidates the belief once",
    );
    session.handleStdoutLine(effortTick("low"));
    session.handleStdoutLine(effortTick("low"));
    assert(
      reconcilePending(session),
      "repeated ticks keep the one re-apply that is already owed",
    );
    // The first mismatch invalidated the belief, so re-apply before checking
    // that a *different* reported level is fresh drift rather than a repeat.
    session.currentEffort = "xhigh";
    session.handleStdoutLine(effortTick("medium"));
    assertEqual(
      session.currentEffort,
      null,
      "a different reported level is drift again, not a repeat",
    );

    // With nothing asked for, kiro's report is the model's default — it must
    // not be adopted as our applied level.
    session.desiredEffort = null;
    session.handleStdoutLine(effortTick("max"));
    assertEqual(
      session.currentEffort,
      null,
      "an unrequested reported level is not adopted as applied",
    );
    // A pending re-apply left by that earlier drift cannot apply a level
    // nobody asked for: the pre-prompt sync is keyed on the desired level.
    const noEffortTurn = session.startPrompt("m1", "", "hi");
    await tick();
    assertEqual(
      commandFrames(written).length,
      0,
      "a level nobody asked for schedules no re-apply",
    );
    const realPrompt = frames(written).find(
      (f) => f.method === "session/prompt" && promptText(f) === "hi",
    );
    session.handleStdoutLine(rpcResult(realPrompt!.id!));
    await noEffortTurn;

    // A metadata tick while the command is in flight reports the pre-command
    // level by design: it must not be logged, nor invalidate the belief the
    // command is about to fix.
    session.desiredEffort = "xhigh";
    const { session: busy, written: busyWritten } = startedSession();
    busy.currentEffort = "low";
    busy.desiredEffort = "xhigh";
    const updates: SessionUpdate[] = [];
    busy.updateHandler = (u) => updates.push(u);
    const starting = busy.ensureStarted(catalogProvider, "xhigh");
    await tick();
    busy.handleStdoutLine(effortTick("low"));
    assertEqual(
      busy.currentEffort,
      "low",
      "a mid-command tick does not invalidate the applied level",
    );
    await answerCommand(busy, busyWritten, "Effort set to xhigh\n");
    await starting;
    assert(
      busy.currentEffort === "xhigh" && updates.length === 0,
      "the command still takes effect after such a tick",
    );
  }

  // --- 11. a stable mismatch is re-applied on the next turn ---
  {
    const { session, written } = startedSession();
    session.desiredEffort = "xhigh";
    session.currentEffort = "xhigh";

    session.handleStdoutLine(effortTick("low"));
    assertEqual(
      session.currentEffort,
      null,
      "a reported level other than the desired one invalidates the local belief",
    );

    const starting = session.ensureStarted(catalogProvider, "xhigh");
    await tick();
    const commands = commandFrames(written);
    assert(
      commands.length === 1 && promptText(commands[0]) === "/effort xhigh",
      `the next turn re-sends the desired level (got ${commands.length} commands)`,
    );
    await answerCommand(session, written, "Effort set to xhigh\n");
    await starting;
    assertEqual(
      session.currentEffort,
      "xhigh",
      "the re-applied level is recorded again",
    );
  }

  // --- 11b. kiro's model default, reported with nothing applied, is not a
  // mismatch: there is no applied level to invalidate ---
  {
    const { session, written } = startedSession();
    // A fresh backend: session/set_model has just reported the model's own
    // default effort while this extension has applied nothing.
    session.desiredEffort = "xhigh";
    session.currentEffort = null;

    session.handleStdoutLine(effortTick("max"));
    assertEqual(
      session.currentEffort,
      null,
      "a report with nothing applied leaves the belief alone",
    );
    assert(
      reconcilePending(session) === false,
      "the model's default level is not acted on",
    );

    // And it schedules nothing: the reconciliation the model change already
    // armed is what re-applies the level, so a same-model turn adds no
    // command of its own.
    const prompting = session.startPrompt("m1", "", "hi");
    await tick();
    assertEqual(
      commandFrames(written).length,
      0,
      "the default report alone does not schedule a re-apply",
    );
    const real = frames(written).find(
      (f) => f.method === "session/prompt" && promptText(f) === "hi",
    );
    session.handleStdoutLine(rpcResult(real!.id!));
    await prompting;

    // Genuine drift on the same shape of report still acts: a level applied,
    // and kiro reporting a different one.
    session.currentEffort = "xhigh";
    session.handleStdoutLine(effortTick("high"));
    assertEqual(
      session.currentEffort,
      null,
      "drift from an applied level still invalidates the belief",
    );
    assert(
      reconcilePending(session),
      "drift from an applied level still schedules the re-apply",
    );
  }

  console.log("✓ all effort tests passed");
}

void main();
