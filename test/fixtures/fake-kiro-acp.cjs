#!/usr/bin/env node
// Fake `kiro-cli` for the agent-engine tests: records its argv and every
// JSON-RPC frame it receives, and answers the handshake the way a backend
// does. A turn is answered with one context_usage tick, one reply chunk, one
// turn_completion tick and the prompt result — never with real model output.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const dir = process.env.FAKE_KIRO_DIR;
const record = (name, value) =>
  fs.appendFileSync(path.join(dir, name), JSON.stringify(value) + '\n');

record('invocations.log', process.argv.slice(2));
const isV3 = process.argv.includes('--agent-engine=v3');
if (process.argv[2] === 'settings') process.exit(0);

const extensionMethods = JSON.parse(
  process.env.FAKE_KIRO_EXTENSION_METHODS || '[]',
);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let unknownRequestId = 7001;

// V3 answers even an unusable profile with a normal response, so the mode the
// client sees is what these tests steer. Defaults to the requested profile.
const modeOf = (params, envName) => {
  const override = process.env[envName];
  return override || params?._meta?.kiro?.modeId || 'vibe';
};
const modes = (currentModeId) => ({
  currentModeId,
  availableModes: [{ id: currentModeId, name: currentModeId }],
});

// V3 config options: `hasEffort`/`effortLevels` decide whether the effortLevel
// select exists, exactly as the real backend does.
const DEFAULT_MODELS = [
  { value: 'auto', name: 'Auto', hasEffort: false },
  {
    value: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    hasEffort: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffortLevel: 'high',
  },
];
const modelList =
  JSON.parse(process.env.FAKE_KIRO_MODELS || 'null') || DEFAULT_MODELS;
const modelOf = (value) => modelList.find((model) => model.value === value);
let currentModel = modelList[0].value;
let currentEffort = modelOf(currentModel).defaultEffortLevel || null;
let sessionMode = 'vibe';
let sessionId = 'fake-session';

function configOptions() {
  const options = [
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: sessionMode,
      options: [{ value: sessionMode, name: sessionMode }],
    },
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: currentModel,
      options: modelList.map((model) => ({
        value: model.value,
        name: model.name || model.value,
        _meta: {
          kiro: {
            hasEffort: !!model.hasEffort,
            ...(model.effortLevels ? { effortLevels: model.effortLevels } : {}),
            ...(model.defaultEffortLevel
              ? { defaultEffortLevel: model.defaultEffortLevel }
              : {}),
          },
        },
      })),
    },
  ];
  const levels = modelOf(currentModel).effortLevels;
  if (currentEffort && levels) {
    options.push({
      type: 'select',
      id: 'effortLevel',
      name: 'Effort',
      category: 'thought_level',
      currentValue: currentEffort,
      options: levels.map((value) => ({ value, name: value })),
    });
  }
  return options;
}

const update = (u) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: u },
  });

// A turn where Kiro rejects its own `tool_call` meta call: pi never sees a
// tools/call for it, only the failed ACP update, and the turn carries on.
// Enabled with FAKE_KIRO_REJECTED_META_CALL=1.
function rejectedMetaCallTurn(promptId) {
  const delay = (ms, fn) => setTimeout(fn, ms);
  delay(50, () => {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'meta-call-1',
      title: 'Tool Call',
      status: 'pending',
      rawInput: {
        tool_id: 'pi_host::bash',
        arguments: '{"command":"ls"}',
      },
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'meta-call-1',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Invalid input for tool_call — arguments: expected object, received string',
          },
        },
      ],
    });
    // A pi_host call Kiro ran and failed: pi owns that one, nothing to surface.
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'pi-host-call-1',
      status: 'failed',
      _meta: { kiro: { mcpServerName: 'pi_host', toolName: 'bash' } },
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'I made a mistake.' },
    });
  });
  // Long enough for pi to run the rejected call and come back for the rest.
  delay(Number(process.env.FAKE_KIRO_REJECTED_CONTINUATION_MS || 600), () => {
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'continuing after the rejection' },
    });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  record('frames.log', msg);
  if (typeof msg.method !== 'string') {
    record('replies.log', msg);
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {},
          _meta: { kiro: { extensionMethods } },
        },
      },
    });
    return;
  }
  if (msg.method === 'session/new') {
    sessionMode = modeOf(msg.params, 'FAKE_KIRO_NEW_MODE');
    // The update and the unknown request land before session/new answers, so
    // the client has to answer them without waiting for the session id.
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: unknownRequestId++,
      method: '_kiro.dev/unknown/request',
      params: {},
    });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId,
        modes: modes(sessionMode),
        configOptions: configOptions(),
        // Only v2 reports models this way; v3 has no `models` at all.
        ...(isV3
          ? {}
          : {
              models: {
                availableModels: modelList.map((model) => ({
                  modelId: model.value,
                  name: model.name || model.value,
                })),
              },
            }),
      },
    });
    return;
  }
  if (msg.method === 'session/load' || msg.method === 'session/resume') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        modes: modes(modeOf(msg.params, 'FAKE_KIRO_LOAD_MODE')),
        configOptions: configOptions(),
      },
    });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    const { configId, value } = msg.params || {};
    if (configId === 'model') {
      // The real backend accepts any model value and echoes it back.
      currentModel = value;
      const model = modelOf(value) || {};
      currentEffort = model.defaultEffortLevel || null;
    } else if (configId === 'effortLevel') {
      const levels = modelOf(currentModel).effortLevels || [];
      if (levels.indexOf(value) >= 0) currentEffort = value;
    }
    const reply = { configOptions: configOptions() };
    send({ jsonrpc: '2.0', id: msg.id, result: reply });
    update({
      sessionUpdate: 'config_option_update',
      configOptions: reply.configOptions,
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (msg.params && msg.params.sessionId) sessionId = msg.params.sessionId;
    if (process.env.FAKE_KIRO_REJECTED_META_CALL === '1') {
      rejectedMetaCallTurn(msg.id);
      return;
    }
    update({
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'context_usage', usagePercentage: 12.5 } },
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'turn_start', messageId: 'turn-start' } },
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: process.env.FAKE_KIRO_REPLY || 'hello from v3',
      },
    });
    update({
      sessionUpdate: 'session_info_update',
      _meta: {
        kiro: {
          kind: 'turn_completion',
          elapsedTime: 1234,
          promptTurnSummaries: [
            { unit: 'credit', unitPlural: 'credits', usage: 0.05 },
          ],
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.id === undefined) return;
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
rl.on('close', () => process.exit(0));
