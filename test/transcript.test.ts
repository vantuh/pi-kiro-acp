// Test: conversation transcript building, tool-result extraction, and the
// fingerprint-keyed session persistence that kiro-acp resumes from.
// Run: test/run-all.sh test/transcript.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

const dataHome = mkdtempSync(join(tmpdir(), "kiro-acp-transcript-"));
process.env.XDG_DATA_HOME = dataHome;

const {
  buildConversationPrompt,
  buildToolResultRecoveryPrompt,
  extractToolResults,
  imagesFromToolResults,
  lastUserMessage,
} = await import("../helpers.ts");
const {
  clearPersistedKiroSession,
  historyFingerprintAfterAssistantTurn,
  historyFingerprintBeforeCurrentUser,
  loadPersistedKiroSession,
  persistenceKeyForSession,
  savePersistedKiroSession,
} = await import("../session-persistence.ts");

let failed = false;

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    failed = true;
    return;
  }
  console.log(`✓ ${label}`);
}

const ctx = (messages: unknown[]): Context => ({ messages }) as any;
const user = (text: string) => ({ role: "user", content: text });
const assistantText = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

// --- transcript building ---
{
  assert(
    buildConversationPrompt(ctx([])) === "",
    "no user message yields an empty prompt",
  );
  assert(
    buildConversationPrompt(ctx([assistantText("orphan")])) === "",
    "assistant-only history yields an empty prompt",
  );

  const single = buildConversationPrompt(ctx([user("hello")]));
  assert(
    single === "<current_user_message>\nhello\n</current_user_message>",
    "a lone user message needs no history block",
  );

  const withHistory = buildConversationPrompt(
    ctx([user("first"), assistantText("answer"), user("second")]),
  );
  assert(
    withHistory.includes("<conversation_history>"),
    "prior turns are wrapped in conversation_history",
  );
  assert(
    withHistory.includes('<message role="user">\nfirst\n</message>'),
    "history keeps earlier user turns",
  );
  assert(
    withHistory.includes("<text>\nanswer\n</text>"),
    "history keeps assistant text",
  );
  assert(
    withHistory.endsWith(
      "<current_user_message>\nsecond\n</current_user_message>",
    ),
    "the latest user message ends the prompt",
  );
  assert(
    !withHistory.includes('<message role="user">\nsecond'),
    "the current message is not duplicated into history",
  );

  const escaped = buildConversationPrompt(ctx([user("a & b <tag> c")]));
  assert(
    escaped.includes("a &amp; b &lt;tag&gt; c"),
    "user text is XML-escaped",
  );

  const toolCallHistory = buildConversationPrompt(
    ctx([
      user("q"),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: 'c"1',
            name: "web_search",
            arguments: { query: "x" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: 'c"1',
        toolName: "web_search",
        isError: true,
        content: [{ type: "text", text: "failed <hard>" }],
      },
      user("q2"),
    ]),
  );
  assert(
    toolCallHistory.includes('<tool_call id="c&quot;1" name="web_search">'),
    "tool call attributes are escaped",
  );
  assert(
    toolCallHistory.includes('is_error="true"'),
    "tool result errors are marked in history",
  );
  assert(
    toolCallHistory.includes("failed &lt;hard&gt;"),
    "tool result text is escaped",
  );

  const long = "x".repeat(13000);
  const truncated = buildConversationPrompt(
    ctx([user(long), assistantText("ok"), user("now")]),
  );
  assert(
    truncated.includes("[...truncated 1000 chars...]"),
    "long history messages are truncated",
  );
  const currentLong = buildConversationPrompt(ctx([user(long)]));
  assert(
    !currentLong.includes("truncated"),
    "the current user message is never truncated",
  );

  assert(
    lastUserMessage(ctx([user("a"), assistantText("b"), user("c")])) === "c",
    "lastUserMessage returns the latest user turn",
  );
  assert(
    lastUserMessage(
      ctx([
        {
          role: "user",
          content: [
            { type: "text", text: "part1" },
            { type: "image", data: "zz", mimeType: "image/png" },
            { type: "text", text: "part2" },
          ],
        },
      ]),
    ) === "part1\npart2",
    "lastUserMessage joins text blocks and skips images",
  );
  assert(
    lastUserMessage(ctx([])) === "",
    "lastUserMessage tolerates an empty context",
  );
}

