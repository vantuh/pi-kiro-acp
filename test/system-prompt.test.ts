// Test: the system prompt reaches Kiro from the transcript's system messages.
// Run: test/run-all.sh test/system-prompt.test.ts

import { normalizeContext } from "@earendil-works/pi-ai";
import { buildPromptParts } from "../helpers.ts";
import { assert, fakeSession } from "./support.ts";

const SYSTEM_PROMPT = "AGENTS.md instructions";

/** The context shape pi hands a provider: normalizeContext folds the prompt and
 * the tool declarations into the transcript's leading system message. */
function transcriptContext(systemPrompt?: string) {
  return normalizeContext({
    messages: [{ role: "user", content: "hello", timestamp: 2 }],
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  });
}

async function main(): Promise<void> {
  // --- buildPromptParts reads the prompt out of the transcript ---
  // A TranscriptContext has no systemPrompt field. Reading context.systemPrompt
  // yielded "" and silently dropped every standing instruction from the prompt.
  {
    const parts = buildPromptParts(transcriptContext(SYSTEM_PROMPT), false);
    assert(
      parts.systemPrompt === SYSTEM_PROMPT,
      "the prompt comes from the transcript's system message",
    );
    assert(parts.userMessage === "hello", "the user message is unchanged");
  }

  {
    const parts = buildPromptParts(transcriptContext(), false);
    assert(
      parts.systemPrompt === "",
      "a transcript without a system message yields an empty prompt",
    );
  }

  // A mid-conversation system message carries added instructions (pi replays
  // every system message into the current prompt).
  {
    const context = transcriptContext(SYSTEM_PROMPT);
    context.messages.push({
      role: "system",
      content: "Added mid-conversation.",
      timestamp: 3,
    });
    const parts = buildPromptParts(context, false);
    assert(
      parts.systemPrompt.includes(SYSTEM_PROMPT) &&
        parts.systemPrompt.includes("Added mid-conversation."),
      "later system messages are replayed into the prompt",
    );
  }

  // --- session/prompt carries <system_instructions> on the wire ---
  {
    const { session, written } = fakeSession({
      acpSessionId: "s-1",
      currentModelId: "m1",
      parseJson: true,
    });
    const { systemPrompt } = buildPromptParts(
      transcriptContext(SYSTEM_PROMPT),
      false,
    );

    await session.startPrompt("m1", systemPrompt, "hello");
    const first = written.find((f) => f.method === "session/prompt");
    const firstText = first?.params?.prompt?.[0]?.text ?? "";
    assert(
      firstText.startsWith(`<system_instructions>\n${SYSTEM_PROMPT}`),
      "the first prompt opens with the <system_instructions> block",
    );

    // The block is sent once per ACP session, and again only when pi changes it.
    await session.startPrompt("m1", systemPrompt, "again");
    const prompts = written.filter((f) => f.method === "session/prompt");
    assert(prompts.length === 2, "both prompts reached the wire");
    assert(
      !prompts[1].params.prompt[0].text.includes("<system_instructions>"),
      "an unchanged prompt is not re-sent",
    );
  }

  console.log("✓ all system-prompt tests passed");
}

void main();
