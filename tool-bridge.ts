import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ForwardedTool, ForwardedToolCatalog } from "./tool-catalog.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 64 * 1024;
/** How often a still-running tool call gets a keepalive on the SSE response. */
const DEFAULT_KEEPALIVE_MS = 20_000;

type JsonRpcId = number | string | null;
type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

export interface ToolBridgeContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolBridgeResult {
  content: ToolBridgeContent[];
  isError?: boolean;
}

export interface ToolBridgeCall {
  requestId: JsonRpcId;
  kiroName: string;
  piName: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}

export type ToolBridgeCatalog =
  ForwardedToolCatalog | (() => ForwardedToolCatalog);
export type ToolBridgeCallHandler = (
  call: ToolBridgeCall,
) => Promise<ToolBridgeResult>;

export interface ToolBridgeOptions {
  catalog: ToolBridgeCatalog;
  onToolCall: ToolBridgeCallHandler;
  /** Exact Origin values accepted when a client sends an Origin header. */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  /**
   * Keepalive cadence for a tool call answered over SSE. Kiro's MCP client
   * abandons a tools/call that produces no bytes for long enough, which silently
   * loses the result of any slow pi tool; periodic traffic prevents that.
   * 0 disables keepalives.
   */
  keepaliveMs?: number;
  /** Optional sink for transport-level diagnostics (wired to the debug log). */
  onDebug?: (message: string, data?: Record<string, unknown>) => void;
}

export interface ToolBridge {
  readonly token: string;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

interface PendingCall {
  response: ServerResponse;
  abort: AbortController;
  stopKeepalive: () => void;
}

function jsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded || res.destroyed) return;
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(body, "utf8") > maxBytes)
      throw new Error("request body too large");
  }
  return body;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

function textResult(text: string, isError = false): ToolBridgeResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function resolveCatalog(source: ToolBridgeCatalog): ForwardedToolCatalog {
  return typeof source === "function" ? source() : source;
}

function validOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  // Kiro 2.5.0 sends no Origin. Keep that compatibility behavior while
  // rejecting every supplied origin unless explicitly allowed by the caller.
  return origin === undefined || allowedOrigins.has(origin);
}

function validAccept(header: string | undefined): boolean {
  if (!header) return true;
  return header.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      mediaType === "application/json" ||
      mediaType === "text/event-stream" ||
      mediaType === "*/*"
    );
  });
}

/** Only stream when the client explicitly opted into SSE, per the MCP transport. */
function acceptsEventStream(header: string | undefined): boolean {
  if (!header) return false;
  return header
    .split(",")
    .some(
      (part) =>
        part.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream",
    );
}

function progressTokenOf(params: unknown): string | number | undefined {
  const token = (params as { _meta?: { progressToken?: unknown } } | undefined)
    ?._meta?.progressToken;
  return typeof token === "string" || typeof token === "number"
    ? token
    : undefined;
}

/** Open an SSE response and stream JSON-RPC messages over it. */
function openEventStream(res: ServerResponse): (message: unknown) => void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.flushHeaders?.();
  return (message: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };
}

