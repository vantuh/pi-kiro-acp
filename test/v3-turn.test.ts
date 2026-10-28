// Test: the Kiro V3 turn path — model/effort through session/set_config_option,
// session_info_update telemetry, and the one-shot permission gate. Driven by a
// fake ACP session: no kiro-cli is spawned.
// Run: npm test -- test/v3-turn.test.ts

// Keep session.ts's persistence import hermetic before it loads.
process.env.XDG_DATA_HOME ??= '/tmp/kiro-acp-test-data';

import { test } from 'vitest';

import { AcpSession } from '../src/session.ts';
import { assert, fakeSession, parseLines, settled, tick } from './support.ts';

/** The model select kiro returns: only `claude-sonnet-4.6` supports effort. */
const MODEL_CHOICES = [
  { value: 'auto', name: 'Auto', _meta: { kiro: { hasEffort: false } } },
  {
    value: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    _meta: {
      kiro: {
        hasEffort: true,
        effortLevels: ['low', 'medium', 'high', 'max'],
        defaultEffortLevel: 'high',
      },
    },
  },
  {
    value: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    _meta: { kiro: { hasEffort: false } },
  },
];

/** A configOptions array as kiro would report it for this (model, effort). */
function optionsFor(
  model: string,
  effort: string | null,
  models: any[] = MODEL_CHOICES,
): any[] {
  const choice = models.find((option) => option.value === model);
  const options: any[] = [
    {
      type: 'select',
      id: 'mode',
      currentValue: 'pi-kiro-test',
      options: [{ value: 'pi-kiro-test' }],
    },
    { type: 'select', id: 'model', currentValue: model, options: models },
  ];
  const levels = choice?._meta?.kiro?.effortLevels;
  if (levels)
    options.push({
      type: 'select',
      id: 'effortLevel',
      currentValue: effort ?? choice._meta.kiro.defaultEffortLevel,
      options: levels.map((value: string) => ({ value })),
    });
  return options;
}

/** A started V3 session whose writes are captured, not spawned. */
function v3Session(): { session: AcpSession; written: string[] } {
  const fake = fakeSession({ started: true, acpSessionId: 'acp-1' });
  fake.session.engine = 'v3';
  return fake;
}

function feedConfigOptions(session: AcpSession, configOptions: unknown): void {
  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-1',
        update: { sessionUpdate: 'config_option_update', configOptions },
      },
    }),
  );
}

