// Test: a user message that joins the transcript after a tool result (a steer, or
// a finished subagent's report) reaches Kiro on the next request.
//
// Pi Durable places it between the tool results and the next model request, so
// the context ends [..., assistant(toolCall), toolResult, user(steer)]. The
// provider used to read the tool results, hand them back to Kiro, and never look
// at the user message behind them.
// Run: npm test -- test/steer-after-tool-result.test.ts

import { expect, test } from 'vitest';

import { SessionManager } from '../src/session-manager.ts';
import type { AcpSession } from '../src/session.ts';
import { streamKiroAcp } from '../src/stream.ts';
import { kiroModel } from './support.ts';

const CWD = '/tmp/kiro-acp-steer';
const STEER = 'STEER-TOKEN-123';

const task = { role: 'user', content: 'investigate the build' };
const toolCall = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name: 'probe_tool', arguments: {} }],
});
const toolResult = (id: string, text: string) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'probe_tool',
  isError: false,
  content: [{ type: 'text', text }],
});
const user = (content: string) => ({ role: 'user', content });
const context = (...messages: unknown[]) =>
  ({ messages, systemPrompt: '', tools: [] }) as any;

/** A live keyed session on a fake process, plus a pending bridge call per id. */
async function liveSession(sessionId: string, pendingCallIds: string[]) {
  const manager = new SessionManager();
  const opts = { sessionId, cwd: CWD } as any;
  const routed = await manager.routeSession(context(task), opts);
  const session: AcpSession = routed.session;
  routed.release();
  const frames: any[] = [];
  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        const frame = JSON.parse(chunk);
        frames.push(frame);
        // Kiro answers every request at once, so the stream can finish.
        if (frame.id !== undefined)
          setImmediate(() =>
            session.handleStdoutLine(
              JSON.stringify({
                jsonrpc: '2.0',
                id: frame.id,
                result:
                  frame.method === 'session/prompt'
                    ? { stopReason: 'end_turn' }
                    : frame.method === 'session/new'
                      ? { sessionId: 'acp-2' }
                      : {},
              }),
            ),
          );
        return true;
      },
    },
  } as any;
  session.acpSessionId = 'acp-1';
  session.currentModelId = kiroModel().id;
  session.started = true;
  // What Kiro receives as the answer to each of its tools/call requests.
  const answers = new Map<string, any>();
  for (const id of pendingCallIds) {
    session.pendingToolCalls.set(id, {
      callId: id,
      toolName: 'probe_tool',
      args: {},
      receivedAt: Date.now(),
      emitted: true,
      resolve: (answer: unknown) => answers.set(id, answer),
    } as any);
  }
  const prompts = () =>
    frames
      .filter((frame) => frame.method === 'session/prompt')
      .map((frame) => String(frame.params.prompt[0].text));
  const run = async (ctx: unknown) => {
    for await (const event of streamKiroAcp(
      manager,
      kiroModel(),
      ctx as any,
      opts,
    )) {
      void event;
    }
  };
  return { manager, session, answers, prompts, run };
}

test('a steer after a tool result reaches Kiro with the resumed call', async () => {
  const { manager, answers, prompts, run } = await liveSession('S-one', ['c1']);
  try {
    await run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'build is red'),
        user(STEER),
      ),
    );
    const answer = answers.get('c1');
    expect(answer.result).toContain('build is red');
    expect(answer.result).toContain(STEER);
    expect(answer.result.indexOf('build is red')).toBeLessThan(
      answer.result.indexOf(STEER),
    );
    expect(prompts()).toEqual([]);
  } finally {
    await manager.stopAllSessions();
  }
});

test('a steer after several tool results is delivered once, behind the last result', async () => {
  const { manager, answers, run } = await liveSession('S-many', ['c1', 'c2']);
  try {
    await run(
      context(
        task,
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'probe_tool', arguments: {} },
            { type: 'toolCall', id: 'c2', name: 'probe_tool', arguments: {} },
          ],
        },
        toolResult('c1', 'first result'),
        toolResult('c2', 'second result'),
        user(STEER),
      ),
    );
    expect(answers.get('c1').result).toBe('first result');
    expect(answers.get('c2').result).toContain('second result');
    expect(answers.get('c2').result).toContain(STEER);
  } finally {
    await manager.stopAllSessions();
  }
});

