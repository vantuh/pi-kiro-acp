import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Context, Model } from '@earendil-works/pi-ai';

import { AcpSession } from '../src/session.ts';

// --- assertions ---

/** Throws on a failed assertion so `finally` cleanup blocks (e.g.
 * stopAllSessions in the streaming tests) still run. */
export function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
  console.log(`✓ ${label}`);
}

// --- fake sessions ---

/** Options for fakeSession; unset fields are left at AcpSession defaults. */
export interface FakeSessionOptions {
  cwd?: string;
  acpSessionId?: string | null;
  currentModelId?: string;
  started?: boolean;
  /** Capture writes as parsed JSON frames instead of raw lines. */
  parseJson?: boolean;
}

/** A session with a fake writable stdin, so rpc* writes are captured instead
 * of spawning kiro-cli. */
export function fakeSession(opts: FakeSessionOptions = {}): {
  session: AcpSession;
  written: any[];
} {
  const session = new AcpSession(opts.cwd ?? '/tmp');
  const written: any[] = [];
  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        written.push(opts.parseJson ? JSON.parse(chunk) : chunk);
        return true;
      },
      end() {
        return true;
      },
    },
    // stop() closes stdin and waits for the process to exit; a fake process
    // reports the exit as soon as the wait starts.
    once(event: string, handler: () => void) {
      if (event === 'exit') setImmediate(handler);
      return session.proc;
    },
  } as any;
  if (opts.acpSessionId !== undefined) session.acpSessionId = opts.acpSessionId;
  if (opts.currentModelId !== undefined)
    session.currentModelId = opts.currentModelId;
  if (opts.started) session.started = true;
  return { session, written };
}

/** Parses captured writes, requiring each to be exactly one newline-terminated line. */
export function parseLines(written: string[]): any[] {
  return written.map((line) => {
    if (!line.endsWith('\n') || line.slice(0, -1).includes('\n')) {
      throw new Error(
        `write is not a single newline-delimited frame: ${JSON.stringify(line)}`,
      );
    }
    return JSON.parse(line);
  });
}

/** Resolves with {ok, value?, error?} instead of throwing on rejection. */
export function settled<T>(
  promise: Promise<T>,
): Promise<{ ok: boolean; value?: T; error?: Error }> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: Error) => ({ ok: false, error }),
  );
}

/** One macrotask turn — lets queued stdout handling run. */
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// --- model / context fixtures ---

