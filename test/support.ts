// Shared test infrastructure for the kiro-acp tests. These files run through
// jiti (test/run-all.sh) with pi's dependency tree, so imports stay relative
// and there is no test framework — just helpers plus process.exit on failure.
// test/refusal-retry.test.ts deliberately does not use this file: it must set
// an env var before stream.ts is imported.
import type { Context, Model } from "@earendil-works/pi-ai";
import { request as httpRequest, type ClientRequest } from "node:http";
import { AcpSession } from "../session.ts";

// --- assertions ---

/** Throws on a failed assertion so `finally` cleanup blocks (e.g.
 * stopAllSessions in the streaming tests) still run. */
export function assert(
  condition: unknown,
  label: string,
): asserts condition {
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
export function fakeSession(
  opts: FakeSessionOptions = {},
): { session: AcpSession; written: any[] } {
  const session = new AcpSession(opts.cwd ?? "/tmp");
  const written: any[] = [];
  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        written.push(opts.parseJson ? JSON.parse(chunk) : chunk);
        return true;
      },
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
    if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
      console.error(
        `✗ write is not a single newline-delimited frame: ${JSON.stringify(line)}`,
      );
      process.exit(1);
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
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (Kiro)",
    api: "kiro-acp-api",
    provider: "kiro-acp",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
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
        role: "user",
        content: userContent,
        timestamp: Date.now(),
      },
    ],
    systemPrompt: "",
    tools: [],
  };
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
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
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
    req.on("error", reject);
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
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(payload),
      },
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
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
  req.on("error", rejectResponse);
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
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(payload),
      },
    },
    (res) => {
      resolveHeaders(res.headers);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => resolveDone(chunks.join("")));
    },
  );
  req.on("error", rejectAll);
  req.end(payload);
  return { chunks, headers, done };
}

/** Last JSON-RPC message carried by an SSE body. */
export function sseMessages(text: string): any[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
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
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode || 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
