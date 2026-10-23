#!/usr/bin/env node
// E2E Pocket probe: loads the Pocket adapter into a real Pi Pocket through its
// own test helpers, on an isolated temporary data folder.
//
// GUARDED: needs PI_POCKET_SOURCE (a Pi Pocket checkout that has its own
// node_modules) and KIRO_E2E_LIVE. It is NOT part of npm test.
//
//   PI_POCKET_SOURCE=/path/to/pi-pocket KIRO_E2E_LIVE=1 node test/e2e/pocket.mjs
//   PI_POCKET_SOURCE=/path/to/pi-pocket KIRO_E2E_LIVE=full node test/e2e/pocket.mjs
//
// `1` runs free checks only (no model request). `full` adds three read turns
// (two concurrent, one warm follow-up) and one turn after a reload, so it
// spends credits.

import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIVE = process.env.KIRO_E2E_LIVE;
if (LIVE !== '1' && LIVE !== 'full') {
  console.error(
    'The Pocket probe needs a real Pi Pocket and an authenticated kiro-cli.\n' +
      'Run with KIRO_E2E_LIVE=1 (free) or KIRO_E2E_LIVE=full (model requests).',
  );
  process.exit(1);
}
const FULL = LIVE === 'full';
const POCKET = process.env.PI_POCKET_SOURCE;
if (!POCKET) {
  console.error('Set PI_POCKET_SOURCE to the Pi Pocket checkout.');
  process.exit(1);
}

// Pocket's helpers first: they isolate Pi's agent folder before the app loads.
const helpers = await import(
  pathToFileURL(join(POCKET, 'test/helpers.ts')).href
);
const { cleanUp, context, newSession, openApp, owner, scriptedModel } = helpers;

// Observe real kiro-cli processes at the child-process boundary, so disable and
// close must show their exits. No production hook is involved. The probe keeps
// the ChildProcess and reads exitCode/signalCode, so a missed event cannot look
// like a live child.
const hasExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;
const realSpawn = childProcess.spawn;
const kiroChildren = [];
childProcess.spawn = function trackedSpawn(command, args, options) {
  const child = realSpawn.call(this, command, args, options);
  if (command === 'kiro-cli' && Array.isArray(args) && args.includes('acp')) {
    kiroChildren.push({ args: args.map(String), child });
  }
  return child;
};
syncBuiltinESMExports();

/** The children still live, with what Node knows about each one. */
function describeLive() {
  return kiroChildren
    .filter(({ child }) => !hasExited(child))
    .map(
      ({ args, child }) =>
        `pid=${child.pid} args=${JSON.stringify(args)} ` +
        `exitCode=${child.exitCode} signalCode=${child.signalCode} ` +
        `killed=${child.killed}`,
    )
    .join('; ');
}

const MODEL = 'claude-sonnet-4.6';
const TURN_TIMEOUT_MS = Number(process.env.PI_KIRO_E2E_TIMEOUT_MS) || 300_000;
const EXIT_WAIT_MS = 20_000;

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const base = mkdtempSync(join(tmpdir(), 'kiro-pocket-e2e-'));
const dataDir = join(base, 'data');
const extensions = join(dataDir, 'extensions');
mkdirSync(extensions, { recursive: true });

const DROP_IN = 'kiro-acp-pocket.ts';
const adapterUrl = pathToFileURL(join(REPO, 'src/pocket.ts')).href;
const writeWrapper = (note) =>
  writeFileSync(
    join(extensions, DROP_IN),
    `// ${note}\nexport { default } from ${JSON.stringify(adapterUrl)};\n`,
  );
const writeBrokenWrapper = () =>
  writeFileSync(
    join(extensions, DROP_IN),
    `/** Broken probe wrapper: registers, then throws. */\n` +
      `import adapter from ${JSON.stringify(adapterUrl)};\n` +
      `export default (host, web) => {\n` +
      `  adapter(host, web);\n` +
      `  throw new Error("pocket probe broken module");\n` +
      `};\n`,
  );
writeWrapper('pocket probe v1');

