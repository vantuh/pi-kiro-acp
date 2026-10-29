// Test: a meta tool call Kiro rejects itself (`tool_call` / `tool_load`) reaches
// pi as a failed tool call instead of only the model's apology in text. Kiro
// validates the meta call before any tools/call, so the pi_host bridge — and pi —
// never see it: no pending call, no result, nothing to answer on Kiro's side.
// Drives a real AcpSession against the fake `kiro-cli` ACP server.
// Run: npm test -- test/rejected-meta-tool-call.test.ts

import type { Context } from '@earendil-works/pi-ai';
import { test } from 'vitest';

import {
  rejectedMetaCallArgs,
  rejectedMetaToolName,
} from '../src/meta-tool-call.ts';
import { SessionManager } from '../src/session-manager.ts';
import { streamKiroAcp } from '../src/stream.ts';
import {
  assert,
  fakeKiroCli,
  hermeticEnv,
  kiroContext,
  kiroModel,
  withEnv,
} from './support.ts';

/** One whole turn, as pi would consume it. */
async function runTurn(manager: SessionManager, context: Context) {
  const stream = streamKiroAcp(manager, kiroModel(), context, {});
  const events: any[] = [];
  let text = '';
  for await (const event of stream as any) {
    events.push(event);
    if (event.type === 'text_delta') text += event.delta;
  }
  return {
    text,
    events,
    done: events.find((event) => event.type === 'done')?.reason,
    toolCalls: events
      .filter((event) => event.type === 'toolcall_end')
      .map((event) => event.toolCall),
  };
}

/** What pi hands back after answering an unknown tool with an error result. */
function withToolResult(context: Context, turn: { events: any[] }): Context {
  const done = turn.events.find((event) => event.type === 'done');
  const toolCall = done.message.content.find(
    (block: any) => block.type === 'toolCall',
  );
  return {
    ...context,
    messages: [
      ...context.messages,
      done.message,
      {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: true,
        content: [{ type: 'text', text: `Tool ${toolCall.name} not found` }],
      },
    ],
  } as Context;
}

test("a rejected meta call is described from Kiro's own update", () => {
  const failed = {
    sessionUpdate: 'tool_call_update',
    status: 'failed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Unknown tool_id "pi_host">\n</invoke>\n". Use an exact id from the deferred tools catalog',
        },
      },
    ],
  };
  assert(
    rejectedMetaToolName(failed, { toolName: 'Tool Call' }) === 'tool_call',
    'a failed Tool Call is a rejection',
  );
  assert(
    rejectedMetaToolName({ status: 'failed', title: 'Tool Call' }, {}) ===
      'tool_call',
    "a failed update's own title identifies the meta call",
  );
  assert(
    rejectedMetaToolName(failed, { toolName: 'Tool Load' }) === 'tool_load',
    'the tool_load title normalizes to its meta name',
  );
  assert(
    rejectedMetaToolName({ status: 'completed' }, { toolName: 'Tool Call' }) ===
      null,
    'only a failed call is a rejection',
  );
  assert(
    rejectedMetaToolName(failed, { toolName: 'bash', mcpServer: 'pi_host' }) ===
      null,
    'a failed pi_host call belongs to pi, not to Kiro',
  );

  const args = rejectedMetaCallArgs(failed, {
    tool_id: 'pi_host">\n</invoke>\n',
    arguments: { cmd: 'x'.repeat(2000) },
  });
  assert(
    args.tool_id === 'pi_host">\n</invoke>\n',
    'the tool_id is kept as Kiro received it',
  );
  assert(
    String(args.arguments).endsWith('…') && String(args.arguments).length < 520,
    'a huge argument blob is clipped',
  );
  assert(
    String(args.error).includes('Unknown tool_id'),
    "Kiro's message is carried over",
  );
  assert(
    String(rejectedMetaCallArgs(failed, undefined).error).includes(
      'Unknown tool_id',
    ),
    'the error survives without an input to describe',
  );
});

test('an error Kiro reports in several fields is shown once', () => {
  const message = 'Invalid input for tool_call — arguments: expected object';
  const args = rejectedMetaCallArgs(
    {
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: message } }],
      rawOutput: message,
    },
    undefined,
  );
  assert(args.error === message, `the message is not repeated: ${args.error}`);
});

test('a Kiro-rejected meta tool call', async () => {
  // --- Kiro keeps its turn open: pi sees the call, then the continuation ---
  {
    const env = hermeticEnv();
    const fake = fakeKiroCli();
    const restoreEnv = withEnv({ FAKE_KIRO_REJECTED_META_CALL: '1' });
    const manager = new SessionManager();
    try {
      const context = kiroContext('say hi');
      const first = await runTurn(manager, context);

      assert(
        first.toolCalls.length === 1,
        `only the rejected meta call reaches pi (got ${JSON.stringify(first.toolCalls.map((c: any) => c.name))})`,
      );
      const call = first.toolCalls[0];
      assert(
        call.name === 'tool_call',
        `the call keeps Kiro's meta tool name (got "${call.name}")`,
      );
      assert(
        call.arguments.tool_id === 'pi_host::bash',
        `the meta call's tool_id is carried through (got ${JSON.stringify(call.arguments)})`,
      );
      assert(
        call.arguments.arguments === '{"command":"ls"}',
        'the arguments stay exactly as Kiro received them, string and all',
      );
      assert(
        String(call.arguments.error).includes('expected object'),
        `Kiro's error text is carried through (got "${call.arguments.error}")`,
      );
      assert(
        first.done === 'toolUse',
        `the turn ends with toolUse so pi runs the call (got "${first.done}")`,
      );
      assert(
        first.text.includes('I made a mistake.'),
        "the model's own text still streams",
      );

      // pi answered the unknown tool name locally; the stream re-attaches to
      // Kiro's still-running prompt instead of starting a new turn.
      const second = await runTurn(manager, withToolResult(context, first));
      assert(
        second.text.includes('continuing after the rejection'),
        `Kiro's continuation is read back (got "${second.text}")`,
      );
      assert(
        second.done === 'stop',
        `the continuation ends the turn normally (got "${second.done}")`,
      );
      const frames = fake.frames();
      assert(
        frames.filter((frame) => frame.method === 'session/prompt').length ===
          1,
        'the rejected call is answered inside pi, not by a new prompt',
      );
      assert(
        !frames.some((frame) => frame.method === 'session/cancel'),
        "Kiro's turn is left alone",
      );
    } finally {
      await manager.stopAllSessions();
      restoreEnv();
      fake.restore();
      env.restore();
    }
  }

  // --- Kiro already finished: pi's own answer ends the turn, without an error ---
  {
    const env = hermeticEnv();
    const fake = fakeKiroCli();
    const restoreEnv = withEnv({
      FAKE_KIRO_REJECTED_META_CALL: '1',
      FAKE_KIRO_REJECTED_CONTINUATION_MS: '150',
    });
    const manager = new SessionManager();
    try {
      const context = kiroContext('say hi');
      const first = await runTurn(manager, context);
      assert(
        first.toolCalls.length === 1,
        'the rejected call reaches pi even when the prompt settles first',
      );
      const second = await runTurn(manager, withToolResult(context, first));
      assert(
        second.done === 'stop',
        `nothing is left to read, so the turn stops (got "${second.done}")`,
      );
      assert(second.text === '', 'no text is invented for it');
      assert(
        !fake.frames().some((frame) => frame.method === 'session/cancel'),
        'no recovery prompt or cancel is sent',
      );
    } finally {
      await manager.stopAllSessions();
      restoreEnv();
      fake.restore();
      env.restore();
    }
  }
});