/** Start a minimal authenticated Streamable HTTP MCP server on loopback. */
export async function startToolBridge(
  options: ToolBridgeOptions,
): Promise<ToolBridge> {
  const token = randomBytes(32).toString("hex");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const pending = new Map<ServerResponse, PendingCall>();
  let closed = false;

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp") {
      sendJson(res, 404, jsonRpcError(null, -32601, "Not found"));
      return;
    }

    const authorization = req.headers.authorization;
    if (authorization !== `Bearer ${token}`) {
      sendJson(
        res,
        401,
        { error: "Unauthorized" },
        { "www-authenticate": "Bearer" },
      );
      return;
    }
    if (!validOrigin(req.headers.origin, allowedOrigins)) {
      sendJson(res, 403, { error: "Origin not allowed" });
      return;
    }
    if (!validAccept(req.headers.accept)) {
      sendJson(res, 406, {
        error: "Accept must include application/json or text/event-stream",
      });
      return;
    }

    if (req.method === "DELETE") {
      sendJson(res, 202);
      void closeBridge();
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, jsonRpcError(null, -32601, "Method not allowed"), {
        allow: "POST, DELETE",
      });
      return;
    }

    let message: JsonRpcMessage;
    try {
      const body = await readBody(req, maxBodyBytes);
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid request");
      message = parsed as JsonRpcMessage;
    } catch (error) {
      const tooLarge =
        error instanceof Error && error.message === "request body too large";
      sendJson(
        res,
        tooLarge ? 413 : 400,
        jsonRpcError(
          null,
          tooLarge ? -32600 : -32700,
          tooLarge ? "Request body too large" : "Invalid JSON",
        ),
      );
      return;
    }

    const id = isJsonRpcId(message.id) ? message.id : undefined;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      sendJson(res, 400, jsonRpcError(id, -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (message.method === "notifications/initialized") {
      sendJson(res, 202);
      return;
    }
    if (id === undefined) {
      sendJson(res, 400, jsonRpcError(null, -32600, "Request id is required"));
      return;
    }

    switch (message.method) {
      case "initialize": {
        const requested = (
          message.params as { protocolVersion?: unknown } | undefined
        )?.protocolVersion;
        const protocolVersion =
          requested === MCP_PROTOCOL_VERSION || requested === "2024-11-05"
            ? requested
            : MCP_PROTOCOL_VERSION;
        sendJson(
          res,
          200,
          jsonRpcResult(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "pi_host", version: "1.0.0" },
          }),
        );
        return;
      }
      case "tools/list": {
        const catalog = resolveCatalog(options.catalog);
        const tools = catalog.tools.map((tool: ForwardedTool) => ({
          name: tool.kiroName,
          description: tool.description,
          inputSchema: tool.parameters,
        }));
        sendJson(res, 200, jsonRpcResult(id, { tools }));
        return;
      }
      case "prompts/list":
        sendJson(res, 200, jsonRpcResult(id, { prompts: [] }));
        return;
      case "resources/list":
        sendJson(res, 200, jsonRpcResult(id, { resources: [] }));
        return;
      case "tools/call": {
        const params = message.params as
          { name?: unknown; arguments?: unknown } | undefined;
        if (typeof params?.name !== "string") {
          sendJson(res, 200, jsonRpcError(id, -32602, "Tool name is required"));
          return;
        }
        const catalog = resolveCatalog(options.catalog);
        const piName = catalog.piNameByKiroName.get(params.name);
        if (!piName) {
          sendJson(res, 200, jsonRpcError(id, -32602, "Unknown tool"));
          return;
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          sendJson(
            res,
            200,
            jsonRpcError(id, -32602, "Tool arguments must be an object"),
          );
          return;
        }

        // Pi tools can run for many minutes (subagents, deep research). A plain
        // JSON response means no bytes flow until the tool finishes, and Kiro's
        // MCP client eventually abandons the request — losing the result. When
        // the client accepts SSE, answer over a stream and keep it warm.
        const streaming = acceptsEventStream(req.headers.accept);
        const progressToken = progressTokenOf(message.params);
        const startedAt = Date.now();
        options.onDebug?.("bridge tools/call accepted", {
          tool: params.name,
          accept: req.headers.accept,
          streaming,
          hasProgressToken: progressToken !== undefined,
          pendingCount: pending.size + 1,
        });
        const sendEvent = streaming ? openEventStream(res) : undefined;

        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
        let progress = 0;
        const stopKeepalive = () => {
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        };
        if (sendEvent && keepaliveMs > 0) {
          keepaliveTimer = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
              stopKeepalive();
              return;
            }
            // An SSE comment keeps the socket warm for clients with an idle
            // read timeout; a progress notification is what resets an
            // MCP-level request timeout, but only if a token was supplied.
            res.write(`: keepalive ${Date.now() - startedAt}ms\n\n`);
            if (progressToken !== undefined) {
              sendEvent({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: ++progress,
                  message: `${params.name} still running (${Math.round((Date.now() - startedAt) / 1000)}s)`,
                },
              });
            }
          }, keepaliveMs);
          keepaliveTimer.unref?.();
        }

        const respond = (body: unknown) => {
          stopKeepalive();
          if (sendEvent) {
            sendEvent(body);
            if (!res.writableEnded && !res.destroyed) res.end();
            return;
          }
          if (!res.destroyed) sendJson(res, 200, body);
        };

        const abort = new AbortController();
        const clearPending = () => {
          pending.delete(res);
        };
        pending.set(res, { response: res, abort, stopKeepalive });
        // If the client disconnects mid-call, abort pi's execution. The response
        // socket is destroyed either way, so nothing is written back to the client.
        res.once("close", () => {
          const held = pending.get(res);
          if (res.writableEnded || !held) return;
          stopKeepalive();
          abort.abort();
          options.onDebug?.("bridge tools/call disconnected by client", {
            tool: params.name,
            streaming,
            waitedMs: Date.now() - startedAt,
            remainingPending: pending.size - 1,
          });
          clearPending();
        });
        let result: ToolBridgeResult;
        try {
          result = await options.onToolCall({
            requestId: id,
            kiroName: params.name as string,
            piName,
            arguments: args as Record<string, unknown>,
            signal: abort.signal,
          });
        } catch (error) {
          result = textResult(
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
        clearPending();
        respond(jsonRpcResult(id, result));
        return;
      }
      default:
        sendJson(res, 200, jsonRpcError(id, -32601, "Method not found"));
    }
  });

  const closeBridge = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const held = [...pending.values()];
    pending.clear();
    for (const call of held) {
      call.abort.abort();
      call.stopKeepalive();
      call.response.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeBridge();
    throw new Error("MCP adapter did not bind to a TCP port");
  }
  return {
    token,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: closeBridge,
  };
}