/** Wait until `condition` holds, or fail at the bound. */
async function until(
  condition,
  label,
  timeoutMs = EXIT_WAIT_MS,
  details = () => '',
) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      const extra = details();
      throw new Error(`timed out: ${label}${extra ? ` (${extra})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function check(ok, label) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
}

/** Bound a promise so a stuck turn fails the probe instead of hanging it. */
function within(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out: ${label} (${ms}ms)`)),
      ms,
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Submit one user turn and require it to settle as done. */
async function turn(app, id, text, label) {
  const { submissionId } = await app.commands.submit(id, owner(app), {
    text,
    requestId: crypto.randomUUID(),
  });
  const submission = await app.harness.submission(submissionId, context);
  const settled = await within(
    submission.wait(context),
    TURN_TIMEOUT_MS,
    `${label} submission`,
  );
  check(
    settled.status === 'done',
    `${label}: the submission settled as done (got ${settled.status})`,
  );
}

/**
 * One read round-trip through the session cwd. The assertions cover this turn
 * only, so an answer from memory cannot match an earlier turn's read result.
 * Returns the sentinel written for this turn.
 */
async function readIn(app, id, dir, label, { prompt, alsoExpect = [] } = {}) {
  const sentinel = `POCKET-${label}-${crypto.randomUUID()}`;
  writeFileSync(join(dir, 'probe.txt'), sentinel);

  await turn(
    app,
    id,
    prompt ??
      `This is turn ${label}. The file may have changed. Use the read tool to ` +
        `read probe.txt now, then reply with its exact text. ` +
        `Do not reuse contents from earlier turns.`,
    label,
  );

  const view = await (
    await app.harness.conversation(id, context)
  ).context(context);
  const userAt = view.messages.findLastIndex(
    (message) => message.role === 'user',
  );
  const turnMessages = view.messages.slice(userAt + 1);
  const parts = turnMessages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const call = parts
    .filter((part) => part.type === 'toolCall' && part.name === 'read')
    .at(-1);
  check(!!call, `${label}: Pi ran a read tool call in this turn`);
  const result = turnMessages.find(
    (message) =>
      message.role === 'toolResult' && message.toolCallId === call.id,
  );
  const resultText = JSON.stringify(result?.content ?? null);
  const diagnostic = resultText.slice(0, 300);
  check(!!result, `${label}: the tool result settled (got ${diagnostic})`);
  check(
    result.isError === false,
    `${label}: the tool result is not an error (got ${diagnostic})`,
  );
  check(
    resultText.includes(sentinel),
    `${label}: the tool result carries this turn's file text (got ${diagnostic})`,
  );

  const answer = turnMessages.findLast(
    (message) => message.role === 'assistant',
  );
  const text = Array.isArray(answer?.content)
    ? answer.content.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      )
    : [];
  check(
    text.join('').includes(sentinel),
    `${label}: the final answer carries this turn's file text (got ${text.join('').slice(0, 300)})`,
  );
  for (const expected of alsoExpect)
    check(
      text.join('').includes(expected),
      `${label}: the final answer repeats the earlier file text (got ${text.join('').slice(0, 300)})`,
    );
  return sentinel;
}