// --- replay must carry work already done for the current message ---
// A fresh Kiro session is rebuilt purely from this transcript. Dropping the tool
// calls made since the last user message made it redo them (relaunching the same
// subagent over and over).
{
  const midTurn = buildConversationPrompt(
    ctx([
      user("compare A and B"),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "probe_tool",
            arguments: { task: "compare" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "probe_tool",
        isError: false,
        content: [{ type: "text", text: "the report" }],
      },
    ]),
  );
  assert(
    midTurn.includes(
      "<current_user_message>\ncompare A and B\n</current_user_message>",
    ),
    "the current message is still present mid-turn",
  );
  assert(
    midTurn.includes("<work_already_done>"),
    "work performed for the current message is replayed",
  );
  assert(
    midTurn.includes('<tool_call id="c1" name="probe_tool">'),
    "the already-issued tool call is replayed",
  );
  assert(
    midTurn.includes("the report"),
    "the already-received tool result is replayed",
  );
  assert(
    midTurn.indexOf("<current_user_message>") <
      midTurn.indexOf("<work_already_done>"),
    "completed work follows the current message",
  );
  assert(
    !midTurn.includes("<conversation_history>"),
    "a first-turn replay needs no history block",
  );

  const settled = buildConversationPrompt(
    ctx([user("a"), assistantText("b"), user("c")]),
  );
  assert(
    !settled.includes("<work_already_done>"),
    "a turn with nothing done yet omits the block",
  );
}

// --- recovery prompt for a tools/call Kiro abandoned ---
{
  const recovery = buildToolResultRecoveryPrompt([
    {
      toolCallId: "c1",
      toolName: "probe_tool",
      text: "report <body>",
      isError: false,
    },
    { toolCallId: "c2", toolName: "web_search", text: "boom", isError: true },
  ]);
  assert(
    recovery.includes("Do not call the tool again."),
    "the recovery prompt forbids re-running the tool",
  );
  assert(
    recovery.includes('<tool_result name="probe_tool" is_error="false">'),
    "each recovered result is labelled",
  );
  assert(
    recovery.includes("report &lt;body&gt;"),
    "recovered result text is escaped",
  );
  assert(
    recovery.includes('is_error="true"'),
    "recovered errors stay marked as errors",
  );

  const long = buildToolResultRecoveryPrompt([
    {
      toolCallId: "c1",
      toolName: "t",
      text: "y".repeat(21000),
      isError: false,
    },
  ]);
  assert(
    long.includes("[...truncated 1000 chars...]"),
    "oversized recovered results are truncated",
  );
}

// --- image blocks carried by tool results ---
{
  const images = imagesFromToolResults([
    { toolCallId: "c1", toolName: "a", text: "t", isError: false },
    {
      toolCallId: "c2",
      toolName: "b",
      text: "t",
      isError: false,
      content: [
        { type: "text", text: "t" },
        { type: "image", data: "AAA", mimeType: "image/png" },
      ],
    },
  ]);
  assert(
    images.length === 1 && images[0].data === "AAA",
    "only image blocks are collected from tool results",
  );
}

// --- tool-result extraction (drives resumption routing) ---
{
  const results = extractToolResults(
    ctx([
      user("q"),
      assistantText("thinking"),
      {
        role: "toolResult",
        toolCallId: "id-1",
        toolName: "web_search",
        isError: false,
        content: [{ type: "text", text: "one" }],
      },
      {
        role: "toolResult",
        toolCallId: "id-2",
        toolName: "fetch_content",
        isError: true,
        content: [{ type: "text", text: "two" }],
      },
    ]),
  );
  assert(results.length === 2, "trailing tool results are collected");
  assert(
    results[0].toolCallId === "id-1" && results[1].toolCallId === "id-2",
    "tool results keep transcript order",
  );
  assert(results[1].isError === true, "error flags survive extraction");
  assert(
    results[0].content === undefined,
    "text-only results carry no content blocks",
  );

  const withImage = extractToolResults(
    ctx([
      {
        role: "toolResult",
        toolCallId: "id-3",
        toolName: "shell",
        isError: false,
        content: [
          { type: "text", text: "shot" },
          { type: "image", data: "AAA", mimeType: "image/png" },
        ],
      },
    ]),
  );
  assert(
    withImage[0].content?.length === 2,
    "image results keep their content blocks",
  );
  assert(withImage[0].text === "shot", "image results still expose their text");

  const stopsAtAssistant = extractToolResults(
    ctx([
      {
        role: "toolResult",
        toolCallId: "old",
        toolName: "web_search",
        isError: false,
        content: [{ type: "text", text: "old" }],
      },
      assistantText("newer turn"),
    ]),
  );
  assert(
    stopsAtAssistant.length === 0,
    "extraction stops at the last assistant message",
  );
}