/** The pi model descriptor used by the streaming tests. */
export function kiroModel(): Model<any> {
  return {
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
}

/** A minimal Context with a single user message. */
export function kiroContext(userContent: string): Context {
  return {
    messages: [
      {
        role: 'user',
        content: userContent,
        timestamp: Date.now(),
      },
    ],
    systemPrompt: '',
    tools: [],
  };
}

// --- fake kiro-cli ACP server ---

export interface FakeKiroCli {
  /** argv of every invocation, `settings …` ones included. */
  invocations: () => string[][];
  /** Every JSON-RPC frame the fake received, in order. */
  frames: () => any[];
  /** Client messages that are not requests (i.e. answers to the fake). */
  replies: () => any[];
  restore: () => void;
}

export function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Puts the fake on PATH as `kiro-cli` and points it at a scratch log dir.
 * `modes` overrides the mode the fake reports for session/new or session/load;
 * unset, it echoes the requested `_meta.kiro.modeId` like a working profile. */
function readLog(dir: string, name: string): any[] {
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function fakeKiroCli(
  extensionMethods: string[] = [],
  modes: { new?: string; load?: string } = {},
): FakeKiroCli {
  const root = mkdtempSync(join(tmpdir(), 'kiro-acp-engine-'));
  const binDir = join(root, 'bin');
  const logDir = join(root, 'log');
  mkdirSync(binDir);
  mkdirSync(logDir);
  const executable = join(binDir, 'kiro-cli');
  copyFileSync(
    new URL('./fixtures/fake-kiro-acp.cjs', import.meta.url),
    executable,
  );
  chmodSync(executable, 0o755);

  const savedPath = process.env.PATH;
  const savedDir = process.env.FAKE_KIRO_DIR;
  const savedMethods = process.env.FAKE_KIRO_EXTENSION_METHODS;
  const savedNewMode = process.env.FAKE_KIRO_NEW_MODE;
  const savedLoadMode = process.env.FAKE_KIRO_LOAD_MODE;
  process.env.PATH = `${binDir}:${savedPath ?? ''}`;
  process.env.FAKE_KIRO_DIR = logDir;
  process.env.FAKE_KIRO_EXTENSION_METHODS = JSON.stringify(extensionMethods);
  setEnv('FAKE_KIRO_NEW_MODE', modes.new);
  setEnv('FAKE_KIRO_LOAD_MODE', modes.load);

  return {
    invocations: () => readLog(logDir, 'invocations.log'),
    frames: () => readLog(logDir, 'frames.log'),
    replies: () => readLog(logDir, 'replies.log'),
    restore() {
      process.env.PATH = savedPath;
      if (savedDir === undefined) delete process.env.FAKE_KIRO_DIR;
      else process.env.FAKE_KIRO_DIR = savedDir;
      if (savedMethods === undefined)
        delete process.env.FAKE_KIRO_EXTENSION_METHODS;
      else process.env.FAKE_KIRO_EXTENSION_METHODS = savedMethods;
      setEnv('FAKE_KIRO_NEW_MODE', savedNewMode);
      setEnv('FAKE_KIRO_LOAD_MODE', savedLoadMode);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Spawned `acp` invocations without the `-v…` verbosity suffix, which comes
 * from the local kiro-acp.json and is not what these tests are about. */
export function acpInvocations(invocations: string[][]): string[][] {
  return invocations
    .filter((argv) => argv[0] === 'acp')
    .map((argv) => argv.filter((arg) => !/^-v+$/.test(arg)));
}

// --- minimal HTTP / SSE helpers for the loopback MCP bridge ---

export interface HttpResponse {
  status: number;
  body: any;
}

/** POST a JSON-RPC body and buffer the whole response. */
export function post(
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsedBody: any = undefined;
          try {
            parsedBody = text ? JSON.parse(text) : undefined;
          } catch {
            parsedBody = text;
          }
          resolve({ status: res.statusCode || 0, body: parsedBody });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Like post(), but exposes the request so the caller can destroy it mid-flight. */
export function rawPost(
  url: string,
  token: string,
  body: unknown,
): { request: ClientRequest; response: Promise<HttpResponse> } {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);
  let resolveResponse!: (response: HttpResponse) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<HttpResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = httpRequest(
    {
      host: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let parsedBody: any = undefined;
        try {
          parsedBody = text ? JSON.parse(text) : undefined;
        } catch {
          parsedBody = text;
        }
        resolveResponse({ status: res.statusCode || 0, body: parsedBody });
      });
    },
  );
  req.on('error', rejectResponse);
  req.end(payload);
  return { request: req, response };
}

/** Collects raw SSE text as it arrives, so keepalives can be observed mid-call. */
export function ssePost(
  url: string,
  token: string,
  body: unknown,
): {
  chunks: string[];
  headers: Promise<Record<string, string | string[] | undefined>>;
  done: Promise<string>;
} {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);
  const chunks: string[] = [];
  let resolveHeaders!: (
    h: Record<string, string | string[] | undefined>,
  ) => void;
  let resolveDone!: (text: string) => void;
  let rejectAll!: (error: Error) => void;
  const headers = new Promise<Record<string, string | string[] | undefined>>(
    (resolve, reject) => {
      resolveHeaders = resolve;
      rejectAll = reject;
    },
  );
  const done = new Promise<string>((resolve, reject) => {
    resolveDone = resolve;
    const prev = rejectAll;
    rejectAll = (error: Error) => {
      prev(error);
      reject(error);
    };
  });
  const req = httpRequest(
    {
      host: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      resolveHeaders(res.headers);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      res.on('end', () => resolveDone(chunks.join('')));
    },
  );
  req.on('error', rejectAll);
  req.end(payload);
  return { chunks, headers, done };
}

/** Last JSON-RPC message carried by an SSE body. */
export function sseMessages(text: string): any[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

export function del(url: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        host: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
