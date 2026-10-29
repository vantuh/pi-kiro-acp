#!/usr/bin/env node
// Live probe of the PROVIDER's steer path against the REAL kiro-cli: a pi tool
// call is still running when the user's next message arrives, exactly as Pi
// Durable delivers a mid-run steer (the steer follows the tool result).
//
//   KIRO_E2E_LIVE=full node test/e2e/steer.mjs [--engine v2|v3] [--fallback]
//
// Default: v2, then v3, each in its own child process so the engine env var and
// the module-level engine constant stay independent. Spends credits: two model
// turns per engine. `--fallback` (v3 only) forces the native steer to fail so
// the synthetic block inside the tool result is what has to work.
//
// Isolation: temp cwd, temp XDG_DATA_HOME (provider session persistence).
// HOME is untouched, so kiro-cli keeps its login and ~/.kiro is never written.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.KIRO_E2E_LIVE !== 'full') {
  console.error(
    'steer drives the provider through real kiro-cli model turns and spends credits.\n' +
      'Run with KIRO_E2E_LIVE=full.',
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return value;
};
const engineArg = flagValue('--engine');
const fallback = argv.includes('--fallback');

if (!engineArg) {
  // One child per engine: `PI_KIRO_ACP_AGENT_ENGINE` is read at module load.
  let failed = 0;
  for (const engine of ['v2', 'v3']) {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        '--engine',
        engine,
        // `--fallback` is v3 only, so the v2 child never gets it.
        ...(fallback && engine === 'v3' ? ['--fallback'] : []),
      ],
      { stdio: 'inherit', env: process.env },
    );
    if (child.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

if (engineArg !== 'v2' && engineArg !== 'v3') {
  console.error(`unknown engine: ${engineArg} (use v2 or v3)`);
  process.exit(1);
}
if (fallback && engineArg !== 'v3') {
  console.error('--fallback applies to v3 only');
  process.exit(1);
}

const engine = engineArg;
const ROOT = mkdtempSync(join(tmpdir(), 'kiro-e2e-steer-'));
const PROJECT = join(ROOT, 'project');
mkdirSync(PROJECT, { recursive: true });
process.env.XDG_DATA_HOME = join(ROOT, 'data');
process.env.PI_KIRO_ACP_AGENT_ENGINE = engine;
const { SessionManager } = await import('../../src/session-manager.ts');
const { streamKiroAcp } = await import('../../src/stream.ts');
const { buildSteerRule, sumMeteringCredits } =
  await import('../../src/helpers.ts');
const { logFile } = await import('../../src/logging.ts');
const { loadKiroAcpConfig, resolveLoggerConfig } =
  await import('../../src/config.ts');

const SLOW_MS = Number(process.env.STEER_SLOW_MS) || 20000;
const PROMPT = 'Call the slow tool once, then answer in one sentence.';
const MODEL = {
  id: 'claude-sonnet-4.6',
  name: 'Claude Sonnet 4.6 (Kiro)',
  api: 'kiro-acp-api',
  provider: 'kiro-acp',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 16384,
};
// A pi tool as the provider receives it: the declaration lives in the leading
// system message, which is how `getCurrentTools` resolves the catalog.
const SLOW_TOOL = {
  name: 'slow',
  description: 'Runs a slow job (~20s) and returns its status.',
  parameters: { type: 'object', properties: {} },
};
const canary = () => `CANARY-${randomBytes(3).toString('hex').toUpperCase()}`;
const steerText = (word) => `Add the code word ${word} to your final answer.`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Kiro repeats the word inside a `[STEERING <id>: …]` note. The provider strips
// notes for the steers it queued; anything left is the model paraphrasing, and
// only the visible text decides PASS.
const echo = /\[STEERING[^\]]*\]/g;
const visible = (answer) => answer.replace(echo, '');
const DATA_PATTERNS = [
  /\buntrusted\b/i,
  /\bprompt injection\b/i,
  /\bnot (?:from|a) (?:the )?user\b/i,
  /\bas data\b/i,
  /\bI (?:can't|cannot|won't) (?:follow|include)\b/i,
];

async function drain(stream) {
  const text = [];
  const calls = [];
  let terminal = null;
  for await (const event of stream) {
    if (event.type === 'text_delta') text.push(event.delta);
    else if (event.type === 'toolcall_end') calls.push(event.toolCall);
    else if (event.type === 'done' || event.type === 'error') terminal = event;
  }
  return { text: text.join(''), calls, terminal };
}

function describe(terminal) {
  if (!terminal) return 'no terminal event';
  const reason = terminal.reason ?? 'no reason';
  const error = terminal.message?.errorMessage;
  return error ? `${reason}: ${error}` : reason;
}

const debugLogging = resolveLoggerConfig(loadKiroAcpConfig()).debug;

function providerLog(acpSessionId) {
  if (!debugLogging) return [];
  let text = '';
  try {
    text = readFileSync(logFile(acpSessionId), 'utf-8');
  } catch {
    return [];
  }
  const tagged = `"session":"${acpSessionId}"`;
  return text
    .split('\n')
    .filter(
      (line) =>
        line.includes(tagged) &&
        /native steer|delivering tool result|steer has no live/.test(line),
    )
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, ''));
}

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
  return ok;
};