// --- history fingerprints ---
{
  const base = [user("first"), assistantText("answer"), user("current")];
  const fp = historyFingerprintBeforeCurrentUser(ctx(base));
  assert(
    fp === historyFingerprintBeforeCurrentUser(ctx([...base])),
    "fingerprints are stable for identical history",
  );
  assert(
    fp !==
      historyFingerprintBeforeCurrentUser(
        ctx([user("first"), assistantText("other"), user("current")]),
      ),
    "changed history changes the fingerprint",
  );
  assert(
    fp ===
      historyFingerprintBeforeCurrentUser(
        ctx([
          user("first"),
          assistantText("answer"),
          user("different current"),
        ]),
      ),
    "the current user message is excluded",
  );

  const withThinking = ctx([
    user("first"),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "answer" },
      ],
    },
    user("current"),
  ]);
  assert(
    fp === historyFingerprintBeforeCurrentUser(withThinking),
    "thinking blocks are ignored (they are not replayed)",
  );

  const withDisplayCard = ctx([
    user("first"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        // Legacy native-tool card, as emitted by the removed mirror.
        {
          type: "text",
          text: "<!--kiro-tool-->\n🔧 ls\nfile\n<!--/kiro-tool-->\n",
        },
      ],
    },
    user("current"),
  ]);
  assert(
    fp === historyFingerprintBeforeCurrentUser(withDisplayCard),
    "display-only native tool cards are ignored",
  );

  const withDisplayTextFrame = ctx([
    user("first"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        // Legacy one-liner frame, as emitted by the removed mirror.
        { type: "text", text: "🔧 read foo ✓\n" },
      ],
    },
    user("current"),
  ]);
  assert(
    fp === historyFingerprintBeforeCurrentUser(withDisplayTextFrame),
    "display-only native tool text frames are ignored",
  );

  const argsOrderA = ctx([
    user("q"),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "t", arguments: { a: 1, b: 2 } },
      ],
    },
    user("c"),
  ]);
  const argsOrderB = ctx([
    user("q"),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "t", arguments: { b: 2, a: 1 } },
      ],
    },
    user("c"),
  ]);
  assert(
    historyFingerprintBeforeCurrentUser(argsOrderA) ===
      historyFingerprintBeforeCurrentUser(argsOrderB),
    "tool-call argument key order does not change the fingerprint",
  );

  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "reply" }],
  } as any;
  const after = historyFingerprintAfterAssistantTurn(ctx(base), assistant);
  assert(
    after !== fp,
    "the post-turn fingerprint differs from the pre-turn one",
  );
  assert(
    after ===
      historyFingerprintBeforeCurrentUser(
        ctx([...base, assistant, user("next")]),
      ),
    "the post-turn fingerprint matches the next turn's pre-turn fingerprint",
  );
}

// --- persisted session store ---
{
  const key = persistenceKeyForSession("pi-session-1", "/tmp/project");
  assert(key.includes("/"), "the persistence key is namespaced by cwd hash");
  assert(
    key !== persistenceKeyForSession("pi-session-1", "/tmp/other"),
    "the same pi session in another cwd gets another key",
  );
  assert(
    persistenceKeyForSession("a/b:c", "/tmp/project").endsWith("a_b_c"),
    "unsafe id characters are sanitized",
  );

  assert(
    loadPersistedKiroSession(key) === null,
    "loading an unknown key yields null",
  );

  savePersistedKiroSession(key, {
    version: 1,
    kiroSessionId: "acp-42",
    historyFingerprint: "fp-1",
    modelId: "claude-opus-5",
    createdAt: Date.now(),
    lastUsed: Date.now(),
  });
  const loaded = loadPersistedKiroSession(key);
  assert(loaded?.kiroSessionId === "acp-42", "a saved session round-trips");
  assert(
    loaded?.historyFingerprint === "fp-1",
    "the history fingerprint round-trips",
  );
  assert(loaded?.modelId === "claude-opus-5", "the model id round-trips");

  savePersistedKiroSession(key, {
    version: 1,
    kiroSessionId: "acp-stale",
    historyFingerprint: "fp-1",
    createdAt: 0,
    lastUsed: Date.now() - 25 * 60 * 60 * 1000,
  });
  assert(
    loadPersistedKiroSession(key) === null,
    "sessions older than the TTL are ignored",
  );

  savePersistedKiroSession(key, {
    version: 2,
    kiroSessionId: "acp-future",
    historyFingerprint: "fp",
  } as any);
  assert(
    loadPersistedKiroSession(key) === null,
    "unknown persistence versions are ignored",
  );

  savePersistedKiroSession(key, {
    version: 1,
    kiroSessionId: "acp-99",
    historyFingerprint: "fp-2",
    createdAt: Date.now(),
    lastUsed: Date.now(),
  });
  assert(
    loadPersistedKiroSession(key)?.kiroSessionId === "acp-99",
    "saving overwrites the previous record",
  );
  clearPersistedKiroSession(key);
  assert(loadPersistedKiroSession(key) === null, "clearing removes the record");
  clearPersistedKiroSession(key);
  assert(true, "clearing a missing record is a no-op");
}

rmSync(dataHome, { recursive: true, force: true });

if (failed) process.exit(1);
console.log("✓ all transcript tests passed");
