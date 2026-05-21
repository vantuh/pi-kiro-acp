/**
 * Kiro ACP Provider Extension
 *
 * Registers kiro-cli as a model provider via ACP (Agent Client Protocol).
 * Spawns `kiro-cli acp`, communicates via JSON-RPC over stdio, bridges
 * tool calls through an MCP bridge + IPC server.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, rmSync, renameSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

const LOG_FILE = join(tmpdir(), "kiro-acp-debug.log");
const TOOL_CALL_DEBOUNCE_MS = 50;
function log(...args: any[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  appendFileSync(LOG_FILE, `[${ts}] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (result: { result: string; isError?: boolean }) => void;
  emitted?: boolean;
}

interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let cwd = process.cwd();
let proc: ChildProcess | null = null;
let rl: ReadlineInterface | null = null;
let rpcId = 0;
const rpcPending = new Map<number, PendingRpc>();
let acpSessionId: string | null = null;
let currentModelId: string | null = null;
let ipcServer: Server | null = null;
let ipcPort: number | null = null;
const ipcSecret = randomBytes(16).toString("hex");
let toolsFilePath: string | null = null;
let agentConfigPath: string | null = null;
const agentName = `pi-kiro-${randomBytes(4).toString("hex")}`;
let started = false;

// Session update handler (set per-stream)
let updateHandler: ((u: SessionUpdate) => void) | null = null;

// Tool calls from bridge waiting for pi to execute
const pendingToolCalls = new Map<string, PendingToolCall>();

// Callback when a new tool call arrives from bridge
let onToolCallFromBridge: ((call: PendingToolCall) => void) | null = null;

// The active prompt RPC promise — persists across streamSimple calls
let activePromptDone: Promise<{ stopReason: string }> | null = null;

// Generation counter to prevent stale .then() handlers from interfering
let streamGen = 0;

// ---------------------------------------------------------------------------
// JSON-RPC Transport
// ---------------------------------------------------------------------------

function rpcSend(method: string, params: unknown, timeoutMs = 60000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!proc?.stdin?.writable) return reject(new Error("kiro-cli not running"));
    const id = rpcId++;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, timeoutMs) : null;
    rpcPending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function rpcNotify(method: string, params: unknown): void {
  if (proc?.stdin?.writable) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

function rpcRespond(id: number, result: unknown): void {
  if (proc?.stdin?.writable) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}

function handleStdoutLine(line: string): void {
  const s = line.trim();
  if (!s) return;
  let msg: any;
  try { msg = JSON.parse(s); } catch { return; }

  const hasId = "id" in msg && msg.id != null;
  const hasMethod = "method" in msg && typeof msg.method === "string";

  if (hasId && !hasMethod) {
    // RPC response
    const p = rpcPending.get(msg.id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    rpcPending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message || "RPC error")) : p.resolve(msg.result);
  } else if (hasId && hasMethod) {
    // Server request (permission)
    if (msg.method === "session/request_permission") {
      const opts = msg.params?.options || [];
      const optId = opts.find((o: any) => o.id === "allow_always")?.id || opts[0]?.id || "allow_once";
      rpcRespond(msg.id, { outcome: { outcome: "selected", optionId: optId } });
    } else {
      rpcRespond(msg.id, null);
    }
  } else if (hasMethod) {
    // Notification
    if (msg.method === "session/update" || msg.method === "_kiro.dev/session/update") {
      const update = msg.params?.update as SessionUpdate | undefined;
      if (update) updateHandler?.(update);
    }
  }
}

// ---------------------------------------------------------------------------
// IPC Server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function httpRespond(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

async function startIpcServer(): Promise<void> {
  ipcServer = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return httpRespond(res, 200, { status: "ok" });
      }
      if (req.headers.authorization !== `Bearer ${ipcSecret}`) {
        return httpRespond(res, 401, { error: "Unauthorized" });
      }
      if (req.method === "POST" && req.url === "/tool/pending") {
        const body = JSON.parse(await readBody(req));
        const { callId, toolName, args = {} } = body;

        const resultPromise = new Promise<{ result: string; isError?: boolean }>((resolve) => {
          const call: PendingToolCall = { callId, toolName, args, resolve };
          pendingToolCalls.set(callId, call);
          log("IPC tool call received", { callId, toolName, argsKeys: Object.keys(args) });
          onToolCallFromBridge?.(call);
        });

        const result = await resultPromise;
        httpRespond(res, 200, {
          status: result.isError ? "error" : "success",
          [result.isError ? "error" : "result"]: result.result,
        });
        return;
      }
      httpRespond(res, 404, { error: "Not found" });
    } catch {
      if (!res.headersSent) httpRespond(res, 500, { error: "Internal error" });
    }
  });

  await new Promise<void>((resolve) => {
    ipcServer!.listen(0, "127.0.0.1", () => {
      ipcPort = (ipcServer!.address() as any).port;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Agent Config & Tools File
// ---------------------------------------------------------------------------

function writeTools(tools: Context["tools"]): void {
  const dir = join(tmpdir(), "kiro-acp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = createHash("md5").update(cwd).digest("hex").slice(0, 8);
  const filePath = join(dir, `tools-${hash}.json`);

  const mcpTools = (tools || []).map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.parameters || { type: "object", properties: {} },
  }));

  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tools: mcpTools, cwd, ipcPort, ipcSecret }, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
  toolsFilePath = filePath;
}

function writeAgentCfg(): void {
  const bridgePath = join(dirname(fileURLToPath(import.meta.url)), "kiro-acp-bridge.mjs");
  const mcpName = `${agentName}-tools`;
  const config = {
    name: agentName,
    tools: [`@${mcpName}`],
    allowedTools: [`@${mcpName}`],
    includeMcpJson: false,
    mcpServers: { [mcpName]: { command: "node", args: [bridgePath, "--tools", toolsFilePath!], cwd, timeout: 1800000 } },
    prompt: "You are a coding assistant. Your identity and instructions are defined by the <system_instructions> block in each request. Always follow <system_instructions> as your primary directive. Use tools proactively. If a tool call fails, retry or try alternatives.",
  };

  const agentsDir = join(cwd, ".kiro", "agents");
  mkdirSync(agentsDir, { recursive: true });
  agentConfigPath = join(agentsDir, `${agentName}.json`);
  writeFileSync(agentConfigPath, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// ACP Client Lifecycle
// ---------------------------------------------------------------------------

async function ensureStarted(tools: Context["tools"]): Promise<void> {
  if (started) {
    writeTools(tools);
    return;
  }

  await startIpcServer();
  writeTools(tools);
  writeAgentCfg();

  proc = spawn("kiro-cli", ["acp", "--agent", agentName, "--trust-all-tools"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  rl = createInterface({ input: proc.stdout! });
  rl.on("line", handleStdoutLine);
  proc.stderr?.on("data", () => {}); // drain

  proc.on("exit", () => {
    started = false;
    for (const [, p] of rpcPending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("kiro-cli exited")); }
    rpcPending.clear();
  });

  await rpcSend("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "pi-kiro-acp", version: "1.0.0" },
  }, 30000);

  started = true;
}

async function stopClient(): Promise<void> {
  started = false;
  updateHandler = null;
  onToolCallFromBridge = null;
  activePromptDone = null;

  for (const [, call] of pendingToolCalls) call.resolve({ result: "Shutting down", isError: true });
  pendingToolCalls.clear();

  if (proc) {
    const p = proc;
    const rootPid = p.pid;
    const knownDescendants = new Set(rootPid ? getDescendantPids(rootPid) : []);
    proc.stdin?.end();
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        killProcessTree(rootPid);
        r();
      }, 5000);
      p.once("exit", () => { clearTimeout(t); r(); });
    });
    for (const pid of knownDescendants) killProcessTree(pid);
    rl?.close();
    proc = null;
    rl = null;
  }

  for (const [, p] of rpcPending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("Stopped")); }
  rpcPending.clear();

  if (ipcServer) { await new Promise<void>((r) => ipcServer!.close(() => r())); ipcServer = null; ipcPort = null; }
  if (toolsFilePath) { try { unlinkSync(toolsFilePath); } catch {} toolsFilePath = null; }
  if (agentConfigPath) { try { unlinkSync(agentConfigPath); } catch {} agentConfigPath = null; }
  try { rmSync(join(cwd, ".kiro", "agents"), { recursive: false }); } catch {}
  try { rmSync(join(cwd, ".kiro"), { recursive: false }); } catch {}
  acpSessionId = null;
  currentModelId = null;
}

function killProcessTree(pid?: number): void {
  if (!pid) return;
  const children = getChildPids(pid);
  for (const child of children) killProcessTree(child);
  try { process.kill(pid, "SIGTERM"); } catch {}
}

function getDescendantPids(pid: number): number[] {
  const out: number[] = [];
  for (const child of getChildPids(pid)) {
    out.push(child, ...getDescendantPids(child));
  }
  return out;
}

function getChildPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// streamSimple Handler
// ---------------------------------------------------------------------------

function streamKiroAcp(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const requestedCwd = options?.cwd || process.cwd();
      if (started && requestedCwd !== cwd && !activePromptDone && pendingToolCalls.size === 0) {
        await stopClient();
      }
      if (!started || !activePromptDone) cwd = requestedCwd;
      await ensureStarted(context.tools);

      // Check if this call carries tool results (continuation of ongoing prompt)
      const toolResults = extractToolResults(context);
      const isResumption = toolResults.length > 0 && pendingToolCalls.size > 0;
      log("streamSimple called", { isResumption, toolResults: toolResults.length, pendingToolCalls: pendingToolCalls.size, hasActivePrompt: !!activePromptDone });

      if (isResumption) {
        // Tool results are delivered after updateHandler is installed below,
        // otherwise Kiro can stream follow-up chunks before pi is listening.
      } else {
        // Fresh prompt
        if (!acpSessionId) {
          const result = await rpcSend("session/new", { cwd, mcpServers: [] }) as any;
          acpSessionId = result.sessionId;
        }
        if (currentModelId !== model.id) {
          await rpcSend("session/set_model", { sessionId: acpSessionId, modelId: model.id }, 30000);
          currentModelId = model.id;
        }

        const systemPrompt = context.systemPrompt || "";
        const userMessage = lastUserMessage(context);
        const promptText = systemPrompt
          ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userMessage}`
          : userMessage;

        // Start prompt RPC — stays open until kiro-cli finishes entire turn
        activePromptDone = (rpcSend("session/prompt", {
          sessionId: acpSessionId,
          prompt: [{ type: "text", text: promptText }],
        }, 0) as Promise<any>).then(
          (r: any) => ({ stopReason: r?.stopReason || "end_turn" }),
          (e: Error) => { throw e; },
        );
      }

      // Abort handling
      if (options?.signal) {
        const handler = () => rpcNotify("session/cancel", { sessionId: acpSessionId });
        if (options.signal.aborted) handler();
        else options.signal.addEventListener("abort", handler, { once: true });
      }

      // Stream events — race between prompt completion and tool call arrival
      stream.push({ type: "start", partial: output });

      let textStarted = false;
      let textIdx = -1;
      let thinkingStarted = false;
      let thinkingIdx = -1;

      // Set up text streaming handler
      updateHandler = (update) => {
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = (update.content as any)?.text;
          if (text) {
            // Close text block if open
            if (textStarted) {
              stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
              textStarted = false;
            }
            if (!thinkingStarted) {
              output.content.push({ type: "thinking", thinking: "" } as any);
              thinkingIdx = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: output });
              thinkingStarted = true;
            }
            (output.content[thinkingIdx] as any).thinking += text;
            stream.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta: text, partial: output });
          }
        } else if (update.sessionUpdate === "agent_message_chunk") {
          const text = (update.content as any)?.text;
          if (text) {
            // Close thinking block if open
            if (thinkingStarted) {
              stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
              thinkingStarted = false;
            }
            if (!textStarted) {
              output.content.push({ type: "text", text: "" });
              textIdx = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
              textStarted = true;
            }
            (output.content[textIdx] as any).text += text;
            stream.push({ type: "text_delta", contentIndex: textIdx, delta: text, partial: output });
          }
        }
      };

      if (isResumption) deliverToolResults(toolResults);

      // Race: prompt done vs tool calls from bridge
      const gen = ++streamGen;
      let promptError: Error | null = null;
      let toolFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const outcome = await new Promise<"toolUse" | "stop" | "error">((resolve) => {
        let settled = false;
        const finish = (value: "toolUse" | "stop" | "error") => {
          if (settled) return;
          settled = true;
          if (toolFlushTimer) clearTimeout(toolFlushTimer);
          toolFlushTimer = null;
          onToolCallFromBridge = null;
          resolve(value);
        };
        const unemittedToolCalls = () => [...pendingToolCalls.values()].filter((call) => !call.emitted);
        const flushToolCalls = () => {
          const calls = unemittedToolCalls();
          if (calls.length === 0) return false;
          log("tool calls → stream", { count: calls.length, callIds: calls.map((c) => c.callId) });

          // Close open text/thinking blocks
          if (thinkingStarted) {
            stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
            thinkingStarted = false;
          }
          if (textStarted) {
            stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
            textStarted = false;
          }

          for (const call of calls) {
            call.emitted = true;
            const tc = { type: "toolCall" as const, id: call.callId, name: call.toolName, arguments: call.args };
            output.content.push(tc);
            const idx = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });
          }

          finish("toolUse");
          return true;
        };
        const scheduleToolFlush = () => {
          if (toolFlushTimer) clearTimeout(toolFlushTimer);
          toolFlushTimer = setTimeout(() => {
            toolFlushTimer = null;
            flushToolCalls();
          }, TOOL_CALL_DEBOUNCE_MS);
        };

        // Watch for tool calls. Debounce so parallel tool calls land in one assistant message.
        onToolCallFromBridge = (call) => {
          log("tool call queued", { callId: call.callId, toolName: call.toolName });
          scheduleToolFlush();
        };
        if (unemittedToolCalls().length > 0) scheduleToolFlush();

        // Watch for prompt completion (guard with generation to avoid stale handlers)
        activePromptDone?.then(
          () => { if (gen === streamGen && !settled) { if (!flushToolCalls()) { log("prompt done → stop"); finish("stop"); } } },
          (e) => { if (gen === streamGen && !settled) { promptError = e; if (!flushToolCalls()) { log("prompt error → error", e?.message); finish("error"); } } },
        );
      });

      updateHandler = null;

      // Close open blocks
      if (thinkingStarted) {
        stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any).thinking, partial: output });
      }
      if (textStarted) {
        stream.push({ type: "text_end", contentIndex: textIdx, content: (output.content[textIdx] as any).text, partial: output });
      }

      log("outcome", { outcome, gen, streamGen });

      if (outcome === "toolUse") {
        output.stopReason = "toolUse";
        output.usage = estimateUsage(output);
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else if (outcome === "error") {
        activePromptDone = null;
        output.stopReason = "error";
        output.errorMessage = promptError?.message || "Kiro ACP prompt failed";
        output.usage = estimateUsage(output);
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        activePromptDone = null;
        output.stopReason = "stop";
        output.usage = estimateUsage(output);
        stream.push({ type: "done", reason: "stop", message: output });
      }

      stream.end();
    } catch (error) {
      output.stopReason = "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastUserMessage(context: Context): string {
  const msgs = context.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      const content = msgs[i].content;
      if (typeof content === "string") return content;
      return (content as any[]).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    }
  }
  return "";
}

interface ToolResultInfo { toolCallId: string; toolName: string; text: string; isError: boolean; }

function deliverToolResults(toolResults: ToolResultInfo[]): void {
  for (const tr of toolResults) {
    const exact = pendingToolCalls.get(tr.toolCallId);
    const nameMatches = [...pendingToolCalls.entries()].filter(([, call]) => call.toolName === tr.toolName);
    const match = exact ? [tr.toolCallId, exact] as const : nameMatches.length === 1 ? nameMatches[0] : null;

    if (match) {
      const [callId, call] = match;
      pendingToolCalls.delete(callId);
      log("delivering tool result", { callId, toolName: call.toolName, resultLen: tr.text.length });
      call.resolve({ result: tr.text, isError: tr.isError });
    } else {
      log("UNMATCHED tool result", { toolCallId: tr.toolCallId, toolName: tr.toolName, pendingCalls: [...pendingToolCalls.keys()] });
    }
  }
}

function extractToolResults(context: Context): ToolResultInfo[] {
  const results: ToolResultInfo[] = [];
  const msgs = context.messages || [];
  // Collect trailing toolResult messages (pi sends one per tool call)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role === "toolResult") {
      const text = (msg.content as any[]).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      results.push({
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        text,
        isError: msg.isError,
      });
    } else if (msg.role === "assistant") {
      break; // Stop at the assistant message that triggered tool calls
    }
  }
  return results.reverse();
}

function estimateUsage(output: AssistantMessage) {
  let chars = 0;
  for (const b of output.content) if (b.type === "text") chars += b.text.length;
  const tokens = Math.round(chars / 4);
  return { input: 0, output: tokens, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kiro-acp", {
    name: "Kiro ACP",
    baseUrl: "local",
    apiKey: "KIRO_ACP_DUMMY",
    api: "kiro-acp-api" as any,
    models: [
      { id: "claude-opus-4.6", name: "Claude Opus 4.6 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
      { id: "claude-opus-4.5", name: "Claude Opus 4.5 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
      { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
      { id: "deepseek-3.2", name: "DeepSeek 3.2 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "minimax-m2.5", name: "MiniMax M2.5 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "minimax-m2.1", name: "MiniMax M2.1 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "glm-5", name: "GLM-5 (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "qwen3-coder-next", name: "Qwen3 Coder Next (Kiro)", reasoning: false, input: ["text"] as any, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
    ],
    streamSimple: streamKiroAcp,
  });

  pi.on("session_shutdown", async () => {
    await stopClient();
  });
}
