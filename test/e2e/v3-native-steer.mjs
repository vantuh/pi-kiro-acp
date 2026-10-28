#!/usr/bin/env node
// Live probe of Kiro CLI V3 native steering (`_session/steer`) against the
// REAL kiro-cli. Spends credits: every scenario runs real model turns.
//
//   KIRO_E2E_LIVE=full node test/e2e/v3-native-steer.mjs [scenario...]
//
// Scenarios: tool (steer while a pi_host tool runs; STEER_RUNS repeats, default 3),
// generation (steer while the model streams text, no tool), idle (steer on an
// idle session, then a prompt), load (steer turn, new process, session/load,
// ask for the word), idle-load (steer on an idle session, new process,
// session/load, prompt). Default: all. Findings: docs/kiro-v3-acp-probes.md.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.env.KIRO_E2E_LIVE !== 'full') {
  console.error(
    'v3-native-steer spawns kiro-cli V3 and spends credits on real model turns.\n' +
      'Run with KIRO_E2E_LIVE=full.',
  );
  process.exit(1);
}

const ROOT = mkdtempSync(join(tmpdir(), 'kiro-v3-steer-'));
const AGENT_DIR = join(ROOT, 'agent');
const PROJECT = join(ROOT, 'project');
mkdirSync(join(AGENT_DIR, '.kiro', 'agents'), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
// The profile the provider would use: pi_host tools only, every builtin denied.
writeFileSync(
  join(AGENT_DIR, '.kiro', 'agents', 'pi-probe.json'),
  JSON.stringify({
    name: 'pi-probe',
    description: 'pi host probe',
    tools: ['@pi_host'],
    includeMcpJson: false,
    mcpServers: {},
    permissions: {
      rules: [
        { capability: 'mcp', match: ['pi_host/*'], effect: 'allow' },
        { capability: 'builtin', effect: 'deny' },
      ],
    },
    prompt: process.env.STEER_AGENT_PROMPT || 'You are a coding assistant.',
  }),
);

const SLOW_MS = 20000;
let onToolCall = () => {};
const mcp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const msg = JSON.parse(body || '{}');
    if (msg.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize')
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '0' },
      });
    else if (msg.method === 'tools/list')
      reply({
        tools: [
          {
            name: 'slow',
            description: 'Runs a slow job (~20s) and returns its status.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
    else if (msg.method === 'tools/call') {
      onToolCall();
      await new Promise((r) => setTimeout(r, SLOW_MS));
      reply({
        content: [{ type: 'text', text: 'slow job finished: status OK' }],
      });
    } else reply({});
  });
});
const port = await new Promise((ok) =>
  mcp.listen(0, '127.0.0.1', () => ok(mcp.address().port)),
);
const mcpServers = [
  {
    type: 'http',
    name: 'pi_host',
    url: `http://127.0.0.1:${port}`,
    headers: [],
  },
];
const sessionParams = {
  cwd: PROJECT,
  additionalDirectories: [AGENT_DIR],
  mcpServers,
  _meta: { kiro: { modeId: 'pi-probe' } },
};