test('two steers in a row both arrive, in order', async () => {
  const { manager, answers, run } = await liveSession('S-two', ['c1']);
  try {
    await run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'ok'),
        user('STEER-A'),
        user('STEER-B'),
      ),
    );
    const text: string = answers.get('c1').result;
    expect(text).toContain('STEER-A');
    expect(text).toContain('STEER-B');
    expect(text.indexOf('STEER-A')).toBeLessThan(text.indexOf('STEER-B'));
  } finally {
    await manager.stopAllSessions();
  }
});

test('a steer placed between two tool rounds is delivered once, not again', async () => {
  const { manager, answers, run } = await liveSession('S-between', ['c2']);
  try {
    // The steer was already delivered on the request after the first round.
    await run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'round one'),
        user(STEER),
        toolCall('c2'),
        toolResult('c2', 'round two'),
      ),
    );
    expect(answers.get('c2').result).toBe('round two');
  } finally {
    await manager.stopAllSessions();
  }
});

test('a request without a steer delivers the tool result unchanged', async () => {
  const { manager, answers, run } = await liveSession('S-none', ['c1']);
  try {
    await run(context(task, toolCall('c1'), toolResult('c1', 'plain')));
    expect(answers.get('c1').result).toBe('plain');
  } finally {
    await manager.stopAllSessions();
  }
});

test('a steer reaches Kiro when the tool result is handed back as a new prompt', async () => {
  // No pending call: Kiro dropped its tools/call, so the result goes back in
  // an orphaned-result recovery prompt.
  const { manager, prompts, run } = await liveSession('S-orphan', []);
  try {
    await run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'late report'),
        user('STEER-A'),
        user('STEER-B'),
      ),
    );
    const sent = prompts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('late report');
    expect(sent[0]).toContain('STEER-A');
    expect(sent[0]).toContain('STEER-B');
    expect(sent[0].indexOf('late report')).toBeLessThan(
      sent[0].indexOf('STEER-A'),
    );
    expect(sent[0].indexOf('STEER-A')).toBeLessThan(sent[0].indexOf('STEER-B'));
  } finally {
    await manager.stopAllSessions();
  }
});

test('a steer reaches Kiro when the tool result carries an image', async () => {
  const { manager, answers, prompts, session, run } = await liveSession(
    'S-image',
    ['c1'],
  );
  // The image path cancels the running prompt first; give it one to cancel.
  session.activePromptDone = Promise.resolve({ stopReason: 'cancelled' });
  try {
    await run(
      context(
        task,
        toolCall('c1'),
        {
          ...toolResult('c1', 'screenshot taken'),
          content: [
            { type: 'text', text: 'screenshot taken' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        user(STEER),
      ),
    );
    expect(answers.get('c1').result).toContain('screenshot taken');
    const sent = prompts().join('\n');
    expect(sent).toContain(STEER);
    expect(sent).toContain('investigate the build');
  } finally {
    await manager.stopAllSessions();
  }
});

test('a steer with no tool result before it is the new prompt', async () => {
  const { manager, prompts, run } = await liveSession('S-plain', []);
  try {
    await run(context(task, { role: 'assistant', content: [] }, user(STEER)));
    expect(prompts().join('\n')).toContain(STEER);
  } finally {
    await manager.stopAllSessions();
  }
});

test('a cold replay carries the tool result and the steer', async () => {
  const manager = new SessionManager();
  try {
    const opts = { sessionId: 'S-cold', cwd: CWD } as any;
    const routed = await manager.routeSession(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'cold result'),
        user(STEER),
      ),
      opts,
    );
    routed.release();
    expect(routed.kind).toBe('orphaned');
    const { buildPromptParts } = await import('../src/helpers.ts');
    const replay = buildPromptParts(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'cold result'),
        user(STEER),
      ),
      true,
    ).userMessage;
    expect(replay).toContain('cold result');
    expect(replay).toContain(STEER);
  } finally {
    await manager.stopAllSessions();
  }
});