let app;
try {
  app = await openApp(scriptedModel(), dataDir);
  const kiro = () => app.models.getProvider('kiro-acp');
  const ids = () => app.models.getModels('kiro-acp').map((model) => model.id);

  await app.setExtensionEnabled(owner(app), DROP_IN, true);
  check(!!kiro(), 'the module registers the kiro-acp provider');
  check(
    ids().length > 0,
    `the fallback catalog is visible (${ids().length} models)`,
  );

  const auth = await app.models.checkAuth('kiro-acp');
  check(
    auth?.source === 'configured API key',
    `availability is a configured key, not native ambient auth (${auth?.source})`,
  );

  const local = await app.models.refresh({
    allowNetwork: false,
    providers: ['kiro-acp'],
  });
  check(!local.errors.has('kiro-acp'), 'the local refresh succeeds');
  check(ids().length > 0, 'the local refresh keeps the catalog');

  const network = await app.models.refresh({
    allowNetwork: true,
    force: true,
    providers: ['kiro-acp'],
  });
  check(
    !network.errors.has('kiro-acp'),
    'network refresh completes without error',
  );
  check(ids().length > 0, `discovery returns models (${ids().length})`);
  check(
    ids().includes(MODEL),
    `the smoke model ${MODEL} is available (got ${ids().join(', ')})`,
  );

  const installed = kiro();
  writeWrapper('pocket probe v2');
  await app.loader.apply(DROP_IN);
  check(!!kiro(), 'a reload keeps the new registration');
  check(kiro() !== installed, 'a reload installs a new provider');
  check(ids().length > 0, 'the reloaded provider lists models');

  writeBrokenWrapper();
  let broken;
  try {
    await app.loader.apply(DROP_IN);
  } catch (error) {
    broken = error;
  }
  check(
    String(broken?.message).includes('pocket probe broken module'),
    `the broken wrapper is refused (got ${broken?.message})`,
  );
  check(!!kiro(), 'the previous registration survives a failed load');
  check(ids().includes(MODEL), 'the previous catalog survives a failed load');

  if (FULL) {
    const dirs = ['a', 'b'].map((name) => join(base, `work-${name}`));
    for (const dir of dirs) mkdirSync(dir);
    const sessions = await Promise.all(dirs.map((dir) => newSession(app, dir)));
    for (const id of sessions) {
      await app.commands.configure(id, owner(app), {
        model: { provider: 'kiro-acp', modelId: MODEL },
        thinkingLevel: 'off',
      });
    }
    const sentinels = await Promise.all(
      sessions.map((id, index) =>
        readIn(app, id, dirs[index], `concurrent-${index + 1}`),
      ),
    );

    // Warm turn on the same provider and conversation. The prompt carries no
    // sentinel: the file is changed on disk, and the earlier text must come
    // from the conversation history.
    await readIn(app, sessions[0], dirs[0], 'warm-before-reload', {
      prompt:
        'This is a warm follow-up in the same conversation. Use the read tool ' +
        'to read probe.txt again now, then reply with its exact text. ' +
        'Also repeat, word for word, ' +
        'the file text you read earlier in this conversation, before this turn. ' +
        'Do not guess either value.',
      alsoExpect: [sentinels[0]],
    });

    const beforeReload = kiroChildren.filter(({ child }) => !hasExited(child));
    check(
      beforeReload.length > 0,
      'a live kiro-cli acp child existed before the second reload',
    );
    writeWrapper('pocket probe v3');
    await app.loader.apply(DROP_IN);
    check(!!kiro(), 'a second reload keeps the provider');
    await until(
      () => beforeReload.every(({ child }) => hasExited(child)),
      `the old provider's ${beforeReload.length} kiro-cli acp children exit after the second reload`,
      EXIT_WAIT_MS,
      describeLive,
    );
    await readIn(app, sessions[0], dirs[0], 'after-reload');
  }

  const liveBeforeDisable = kiroChildren.filter(
    ({ child }) => !hasExited(child),
  );
  await app.setExtensionEnabled(owner(app), DROP_IN, false);
  check(!kiro(), 'turning the module off removes the provider');

  check(kiroChildren.length > 0, 'the probe observed kiro-cli acp children');
  await until(
    () => kiroChildren.every(({ child }) => hasExited(child)),
    'every root kiro-cli acp child exits',
    EXIT_WAIT_MS,
    describeLive,
  );
  if (FULL) {
    check(
      liveBeforeDisable.length > 0,
      'a live kiro-cli session child existed before disable',
    );
    check(
      kiroChildren.every(({ child }) => hasExited(child)),
      'disable and close released every root kiro-cli acp child',
    );
  }

  console.log(`\nPocket probe passed (${FULL ? 'full' : 'free'}).`);
} finally {
  try {
    if (app) await app.close();
  } finally {
    cleanUp();
    rmSync(base, { recursive: true, force: true });
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
  }
}