function resultFor(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/** Frames written to kiro so far, parsed. */
function framesSoFar(written: string[]): any[] {
  return parseLines([...written]);
}

function configOptionFrames(written: string[]): any[] {
  return framesSoFar(written).filter(
    (frame) => frame.method === 'session/set_config_option',
  );
}

test('v3 sets the model and its effort through session/set_config_option', async () => {
  const { session, written } = v3Session();
  feedConfigOptions(session, optionsFor('auto', null));
  session.desiredEffort = 'high';

  const turn = session.startPrompt('claude-sonnet-4.6', '', 'hi');
  await tick();

  const [modelFrame] = configOptionFrames(written);
  assert(
    modelFrame?.params?.configId === 'model' &&
      modelFrame.params.value === 'claude-sonnet-4.6',
    'the pi model id is written as the model config option',
  );
  assert(
    !framesSoFar(written).some(
      (frame) =>
        frame.method === 'session/set_model' ||
        JSON.stringify(frame.params ?? {}).includes('/effort'),
    ),
    'no v2 set_model or /effort command prompt is sent',
  );

  // kiro echoes the model and now advertises the effortLevel select.
  session.handleStdoutLine(
    resultFor(modelFrame.id, {
      configOptions: optionsFor('claude-sonnet-4.6', null),
    }),
  );
  await tick();

  const effortFrame = configOptionFrames(written)[1];
  assert(
    effortFrame?.params?.configId === 'effortLevel' &&
      effortFrame.params.value === 'high',
    'the requested effort level is written once the model advertises it',
  );
  session.handleStdoutLine(
    resultFor(effortFrame.id, {
      configOptions: optionsFor('claude-sonnet-4.6', 'high'),
    }),
  );
  await tick();

  const promptFrame = framesSoFar(written).find(
    (frame) => frame.method === 'session/prompt',
  );
  assert(!!promptFrame, 'the turn is sent once the config is applied');
  session.handleStdoutLine(
    resultFor(promptFrame.id, { stopReason: 'end_turn' }),
  );
  await turn;

  assert(
    session.currentModelId === 'claude-sonnet-4.6' &&
      session.currentEffort === 'high',
    'the applied values are recorded on the session',
  );

  // A second turn with the same model and level writes nothing.
  const before = written.length;
  const next = session.startPrompt('claude-sonnet-4.6', '', 'hi');
  await tick();
  assert(
    written.length === before + 1 &&
      framesSoFar(written).at(-1)?.method === 'session/prompt',
    `an unchanged model and level cost one prompt RPC only (got ${framesSoFar(written).at(-1)?.method})`,
  );
  session.handleStdoutLine(
    resultFor(framesSoFar(written).at(-1)!.id, { stopReason: 'end_turn' }),
  );
  await next;
});

test('v3 skips an effort level the model does not advertise', async () => {
  const { session, written } = v3Session();
  feedConfigOptions(session, optionsFor('claude-sonnet-4.6', 'high'));
  session.currentModelId = 'claude-sonnet-4.6';
  // `xhigh` is a real kiro level, but not for this model's option list.
  session.desiredEffort = 'xhigh';

  const turn = session.startPrompt('claude-sonnet-4.6', '', 'hi');
  await tick();

  assert(
    configOptionFrames(written).length === 0,
    'no effort value is written for a level the model does not offer',
  );
  const promptFrame = framesSoFar(written).find(
    (frame) => frame.method === 'session/prompt',
  );
  assert(!!promptFrame, 'the turn still runs');
  session.handleStdoutLine(
    resultFor(promptFrame.id, { stopReason: 'end_turn' }),
  );
  await turn;
  assert(
    session.currentEffort === null,
    'a skipped level is not recorded as applied',
  );
});

test('v3 records only the config values kiro echoes back', async () => {
  const { session, written } = v3Session();
  feedConfigOptions(session, optionsFor('claude-sonnet-4.6', 'high'));
  session.currentModelId = 'claude-sonnet-4.6';
  session.desiredEffort = 'low';

  const turn = session.startPrompt('claude-sonnet-4.6', '', 'hi');
  await tick();

  const [effortFrame] = configOptionFrames(written);
  assert(
    effortFrame?.params?.configId === 'effortLevel' &&
      effortFrame.params.value === 'low',
    'the requested level is written',
  );
  // kiro accepts the write but keeps its own level: the request is not applied.
  session.handleStdoutLine(
    resultFor(effortFrame.id, {
      configOptions: optionsFor('claude-sonnet-4.6', 'high'),
    }),
  );
  await tick();
  const promptFrame = framesSoFar(written).find(
    (frame) => frame.method === 'session/prompt',
  );
  session.handleStdoutLine(
    resultFor(promptFrame.id, { stopReason: 'end_turn' }),
  );
  await turn;

  assert(
    session.currentEffort === null,
    `an unapplied level is not recorded (got ${session.currentEffort})`,
  );
});

test('v3 refuses a model id it was not offered', async () => {
  const { session, written } = v3Session();
  feedConfigOptions(session, optionsFor('auto', null));

  const turn = await settled(session.startPrompt('gpt-9.9', '', 'hi'));

  assert(!turn.ok, 'startPrompt rejects for an unknown model');
  assert(
    turn.error?.message ===
      'Kiro V3 does not offer model gpt-9.9 (offered: auto, claude-sonnet-4.6, claude-haiku-4.5); refresh the model list or pick another',
    `the error names the model and the alternatives (got "${turn.error?.message}")`,
  );
  assert(written.length === 0, 'no RPC is sent for a model kiro cannot select');
  assert(session.currentModelId === null, 'nothing is recorded as applied');
});

test('v3 session_info_update telemetry reaches the metadata only', async () => {
  const { session } = v3Session();
  const seen: any[] = [];
  const forwarded: any[] = [];
  session.onMetadata = (metadata) => seen.push({ ...metadata });
  session.updateHandler = (update) => forwarded.push(update);

  const info = (kiro: Record<string, unknown>, sessionId = 'acp-1') =>
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'session_info_update', _meta: { kiro } },
        },
      }),
    );

  info({ kind: 'context_usage', usagePercentage: 12.5 });
  assert(
    seen.length === 1 && seen[0].contextUsagePercentage === 12.5,
    'context_usage becomes contextUsagePercentage',
  );

  info({
    kind: 'turn_completion',
    elapsedTime: 1234,
    promptTurnSummaries: [
      { unit: 'credit', unitPlural: 'credits', usage: 0.05 },
      { unit: 'credit', unitPlural: 'credits', usage: 0.02 },
    ],
  });
  assert(
    seen.length === 2 &&
      seen[1].turnDurationMs === 1234 &&
      JSON.stringify(seen[1].meteringUsage) ===
        JSON.stringify([
          { unit: 'credit', unitPlural: 'credits', value: 0.05 },
          { unit: 'credit', unitPlural: 'credits', value: 0.02 },
        ]),
    'turn_completion becomes the turn duration and the metered credits',
  );
  assert(
    seen[1].contextUsagePercentage === 12.5,
    'the earlier context usage survives the next tick',
  );

  for (const kind of [
    'turn_start',
    'turn_end',
    'focus_update',
    'steering_queued',
    'steering_injected',
    'steering_cleared',
    'user_message_id_assigned',
  ])
    info({ kind });
  assert(seen.length === 2, 'the other kinds record nothing');

  info({ kind: 'context_usage', usagePercentage: 99 }, 'someone-else');
  assert(
    seen.length === 2 && seen[1].contextUsagePercentage === 12.5,
    'a foreign session id is ignored',
  );
  assert(forwarded.length === 0, 'no session_info_update reaches the stream');

  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'model output' },
        },
      },
    }),
  );
  assert(forwarded.length === 1, 'model output still reaches the stream');
});