class Kiro {
  constructor() {
    this.t0 = Date.now();
    this.timeline = [];
    this.text = '';
    this.replay = [];
    this.credits = 0;
    this.pending = new Map();
    this.id = 0;
    this.listeners = [];
    this.proc = spawn(
      'kiro-cli',
      ['acp', '--agent-engine=v3', '--auth-method=cli'],
      { cwd: AGENT_DIR, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    createInterface({ input: this.proc.stdout }).on('line', (line) =>
      this.onLine(line),
    );
  }
  mark(what) {
    this.timeline.push(
      `${((Date.now() - this.t0) / 1000).toFixed(1)}s ${what}`,
    );
  }
  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && !m.method) {
      this.pending.get(m.id)?.(m);
      return;
    }
    if (m.id != null)
      this.write({
        jsonrpc: '2.0',
        id: m.id,
        error: { code: -32601, message: 'unsupported' },
      });
    const u = m.method === 'session/update' ? m.params?.update : null;
    if (!u) return;
    const kiro = u._meta?.kiro;
    if (kiro?.replay) {
      const t = u.content?.text;
      this.replay.push(`${u.sessionUpdate}${t ? `: ${t.slice(0, 160)}` : ''}`);
      return;
    }
    if (u.sessionUpdate === 'agent_message_chunk') {
      if (!this.text) this.mark('first agent text');
      this.text += u.content?.text ?? '';
    } else if (u.sessionUpdate === 'tool_call')
      this.mark(`tool_call ${u.title}`);
    else if (u.sessionUpdate === 'tool_call_update' && u.status === 'completed')
      this.mark(`tool done ${u.title ?? ''}`);
    else if (u.sessionUpdate === 'user_message_chunk')
      this.mark(
        `user_message_chunk ${JSON.stringify(u.content).slice(0, 160)}`,
      );
    else if (u.sessionUpdate === 'session_info_update') {
      if (kiro?.kind === 'turn_completion')
        for (const s of kiro.promptTurnSummaries ?? [])
          this.credits += s.usage ?? 0;
      if (/steering|turn_end|turn_start/.test(kiro?.kind ?? ''))
        this.mark(
          `${kiro.kind}${kiro.messageId ? ` ${kiro.messageId}` : ''}${kiro.messageIds ? ` ${kiro.messageIds}` : ''}`,
        );
    }
    for (const l of this.listeners) l(u);
  }
  write(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  rpc(method, params) {
    return new Promise((resolve) => {
      const id = this.id++;
      this.pending.set(id, resolve);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  async init() {
    await this.rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'v3-steer-probe', version: '0' },
    });
  }
  async newSession() {
    this.sid = (await this.rpc('session/new', sessionParams)).result.sessionId;
    await wait(4000); // let pi_host connect and list its tools
    return this.sid;
  }
  async load(sid) {
    this.sid = sid;
    const r = await this.rpc('session/load', {
      sessionId: sid,
      ...sessionParams,
    });
    if (r.error) throw new Error(`session/load: ${JSON.stringify(r.error)}`);
    await wait(4000);
  }
  async steer(message) {
    this.mark(`STEER → ${message}`);
    const r = await this.rpc('_session/steer', {
      sessionId: this.sid,
      message,
    });
    this.mark(`STEER ← ${JSON.stringify(r.result ?? r.error)}`);
    return r;
  }
  async prompt(text) {
    this.text = '';
    this.mark(`PROMPT ${text.slice(0, 80)}`);
    const r = await this.rpc('session/prompt', {
      sessionId: this.sid,
      prompt: [{ type: 'text', text }],
    });
    this.mark(`PROMPT ← ${JSON.stringify(r.result ?? r.error)}`);
    await wait(1000);
    return this.text;
  }
  async close() {
    this.proc.kill();
    await wait(500);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canary = () => `CANARY-${randomBytes(3).toString('hex').toUpperCase()}`;
const steerText = (word) => `Add the code word ${word} to your final answer.`;
const results = [];

// Kiro models append a `[STEERING <id>: …]` acknowledgement that itself names
// the word, so the word only counts outside that note.
const withoutEcho = (answer) => answer.replace(/\[STEERING [^\]]*\]/g, '');
const obeyed = (answer, word) => withoutEcho(answer).includes(word);

function report(name, kiro, answer, word, pass) {
  const echo = /\[STEERING/.test(answer);
  results.push({ name, pass, echo, credits: kiro.credits });
  console.log(`\n=== ${name}: ${pass ? 'PASS' : 'FAIL'} (${word})`);
  for (const line of kiro.timeline) console.log(`  ${line}`);
  if (kiro.replay.length) {
    console.log('  replayed on load:');
    for (const r of kiro.replay) console.log(`    ${r}`);
  }
  console.log(`  answer: ${JSON.stringify(answer)}`);
  console.log(
    `  steering echo in answer: ${echo}; credits: ${kiro.credits.toFixed(3)}`,
  );
}

const scenarios = {
  // Steer while a pi_host tool runs: queued, injected after the tool result.
  async tool(run = 1) {
    const word = canary();
    const k = new Kiro();
    await k.init();
    await k.newSession();
    let steered = null;
    onToolCall = () => {
      steered = wait(3000).then(() => k.steer(steerText(word)));
    };
    const answer = await k.prompt(
      'Call the slow tool once. When it returns, reply with one short sentence about its status.',
    );
    await steered;
    onToolCall = () => {};
    report(`tool #${run}`, k, answer, word, obeyed(answer, word));
    await k.close();
  },
  // Steer while the model streams a long answer and calls no tool.
  async generation() {
    const word = canary();
    const k = new Kiro();
    await k.init();
    await k.newSession();
    let steered = null;
    const listener = (u) => {
      if (u.sessionUpdate === 'agent_message_chunk' && !steered)
        steered = wait(1500).then(() => k.steer(steerText(word)));
    };
    k.listeners.push(listener);
    const answer = await k.prompt(
      'Without calling any tool, write about 300 words on how rivers shape valleys.',
    );
    await steered;
    report('generation (no tool)', k, answer, word, obeyed(answer, word));
    // Does a steer that was cleared at turn end surface on the next turn?
    const next = await k.prompt('Reply with one short sentence: what is 2+2?');
    console.log(
      `  next turn answer: ${JSON.stringify(next)} (word present: ${next.includes(word)})`,
    );
    await k.close();
  },
  // Steer on an idle session, then a normal prompt in the same process.
  async idle() {
    const word = canary();
    const k = new Kiro();
    await k.init();
    await k.newSession();
    await k.steer(steerText(word));
    await wait(2000);
    const answer = await k.prompt(
      'Reply with one short sentence: what is 2+2?',
    );
    report('idle then prompt', k, answer, word, obeyed(answer, word));
    await k.close();
  },
  // A steered turn survives a process restart via session/load.
  async load() {
    const word = canary();
    const k1 = new Kiro();
    await k1.init();
    const sid = await k1.newSession();
    let steered = null;
    onToolCall = () => {
      steered = wait(3000).then(() => k1.steer(steerText(word)));
    };
    const first = await k1.prompt(
      'Call the slow tool once. When it returns, reply with one short sentence about its status.',
    );
    await steered;
    onToolCall = () => {};
    report(
      'load: steered turn (process 1)',
      k1,
      first,
      word,
      obeyed(first, word),
    );
    await k1.close();

    const k2 = new Kiro();
    await k2.init();
    await k2.load(sid);
    const answer = await k2.prompt(
      'Earlier in this conversation you were asked to add a code word to an answer. Reply with only that code word.',
    );
    report(
      'load: recall after session/load (process 2)',
      k2,
      answer,
      word,
      obeyed(answer, word),
    );
    await k2.close();
  },
  // A steer queued on an idle session, then the process dies before any turn.
  async 'idle-load'() {
    const word = canary();
    const k1 = new Kiro();
    await k1.init();
    const sid = await k1.newSession();
    await k1.steer(steerText(word));
    await wait(2000);
    k1.timeline.push('(process 1 killed with the steer still queued)');
    report('idle-load: queued steer (process 1)', k1, '', word, true);
    await k1.close();

    const k2 = new Kiro();
    await k2.init();
    await k2.load(sid);
    const answer = await k2.prompt(
      'Reply with one short sentence: what is 2+2?',
    );
    report(
      'idle-load: prompt after session/load (process 2)',
      k2,
      answer,
      word,
      obeyed(answer, word),
    );
    await k2.close();
  },
};

const chosen = process.argv.slice(2);
const names = chosen.length ? chosen : Object.keys(scenarios);
try {
  for (const name of names) {
    if (!scenarios[name]) throw new Error(`unknown scenario: ${name}`);
    if (name === 'tool') {
      const runs = Number(process.env.STEER_RUNS) || 3;
      for (let i = 1; i <= runs; i++) await scenarios.tool(i);
    } else await scenarios[name]();
  }
} finally {
  mcp.close();
  rmSync(ROOT, { recursive: true, force: true });
}

console.log('\n==== SUMMARY ====');
for (const r of results)
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (echo: ${r.echo}, credits: ${r.credits.toFixed(3)})`,
  );
process.exit(0);