const manager = new SessionManager();
const sessionId = `e2e-steer-${randomBytes(4).toString('hex')}`;
const options = { sessionId, cwd: PROJECT };
const context1 = {
  messages: [
    {
      role: 'system',
      content: 'You are a coding assistant.',
      toolsAdded: [SLOW_TOOL],
      timestamp: 0,
    },
    { role: 'user', content: PROMPT, timestamp: Date.now() },
  ],
  systemPrompt: '',
};

let session = null;
let word = '';
try {
  // Route first so the probe can read the session's own state afterwards.
  const routed = await manager.routeSession(context1, options);
  session = routed.session;
  routed.release();

  console.log(`=== steer on ${engine}${fallback ? ' (forced fallback)' : ''}`);
  console.log(`  session: ${sessionId} (cwd ${PROJECT})`);

  const turn1 = await drain(streamKiroAcp(manager, MODEL, context1, options));
  const call = turn1.calls.find((c) => c.name === 'slow') ?? turn1.calls[0];
  const toolUse = turn1.terminal?.reason === 'toolUse';
  console.log(
    `  turn 1: ${describe(turn1.terminal)}` +
      (call ? `, tool ${call.name} (${call.id})` : ', no tool call'),
  );
  if (!toolUse || !call)
    throw new Error(
      `turn 1 did not end in a tool call: ${describe(turn1.terminal)}`,
    );

  // The pi host "runs" the tool while the user types; the steer is appended to
  // the transcript after the tool result, which is what turn 2 delivers.
  await wait(SLOW_MS);
  word = canary();
  const context2 = {
    messages: [
      ...context1.messages,
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          },
        ],
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        isError: false,
        content: [{ type: 'text', text: 'slow job finished: status OK' }],
        timestamp: Date.now(),
      },
      { role: 'user', content: steerText(word), timestamp: Date.now() },
    ],
    systemPrompt: '',
  };

  if (fallback) {
    // Native steer is one-shot per session: flipping the provider's own switch
    // sends this steer down the synthetic-block path with no src changes.
    session.nativeSteerDisabled = true;
  }

  const turn2At = Date.now();
  const turn2 = await drain(streamKiroAcp(manager, MODEL, context2, options));
  console.log(
    `  turn 2: ${describe(turn2.terminal)} (${Date.now() - turn2At}ms)`,
  );
  const answer = turn2.text;
  const shown = visible(answer);
  const steerIds = [...session.steerMessageIds];

  if (engine === 'v3') {
    if (fallback) {
      check(
        steerIds.length === 0,
        '--fallback no longer forces the fallback: a native steer was queued (nativeSteerDisabled renamed?)',
      );
      console.log(
        '  steer: synthetic <user_message_during_run> block in the tool result (native steer forced off)',
      );
    } else {
      console.log(
        steerIds.length
          ? `  steer: native _session/steer accepted — messageId ${steerIds.join(', ')}`
          : '  steer: NO native steer was queued; the steer fell back to the tool result block',
      );
    }
  } else {
    check(
      steerIds.length === 0,
      'v2 queued a native steer; v2 must only use the synthetic block',
    );
    console.log(
      '  steer: synthetic <user_message_during_run> block in the tool result',
    );
    console.log(
      `  standing rule in <system_instructions>: ${buildSteerRule(session.steerBlockId)}`,
    );
  }

  const logLines = providerLog(session.id);
  if (logLines.length) {
    console.log('  provider debug log:');
    for (const line of logLines.slice(-6)) console.log(`    ${line}`);
  } else {
    console.log(
      debugLogging
        ? '  provider debug log: on, but no steer lines for this session'
        : `  provider debug log: off (enable with {"logger":{"debug":true}} in ~/.pi/agent/kiro-acp.json); ` +
            'the live session state above is the evidence instead',
    );
  }

  const present = shown.includes(word);
  const noteLeft = /\[STEERING/.test(answer);
  const asData = DATA_PATTERNS.some((re) => re.test(shown));
  check(present, `the code word ${word} is missing from the final answer`);
  check(!asData, 'the answer treats the steer as data/untrusted');

  console.log(`  final answer: ${JSON.stringify(shown.trim())}`);
  console.log(
    `  code word ${word}: ${present ? 'present' : 'MISSING'}; ` +
      `[STEERING note in the answer: ${noteLeft ? 'yes (not stripped)' : 'no'}]; ` +
      `treated as data: ${asData ? 'yes' : 'no'}`,
  );
  const credits = sumMeteringCredits(session.metadata?.meteringUsage);
  console.log(
    `  credits (turn 2): ${credits.toFixed(3)}; engine: ${session.engine}`,
  );
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
} finally {
  await manager.close();
  rmSync(ROOT, { recursive: true, force: true });
}

if (problems.length) {
  console.log(`\n=== steer on ${engine}: FAIL`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log(`\n=== steer on ${engine}: PASS`);
