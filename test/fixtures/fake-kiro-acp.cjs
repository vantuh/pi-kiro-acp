#!/usr/bin/env node
// Fake `kiro-cli` for the agent-engine tests: records its argv and every
// JSON-RPC frame it receives, and answers the handshake the way a backend
// does. It never answers a turn prompt with real output — it only proves what
// the client sent.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const dir = process.env.FAKE_KIRO_DIR;
const record = (name, value) =>
  fs.appendFileSync(path.join(dir, name), JSON.stringify(value) + '\n');

record('invocations.log', process.argv.slice(2));
if (process.argv[2] === 'settings') process.exit(0);

const extensionMethods = JSON.parse(
  process.env.FAKE_KIRO_EXTENSION_METHODS || '[]',
);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let unknownRequestId = 7001;

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
      result: { sessionId: 'fake-session' },
    });
    return;
  }
  if (msg.id === undefined) return;
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
rl.on('close', () => process.exit(0));
