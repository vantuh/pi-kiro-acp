import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { tmpdir } from "node:os";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { KIRO_THINKING_LEVEL_MAP } from "./models/fallback.ts";
import { stableJson } from "./helpers.ts";
import { log, msSince } from "./logging.ts";
import { loadKiroAcpConfig, resolveLoggerConfig } from "./config.ts";
import { getDescendantPids, terminateProcessTree } from "./process-utils.ts";
import {
  clearPersistedKiroSession,
  loadPersistedKiroSession,
} from "./session-persistence.ts";
import {
  startToolBridge,
  type ToolBridge,
  type ToolBridgeCall,
  type ToolBridgeContent,
  type ToolBridgeResult,
} from "./tool-bridge.ts";
import type { ForwardedToolCatalog } from "./tool-catalog.ts";
import type {
  PendingRpc,
  PendingToolCall,
  SessionMetadata,
  SessionUpdate,
  ToolResultContentBlock,
  ToolResultInfo,
} from "./types.ts";

interface StartPromptOptions {
  expectedHistoryFingerprint?: string;
  replayUserMessage?: string;
}

type KiroEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Builds the current extension-only tool catalog exposed to Kiro via pi_host. */
export type CatalogProvider = () => ForwardedToolCatalog;

/** Native Kiro tools Kiro executes directly (the fast path). Pi extension tools
 * are forwarded through the pi_host MCP bridge instead. Kiro's native
 * web_search / web_fetch are intentionally excluded so pi's web tools win. */
const NATIVE_KIRO_TOOLS = [
  "fs_read",
  "fs_write",
  "execute_bash",
  "glob",
  "grep",
];

/** kiro-cli `-v` repeat count from kiro-acp.json logger.verbose (0 = off, max 3).
 * Its verbose output goes to stdout, the same pipe as JSON-RPC, so those lines are
 * picked out of the framing path below. */
const KIRO_VERBOSITY = resolveLoggerConfig(loadKiroAcpConfig()).verbose;

/** kiro-cli colours its verbose output; keep the debug log readable. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Process-wide: kiro-cli settings are global; configure once per pi process.
 * `Ready` flips true after the first success; `InFlight` lets concurrent cold
 * starts share one settings call instead of each spawning their own. */
let mcpNoInteractiveTimeoutReady = false;
let mcpNoInteractiveTimeoutInFlight: Promise<void> | null = null;

/** `mcp.noInteractiveTimeout` is the MCP *initialization* timeout in
 * milliseconds for non-interactive runs (kiro-cli default 30000). It does not
 * bound individual tool calls — long pi tools are kept alive by the bridge's
 * keepalive instead (see tool-bridge.ts). */
const MCP_NO_INTERACTIVE_TIMEOUT_MS = 120000;

/** Grace period between answering Kiro's outstanding tools/call and cancelling
 * its turn, so the tool_result is consumed while its agent still processes tools
 * instead of being dropped once the cancel puts it in Idle. */
const TOOL_RESULT_DRAIN_MS = Number(process.env.PI_KIRO_ACP_DRAIN_MS) || 150;

export function toKiroEffort(
  reasoning: SimpleStreamOptions["reasoning"],
): KiroEffort | null {
  if (!reasoning) return null;
  // Unknown/future reasoning values intentionally fall back to null (unset):
  // the `as` cast below is a lookup convenience, and a miss coalesces to null
  // rather than throwing — same as passing no reasoning at all.
  return (
    KIRO_THINKING_LEVEL_MAP[
      reasoning as keyof typeof KIRO_THINKING_LEVEL_MAP
    ] ?? null
  );
}

export class AcpSession {
  readonly id = `s-${randomBytes(4).toString("hex")}`;
  cwd: string;
  proc: ChildProcess | null = null;
  rl: ReadlineInterface | null = null;
  rpcId = 0;
  rpcPending = new Map<number, PendingRpc>();
  acpSessionId: string | null = null;
  /** SHA-256 of last system prompt wrapped into this ACP session; null = not sent yet. */
  systemPromptHash: string | null = null;
  currentModelId: string | null = null;
  currentEffort: KiroEffort | null = null;
  toolBridge: ToolBridge | null = null;
  catalogProvider: CatalogProvider | null = null;
  private bridgeCallSeq = 0;
  agentRootPath: string | null = null;
  agentConfigPath: string | null = null;
  readonly agentName = `pi-kiro-${randomBytes(4).toString("hex")}`;
  started = false;
  updateHandler: ((u: SessionUpdate) => void) | null = null;
  metadata: SessionMetadata | null = null;
  agentCapabilities: any = null;
  persistenceKey: string | null = null;
  pendingToolCalls = new Map<string, PendingToolCall>();
  /** Calls Kiro abandoned at its own deadline while pi kept executing them,
   * keyed by tool name + arguments so a retry can be answered instead of run. */
  private abandonedToolCalls = new Map<
    string,
    { callId: string; toolName: string; abandonedAt: number }
  >();
  onToolCallFromBridge: ((call: PendingToolCall) => void) | null = null;
  activePromptDone: Promise<{ stopReason: string }> | null = null;
  /** Bumped per session/prompt so a late-settling prompt only clears its own. */
  private promptSeq = 0;
  /** Why the last prompt failed, for streams that attach after activePromptDone was cleared. */
  lastPromptError: Error | null = null;
  streamGen = 0;
  /** Set by the stream when its turn closed. A tools/call arriving after that
   * can never be handed to pi, so it is answered immediately instead of being
   * left to hang until Kiro's own deadline. Cleared by every startPrompt. */
  toolIntakeClosed = false;
  lastUsedAt = Date.now();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  get busy(): boolean {
    return !!this.activePromptDone || this.pendingToolCalls.size > 0;
  }

  rpcSend(
    method: string,
    params: unknown,
    timeoutMs = 60000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable)
        return reject(new Error("kiro-cli not running"));
      const id = this.rpcId++;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.rpcPending.delete(id);
              log("RPC TIMEOUT", {
                session: this.id,
                method,
                id,
                timeoutMs,
                remainingPending: this.rpcPending.size,
              });
              reject(new Error(`RPC timeout: ${method}`));
            }, timeoutMs)
          : null;
      this.rpcPending.set(id, {
        resolve,
        reject,
        timer,
        startedAt: Date.now(),
        method,
      });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      log("rpc →", {
        session: this.id,
        method,
        id,
        timeoutMs,
        pendingCount: this.rpcPending.size,
      });
    });
  }

  rpcNotify(method: string, params: unknown): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
    }
  }

  rpcRespond(id: number, result: unknown): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
      );
    }
  }

  handleStdoutLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: any;
    try {
      msg = JSON.parse(s);
    } catch {
      // With logger.verbose, kiro-cli's own -v logs land on this same
      // stdout pipe; keep them in full instead of as truncated parse errors.
      if (KIRO_VERBOSITY > 0)
        log("kiro log", { session: this.id, text: stripAnsi(s) });
      else
        log("stdout parse error", { session: this.id, line: s.slice(0, 200) });
      return;
    }

    // Dispatch runs consumer callbacks synchronously inside readline's 'line'
    // event; an escaping throw would kill the pi process.
    try {
      this.dispatchStdoutMessage(msg);
    } catch (error) {
      log("stdout dispatch error", {
        session: this.id,
        method: typeof msg?.method === "string" ? msg.method : undefined,
        id: msg?.id,
        error:
          error instanceof Error ? error.stack || error.message : String(error),
      });
    }
  }

  private dispatchStdoutMessage(msg: any): void {
    const hasId = "id" in msg && msg.id != null;
    const hasMethod = "method" in msg && typeof msg.method === "string";

    if (hasId && !hasMethod) {
      const p = this.rpcPending.get(msg.id);
      if (!p) {
        log("orphan RPC response", {
          session: this.id,
          id: msg.id,
          hasError: !!msg.error,
        });
        return;
      }
      if (p.timer) clearTimeout(p.timer);
      this.rpcPending.delete(msg.id);
      log("rpc ←", {
        session: this.id,
        method: p.method,
        id: msg.id,
        ms: msSince(p.startedAt),
        hasError: !!msg.error,
      });
      msg.error
        ? p.reject(new Error(msg.error.message || "RPC error"))
        : p.resolve(msg.result);
    } else if (hasId && hasMethod) {
      if (msg.method === "session/request_permission") {
        const opts = msg.params?.options || [];
        const optId =
          opts.find((o: any) => o.id === "allow_always")?.id ||
          opts[0]?.id ||
          "allow_once";
        this.rpcRespond(msg.id, {
          outcome: { outcome: "selected", optionId: optId },
        });
      } else {
        this.rpcRespond(msg.id, null);
      }
    } else if (hasMethod) {
      if (
        msg.method === "session/update" ||
        msg.method === "_kiro.dev/session/update"
      ) {
        const update = msg.params?.update as SessionUpdate | undefined;
        if (update) {
          if (update.sessionUpdate === "usage_update") {
            this.handleUsageUpdate(update, msg.params?.sessionId);
          }
          this.updateHandler?.(update);
        }
      } else if (msg.method === "_kiro.dev/metadata") {
        this.handleMetadata(msg.params || {});
      }
    }
  }

  private handleUsageUpdate(
    update: SessionUpdate,
    updateSessionId: unknown,
  ): void {
    const sessionId =
      typeof updateSessionId === "string" ? updateSessionId : this.acpSessionId;
    if (!sessionId) return;
    if (this.acpSessionId && sessionId !== this.acpSessionId) return;

    const contextUsed =
      typeof update.used === "number" ? update.used : undefined;
    const contextSize =
      typeof update.size === "number" && update.size > 0
        ? update.size
        : undefined;
    if (contextUsed === undefined || contextSize === undefined) return;

    const rawCost = update.cost as Record<string, unknown> | null | undefined;
    const sessionCost =
      rawCost &&
      typeof rawCost.amount === "number" &&
      typeof rawCost.currency === "string"
        ? { amount: rawCost.amount, currency: rawCost.currency }
        : undefined;

    this.metadata = {
      ...this.metadata,
      sessionId,
      contextUsagePercentage: (Math.max(0, contextUsed) / contextSize) * 100,
      contextUsed: Math.max(0, contextUsed),
      contextSize,
      ...(update.cost !== undefined ? { sessionCost } : {}),
    };
    log("ACP usage update", {
      session: this.id,
      acpSessionId: sessionId,
      contextUsed,
      contextSize,
      sessionCost,
    });
  }

  private handleMetadata(params: Record<string, unknown>): void {
    const sessionId =
      typeof params.sessionId === "string"
        ? params.sessionId
        : this.acpSessionId;
    if (!sessionId) return;
    if (this.acpSessionId && sessionId !== this.acpSessionId) return;

    const contextUsagePercentage =
      typeof params.contextUsagePercentage === "number"
        ? params.contextUsagePercentage
        : undefined;
    const turnDurationMs =
      typeof params.turnDurationMs === "number"
        ? params.turnDurationMs
        : undefined;
    const meteringUsage = Array.isArray(params.meteringUsage)
      ? params.meteringUsage
          .filter(
            (m: any) =>
              typeof m?.unit === "string" && typeof m?.value === "number",
          )
          .map((m: any) => ({
            unit: m.unit,
            unitPlural:
              typeof m.unitPlural === "string" ? m.unitPlural : undefined,
            value: m.value,
          }))
      : undefined;

    this.metadata = {
      ...this.metadata,
      sessionId,
      contextUsagePercentage:
        contextUsagePercentage ?? this.metadata?.contextUsagePercentage,
      meteringUsage: meteringUsage ?? this.metadata?.meteringUsage,
      turnDurationMs: turnDurationMs ?? this.metadata?.turnDurationMs,
    };
    log("kiro metadata", {
      session: this.id,
      acpSessionId: sessionId,
      contextUsagePercentage,
      turnDurationMs,
      credits: meteringUsage?.find((m) => m.unit === "credit")?.value,
    });
  }

  async ensureStarted(
    catalogProvider: CatalogProvider,
    effort: KiroEffort | null = this.currentEffort,
  ): Promise<void> {
    this.lastUsedAt = Date.now();
    this.catalogProvider = catalogProvider;
    if (this.started && this.currentEffort !== effort) {
      if (this.busy) {
        log("deferring effort change while session is busy", {
          session: this.id,
          currentEffort: this.currentEffort,
          requestedEffort: effort,
        });
      } else {
        log("restarting Kiro for effort change", {
          session: this.id,
          currentEffort: this.currentEffort,
          requestedEffort: effort,
        });
        await this.stop();
      }
    }
    if (this.started) {
      return;
    }

    const ensureStartedAt = Date.now();
    this.currentEffort = effort;
    await this.startBridge();
    const bridgeReadyAt = Date.now();
    this.writeAgentCfg();

    // Overlap with spawn/initialize — setting is global and only needed before
    // tools. configureMcpTimeout never rejects (execFile errors are swallowed).
    const mcpCfgPromise = this.configureMcpTimeout();

    log("starting kiro session", {
      session: this.id,
      cwd: this.cwd,
      agentRootPath: this.agentRootPath,
      agentName: this.agentName,
      effort: this.currentEffort,
    });
    const args = ["acp", "--agent", this.agentName, "--trust-all-tools"];
    if (this.currentEffort) args.push("--effort", this.currentEffort);
    if (KIRO_VERBOSITY > 0) args.push(`-${"v".repeat(KIRO_VERBOSITY)}`);
    const spawnAt = Date.now();
    this.proc = spawn("kiro-cli", args, {
      cwd: this.agentRootPath || this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleStdoutLine(line));
    this.proc.stderr?.on("data", (chunk) => {
      for (const text of String(chunk).split("\n")) {
        if (text.trim())
          log("kiro stderr", { session: this.id, text: stripAnsi(text) });
      }
    });

    this.proc.on("exit", (code, signal) => {
      log("kiro exited", { session: this.id, code, signal });
      this.cleanupAfterProcessExit();
    });

    const init = (await this.rpcSend(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "pi-kiro-acp", version: "1.0.0" },
      },
      30000,
    )) as any;
    const initDoneAt = Date.now();
    const mcpCfgMs = await mcpCfgPromise;
    this.agentCapabilities = init?.agentCapabilities || null;
    log("session initialized", {
      session: this.id,
      bridgePort: this.toolBridge?.port ?? null,
      pid: this.proc?.pid,
      loadSession: this.supportsLoadSession(),
      resumeSession: this.supportsResumeSession(),
      timing: {
        bridgeMs: bridgeReadyAt - ensureStartedAt,
        preSpawnSetupMs: spawnAt - bridgeReadyAt,
        mcpCfgMs,
        initializeMs: initDoneAt - spawnAt,
        totalMs: msSince(ensureStartedAt),
      },
    });

    this.started = true;
  }

  /** Configure the global kiro-cli setting once per process. Resolves with the
   * settings-call duration in ms (0 when skipped or shared with an in-flight
   * call). Never rejects — execFile errors are logged and swallowed, so a
   * failure simply retries on the next cold start. */
  private configureMcpTimeout(): Promise<number> {
    if (mcpNoInteractiveTimeoutReady) {
      log("skipped mcp.noInteractiveTimeout (already configured)", {
        session: this.id,
      });
      return Promise.resolve(0);
    }
    if (mcpNoInteractiveTimeoutInFlight) {
      log("skipped mcp.noInteractiveTimeout (in flight)", { session: this.id });
      return mcpNoInteractiveTimeoutInFlight.then(() => 0);
    }
    const startedAt = Date.now();
    mcpNoInteractiveTimeoutInFlight = new Promise<void>((resolve) => {
      execFile(
        "kiro-cli",
        [
          "settings",
          "mcp.noInteractiveTimeout",
          String(MCP_NO_INTERACTIVE_TIMEOUT_MS),
        ],
        { timeout: 5000 },
        (error) => {
          if (error) {
            log("failed to configure mcp.noInteractiveTimeout", {
              session: this.id,
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            mcpNoInteractiveTimeoutReady = true;
            log("configured mcp.noInteractiveTimeout", {
              session: this.id,
              ms: MCP_NO_INTERACTIVE_TIMEOUT_MS,
            });
          }
          // Clear so a failed call retries next cold start; harmless on success.
          mcpNoInteractiveTimeoutInFlight = null;
          resolve();
        },
      );
    });
    return mcpNoInteractiveTimeoutInFlight.then(() => msSince(startedAt));
  }

  private supportsLoadSession(): boolean {
    return this.agentCapabilities?.loadSession === true;
  }

  private supportsResumeSession(): boolean {
    return !!this.agentCapabilities?.sessionCapabilities?.resume;
  }

  private async ensureBackendSession(
    options: StartPromptOptions,
  ): Promise<boolean> {
    if (this.acpSessionId) return false;

    let shouldReplayHistory = true;
    const persisted = this.persistenceKey
      ? loadPersistedKiroSession(this.persistenceKey)
      : null;
    const canUsePersisted =
      !!persisted &&
      !!options.expectedHistoryFingerprint &&
      persisted.historyFingerprint === options.expectedHistoryFingerprint;

    if (persisted && !canUsePersisted) {
      log("persisted kiro session fingerprint mismatch", {
        session: this.id,
        key: this.persistenceKey,
        kiroSessionId: persisted.kiroSessionId,
      });
    }

    if (persisted && canUsePersisted) {
      const restored = await this.tryRestorePersistedSession(
        persisted.kiroSessionId,
      );
      if (restored) {
        this.currentModelId = persisted.modelId || null;
        shouldReplayHistory = false;
      }
    }

    if (!this.acpSessionId) {
      const result = (await this.rpcSend("session/new", {
        cwd: this.cwd,
        mcpServers: this.mcpServersConfig(),
      })) as any;
      this.acpSessionId = result.sessionId;
      this.systemPromptHash = null;
      log("acp session/new", {
        session: this.id,
        acpSessionId: this.acpSessionId,
        replayHistory: shouldReplayHistory,
      });
    }

    return shouldReplayHistory;
  }

  private async tryRestorePersistedSession(
    kiroSessionId: string,
  ): Promise<boolean> {
    const attempts = [
      {
        method: "session/resume" as const,
        enabled: this.supportsResumeSession(),
      },
      { method: "session/load" as const, enabled: this.supportsLoadSession() },
    ].filter((attempt) => attempt.enabled);

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      try {
        await this.rpcSend(
          attempt.method,
          {
            sessionId: kiroSessionId,
            cwd: this.cwd,
            mcpServers: this.mcpServersConfig(),
          },
          15000,
        );
        this.acpSessionId = kiroSessionId;
        // Re-bind current pi instructions after resume/load.
        this.systemPromptHash = null;
        log("restored persisted kiro session", {
          session: this.id,
          method: attempt.method,
          acpSessionId: this.acpSessionId,
        });
        return true;
      } catch (error) {
        const isLastAttempt = i === attempts.length - 1;
        log("failed to restore persisted kiro session", {
          session: this.id,
          method: attempt.method,
          acpSessionId: kiroSessionId,
          willFallbackToFresh: isLastAttempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!isLastAttempt) continue;
        if (this.persistenceKey) clearPersistedKiroSession(this.persistenceKey);
        await this.restartAfterRestoreFailure();
        return false;
      }
    }

    log("persisted kiro session unavailable: restore unsupported", {
      session: this.id,
      acpSessionId: kiroSessionId,
      loadSession: this.supportsLoadSession(),
      resumeSession: this.supportsResumeSession(),
    });
    return false;
  }

  private async restartAfterRestoreFailure(): Promise<void> {
    if (!this.started || !this.catalogProvider) return;
    log("restarting kiro process after failed restore", { session: this.id });
    const catalogProvider = this.catalogProvider;
    await this.stop();
    await this.ensureStarted(catalogProvider);
  }

  async startPrompt(
    modelId: string,
    systemPrompt: string,
    userMessage: string,
    images: { type: "image"; data: string; mimeType: string }[] = [],
    options: StartPromptOptions = {},
  ): Promise<void> {
    const startPromptAt = Date.now();
    const shouldReplayHistory = await this.ensureBackendSession(options);
    const backendReadyAt = Date.now();
    const promptUserMessage =
      shouldReplayHistory && options.replayUserMessage
        ? options.replayUserMessage
        : userMessage;

    const previousModelId = this.currentModelId;
    if (this.currentModelId !== modelId) {
      await this.rpcSend(
        "session/set_model",
        { sessionId: this.acpSessionId, modelId },
        30000,
      );
      this.currentModelId = modelId;
      log("model set", {
        session: this.id,
        modelId,
        previousModel: previousModelId,
      });
    }
    const modelReadyAt = Date.now();

    // Send full <system_instructions> once per ACP session (and again if pi changes it).
    const systemHash = systemPrompt ? hashSystemPrompt(systemPrompt) : null;
    const includeSystem = !!systemHash && systemHash !== this.systemPromptHash;
    const promptText = includeSystem
      ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${promptUserMessage}`
      : promptUserMessage;

    this.metadata = null;

    // Optimistically record the system-prompt hash, but roll it back if the
    // prompt RPC fails while the process is still alive, so the next turn
    // re-sends <system_instructions> instead of silently running without them.
    // pi serializes turns, so the rollback lands before the next startPrompt
    // reads the hash.
    const prevSystemPromptHash = this.systemPromptHash;
    if (includeSystem && systemHash) this.systemPromptHash = systemHash;

    this.lastPromptError = null;
    this.toolIntakeClosed = false;
    if (this.activePromptDone) {
      log("startPrompt overlapping an in-flight prompt", {
        session: this.id,
        pendingToolCalls: this.pendingToolCalls.size,
      });
    }
    // Nulled as soon as the RPC settles, even if the stream for this turn
    // already ended with `toolUse` (Kiro can finish its turn while pi is still
    // running a tool). Without this the session stays `busy` forever and
    // routing keeps spawning parallel kiro-cli processes for it.
    const promptGen = ++this.promptSeq;
    const clearActivePrompt = (stopReason: string) => {
      if (this.promptSeq !== promptGen) return;
      this.activePromptDone = null;
      log("active prompt settled", {
        session: this.id,
        stopReason,
        pendingToolCalls: this.pendingToolCalls.size,
        elapsedMs: msSince(startPromptAt),
      });
    };
    const promptDone = (
      this.rpcSend(
        "session/prompt",
        {
          sessionId: this.acpSessionId,
          prompt: [{ type: "text", text: promptText }, ...images],
        },
        0,
      ) as Promise<any>
    ).then(
      (r: any) => {
        clearActivePrompt(r?.stopReason || "end_turn");
        return { stopReason: r?.stopReason || "end_turn" };
      },
      (e: Error) => {
        clearActivePrompt("error");
        this.systemPromptHash = prevSystemPromptHash;
        this.lastPromptError = e;
        throw e;
      },
    );
    // Keep the rejection observed: Node turns an unobserved one into an
    // uncaughtException, which kills pi. Consumers still get their own copy.
    promptDone.catch(() => {});
    this.activePromptDone = promptDone;

    log("prompt sent", {
      session: this.id,
      modelId,
      replayHistory: shouldReplayHistory,
      promptChars: promptText.length,
      systemPromptChars: includeSystem ? systemPrompt.length : 0,
      systemPromptIncluded: includeSystem,
      systemPromptSkipped: !!systemPrompt && !includeSystem,
      userMessageChars: promptUserMessage.length,
      imageCount: images.length,
      timing: {
        backendMs: backendReadyAt - startPromptAt,
        setModelMs: modelReadyAt - backendReadyAt,
        totalMs: msSince(startPromptAt),
      },
    });
  }

  private cleanupAfterProcessExit(): void {
    log("cleanupAfterProcessExit", {
      session: this.id,
      pendingRpcs: this.rpcPending.size,
      pendingToolCalls: this.pendingToolCalls.size,
      hadActivePrompt: !!this.activePromptDone,
    });
    this.settlePendingState("kiro-cli exited", "kiro-cli exited");
    void this.teardownBridgeAndFiles().catch(() => {});
  }

  /** Close the readline/stdio handles, delete agent files, stop the bridge.
   * Shared by stop and process-exit teardown. File cleanup happens before the
   * awaited bridge close so the process-exit path removes them in the same
   * tick as the exit event — a same-tick restart rewrites the same id-derived
   * agent paths, and a deferred deletion would race it. */
  private async teardownBridgeAndFiles(): Promise<void> {
    this.rl?.close();
    this.proc = null;
    this.rl = null;
    this.removeAgentFiles();

    const bridge = this.toolBridge;
    this.toolBridge = null;
    if (bridge) await bridge.close().catch(() => {});
  }

  async stop(): Promise<void> {
    log("stopping kiro session", { session: this.id });
    this.settlePendingState("Shutting down", "Stopped");

    if (this.proc) {
      const p = this.proc;
      const rootPid = p.pid;
      const knownDescendants = rootPid ? getDescendantPids(rootPid) : [];
      log("stop: killing process tree", {
        session: this.id,
        rootPid,
        descendants: knownDescendants,
      });
      await terminateProcessTree(p, 5000, knownDescendants);
    }

    await this.teardownBridgeAndFiles();
  }

  /** Fail every pending rpc/tool call and drop session state so neither the
   * stream nor Kiro waits on a dead session. Shared by stop and process-exit.
   * The reject message is what consumers (and their logs) see. */
  private settlePendingState(
    toolResultMessage: string,
    rpcRejectMessage: string,
  ): void {
    this.started = false;
    this.updateHandler = null;
    this.onToolCallFromBridge = null;
    this.activePromptDone = null;

    for (const [, call] of this.pendingToolCalls)
      call.resolve({ result: toolResultMessage, isError: true });
    this.pendingToolCalls.clear();
    this.abandonedToolCalls.clear();

    for (const [, p] of this.rpcPending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(rpcRejectMessage));
    }
    this.rpcPending.clear();

    this.acpSessionId = null;
    this.systemPromptHash = null;
    this.currentModelId = null;
  }

  private removeAgentFiles(): void {
    if (this.agentConfigPath) {
      try {
        unlinkSync(this.agentConfigPath);
      } catch {}
      this.agentConfigPath = null;
    }
    if (this.agentRootPath) {
      try {
        rmSync(this.agentRootPath, { recursive: true, force: true });
      } catch {}
      this.agentRootPath = null;
    }
  }

  matchingToolResults(toolResults: ToolResultInfo[]): ToolResultInfo[] {
    return toolResults.filter((tr) => this.findToolCallMatch(tr) !== null);
  }

  private rememberAbandonedToolCall(
    fingerprint: string,
    callId: string,
    toolName: string,
  ): void {
    // Shutdown aborts every pending call at once; recording those would leave
    // stale dedup entries that could suppress a legitimate call if this session
    // object is restarted (e.g. for an effort change).
    if (!this.started) return;
    for (const [key, entry] of this.abandonedToolCalls) {
      if (msSince(entry.abandonedAt) > ABANDONED_CALL_TTL_MS)
        this.abandonedToolCalls.delete(key);
    }
    this.abandonedToolCalls.set(fingerprint, {
      callId,
      toolName,
      abandonedAt: Date.now(),
    });
  }

  /** Drop dedup records once pi's results for those tools have been recovered,
   * so a genuinely new call to the same tool is dispatched again. */
  clearAbandonedToolCalls(toolResults: ToolResultInfo[]): void {
    const recovered = new Set(toolResults.map((tr) => tr.toolName));
    let cleared = 0;
    for (const [key, entry] of this.abandonedToolCalls) {
      if (recovered.has(entry.toolName)) {
        this.abandonedToolCalls.delete(key);
        cleared += 1;
      }
    }
    if (cleared > 0) {
      log("cleared abandoned tool call records", {
        session: this.id,
        cleared,
        remaining: this.abandonedToolCalls.size,
        tools: [...recovered],
      });
    }
  }

  deliverToolResults(
    toolResults: ToolResultInfo[],
    options: { textOnly?: boolean } = {},
  ): void {
    const textOnly = !!options.textOnly;
    for (const tr of toolResults) {
      const match = this.findToolCallMatch(tr);
      if (match) {
        const [callId, call] = match;
        this.pendingToolCalls.delete(callId);
        log("delivering tool result", {
          session: this.id,
          callId,
          toolName: call.toolName,
          resultLen: tr.text.length,
          textOnly,
          ...(textOnly
            ? {}
            : {
                contentBlocks: tr.content?.length ?? 0,
                imageBlocks:
                  tr.content?.filter((block) => block.type === "image")
                    .length ?? 0,
              }),
          roundtripMs: msSince(call.receivedAt),
        });
        call.resolve(
          textOnly
            ? { result: tr.text, isError: tr.isError }
            : { result: tr.text, isError: tr.isError, content: tr.content },
        );
      } else {
        log("UNMATCHED tool result", {
          session: this.id,
          textOnly,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          pendingCalls: [...this.pendingToolCalls.keys()],
        });
      }
    }
  }

  /**
   * Cancel the in-flight session/prompt (if any), wait for it to settle, then
   * start a new prompt on the same ACP session. Used for image follow-ups and
   * for handing an orphaned tool result back after Kiro abandoned its tools/call.
   *
   * Overlapping session/prompt without cancel is rejected by kiro-cli as
   * "Internal error" within ~1ms (measured 2026-08-26). The session stays
   * `busy` during the settle wait so routing cannot fork a parallel process.
   */
  async cancelAndStartFollowUp(
    modelId: string,
    systemPrompt: string,
    followupText: string,
    images: { type: "image"; data: string; mimeType: string }[],
    settleTimeoutMs = 15000,
    beforeStart?: () => void,
    logPrefix = "image FUP",
  ): Promise<void> {
    const prevPromise = this.activePromptDone;
    // Answer whatever tools/call Kiro still holds *before* cancelling. After the
    // cancel its agent is Idle and discards the result ("received a tool execution
    // event for an agent not processing tools"), leaving its conversation with a
    // tool_use that has no tool_result — the state that made the follow-up prompt
    // come back as a contentless `refusal` in 4-20ms.
    const rejected = this.rejectPendingToolCalls(
      `Cancelled old prompt during ${logPrefix} handoff`,
    );
    if (rejected > 0)
      await new Promise<void>((r) => setTimeout(r, TOOL_RESULT_DRAIN_MS));
    if (prevPromise) {
      if (this.acpSessionId) {
        this.rpcNotify("session/cancel", { sessionId: this.acpSessionId });
      }
      log(`${logPrefix}: cancel sent; waiting for old prompt to settle`, {
        session: this.id,
        settleTimeoutMs,
      });
      let settled = false;
      await Promise.race([
        prevPromise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        ),
        new Promise<void>((r) => setTimeout(r, settleTimeoutMs)),
      ]);
      log(`${logPrefix}: old prompt settle wait complete`, {
        session: this.id,
        settled,
      });
      if (!settled) {
        log(`${logPrefix}: old prompt still in flight; follow-up may collide`, {
          session: this.id,
        });
      }
    }
    beforeStart?.();

    log(`${logPrefix}: starting follow-up prompt`, {
      session: this.id,
      imageCount: images.length,
      promptChars: followupText.length,
    });
    await this.startPrompt(modelId, systemPrompt, followupText, images);
    log(`${logPrefix}: follow-up prompt started`, { session: this.id });
  }

  /** Answer every tools/call Kiro still holds. Returns how many were answered. */
  private rejectPendingToolCalls(reason: string): number {
    const calls = [...this.pendingToolCalls.values()];
    if (calls.length === 0) return 0;
    this.pendingToolCalls.clear();
    log("rejecting pending tool calls", {
      session: this.id,
      reason,
      count: calls.length,
      callIds: calls.map((call) => call.callId),
    });
    for (const call of calls) call.resolve({ result: reason, isError: true });
    return calls.length;
  }

  private findToolCallMatch(
    tr: ToolResultInfo,
  ): [string, PendingToolCall] | null {
    const exact = this.pendingToolCalls.get(tr.toolCallId);
    if (exact) return [tr.toolCallId, exact];
    if (!tr.toolCallId.startsWith(this.id + "-")) {
      log("findToolCallMatch: rejecting name-match (foreign toolCallId)", {
        session: this.id,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
      });
      return null;
    }
    // Only a call pi was actually told about can be the origin of a pi result.
    // Without this, a result whose own call was abandoned would name-match an
    // unrelated pending call — observed delivering one subagent's report into a
    // different, still-open request.
    const nameMatches = [...this.pendingToolCalls.entries()].filter(
      ([, call]) => call.toolName === tr.toolName && call.emitted,
    );
    if (nameMatches.length > 1)
      log("ambiguous tool name match", {
        session: this.id,
        toolName: tr.toolName,
        matchCount: nameMatches.length,
        callIds: nameMatches.map(([id]) => id),
      });
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  private async startBridge(): Promise<void> {
    this.toolBridge = await startToolBridge({
      catalog: () => this.currentCatalog(),
      onToolCall: (call) => this.handleBridgeToolCall(call),
      onDebug: (message, data) => log(message, { session: this.id, ...data }),
    });
  }

  private currentCatalog(): ForwardedToolCatalog {
    if (!this.catalogProvider)
      throw new Error("kiro-acp: catalog provider not set");
    return this.catalogProvider();
  }

  private mcpServersConfig(): Array<{
    type: "http";
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  }> {
    if (!this.toolBridge) return [];
    return [
      {
        type: "http",
        name: "pi_host",
        url: this.toolBridge.url,
        headers: [
          { name: "Authorization", value: `Bearer ${this.toolBridge.token}` },
        ],
      },
    ];
  }

  /** Bridge an MCP tools/call from Kiro into Pi's outer tool turn using the
   * existing pending-call machinery, then map Pi's result back to MCP. The
   * bridge serializes calls (one in-flight), so at most one pending per turn. */
  private handleBridgeToolCall(
    call: ToolBridgeCall,
  ): Promise<ToolBridgeResult> {
    const publicCallId = `${this.id}-${++this.bridgeCallSeq}`;
    const receivedAt = Date.now();
    const fingerprint = callFingerprint(call.piName, call.arguments);
    return new Promise<ToolBridgeResult>((resolveResult) => {
      if (call.signal.aborted) {
        resolveResult(
          errorToolResult("Kiro tool call aborted before dispatch"),
        );
        return;
      }
      // Kiro retries a tools/call it abandoned at its own deadline while pi is
      // still executing the original. Running it twice is what produced the
      // "same subagent launched over and over" loop, so answer the retry
      // immediately instead of dispatching it.
      const abandoned = this.abandonedToolCalls.get(fingerprint);
      if (abandoned) {
        log("bridge tool call DEDUPED (already running)", {
          session: this.id,
          toolName: call.piName,
          abandonedCallId: abandoned.callId,
          abandonedAgoMs: msSince(abandoned.abandonedAt),
        });
        resolveResult(errorToolResult(alreadyRunningNote(call.kiroName)));
        return;
      }
      const onAbort = () => {
        const aborted = this.pendingToolCalls.get(publicCallId);
        if (!aborted) return;
        this.pendingToolCalls.delete(publicCallId);
        // Kiro's MCP client gave up on (or closed) its own tools/call while pi
        // was still executing the tool. Pi will still produce a result, which
        // then has nothing to resolve — routeSession recovers it as a
        // follow-up prompt. Logged because it used to happen silently.
        // Only an *emitted* call is actually running in pi; an unemitted one
        // never reached pi (it missed its turn's batch), so it must stay
        // retryable — claiming "already running" for it would deadlock.
        if (aborted.emitted)
          this.rememberAbandonedToolCall(
            fingerprint,
            publicCallId,
            call.piName,
          );
        log("bridge tool call ABANDONED by kiro", {
          session: this.id,
          callId: publicCallId,
          toolName: call.piName,
          emitted: !!aborted.emitted,
          waitedMs: msSince(receivedAt),
          remainingPending: this.pendingToolCalls.size,
        });
        resolveResult(errorToolResult("Kiro tool call aborted"));
      };
      call.signal.addEventListener("abort", onAbort, { once: true });
      const pending: PendingToolCall = {
        callId: publicCallId,
        rawCallId: String(call.requestId),
        toolName: call.piName,
        args: call.arguments,
        receivedAt,
        resolve: (result) => {
          call.signal.removeEventListener("abort", onAbort);
          resolveResult(toToolBridgeResult(result));
        },
      };
      this.pendingToolCalls.set(publicCallId, pending);
      log("bridge tool call received", {
        session: this.id,
        callId: publicCallId,
        kiroName: call.kiroName,
        toolName: call.piName,
        argsKeys: Object.keys(call.arguments),
        streamAttached: !!this.onToolCallFromBridge,
      });
      if (!this.onToolCallFromBridge && this.toolIntakeClosed) {
        // The pi stream for this turn already closed, so pi can never be told
        // about this call. Leaving it to hang until Kiro's 120s deadline left
        // Kiro's turn holding a tool_use with no tool_result; the recovery
        // prompt sent after the cancel was then rejected outright (contentless
        // `stopReason: "refusal"`, which pi reported as a finished turn — the
        // orchestrator appeared to stop right after its subagent returned).
        // Answer it now, while Kiro is still processing tools and can record
        // the result.
        this.pendingToolCalls.delete(publicCallId);
        // Nothing Kiro produces for the rest of this prompt can reach pi. If it
        // holds no other live pi tool call, end the turn instead of paying for
        // output nobody reads and cancelling it later during recovery. A still
        // open sibling call keeps the turn alive — it can beat Kiro's deadline
        // and be delivered normally.
        const cancellingTurn =
          this.pendingToolCalls.size === 0 &&
          !!this.activePromptDone &&
          !!this.acpSessionId;
        log("bridge tool call STRANDED (no stream attached)", {
          session: this.id,
          callId: publicCallId,
          toolName: call.piName,
          answered: true,
          cancellingTurn,
          remainingPending: this.pendingToolCalls.size,
        });
        pending.resolve({ result: strandedNote(call.kiroName), isError: true });
        if (cancellingTurn)
          this.rpcNotify("session/cancel", { sessionId: this.acpSessionId });
        return;
      }
      if (!this.onToolCallFromBridge) {
        // Between session/prompt and the stream attaching its handler: the call
        // stays queued and the stream flushes it as soon as it attaches.
        log("bridge tool call queued before stream attach", {
          session: this.id,
          callId: publicCallId,
          toolName: call.piName,
        });
      }
      this.onToolCallFromBridge?.(pending);
    });
  }

  private writeAgentCfg(): void {
    const config = {
      name: this.agentName,
      tools: [...NATIVE_KIRO_TOOLS, "@pi_host"],
      allowedTools: [...NATIVE_KIRO_TOOLS, "@pi_host"],
      includeMcpJson: false,
      mcpServers: {},
      prompt:
        "You are a coding assistant. Your identity and standing instructions are defined by the <system_instructions> block when present (typically on the first request of a session, or when instructions change). Continue following those instructions for later turns even if the block is omitted. Use tools proactively. If a tool call fails, retry or try alternatives.",
    };

    this.agentRootPath = join(tmpdir(), "kiro-acp", `agent-root-${this.id}`);
    const agentsDir = join(this.agentRootPath, ".kiro", "agents");
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    this.agentConfigPath = join(agentsDir, `${this.agentName}.json`);
    writeFileSync(this.agentConfigPath, JSON.stringify(config, null, 2));
  }
}

function errorToolResult(text: string): ToolBridgeResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** How long a dedup record survives if pi's result never comes back. */
const ABANDONED_CALL_TTL_MS = 30 * 60 * 1000;

function alreadyRunningNote(kiroName: string): string {
  return (
    `This exact \`${kiroName}\` call is already running. Your earlier call to it exceeded your ` +
    "own MCP tool-call deadline, but pi is still executing it and the result will be delivered " +
    "to you in a follow-up message. Do not call it again and do not start replacement work for " +
    "it — end your turn now and wait for the result."
  );
}

/** Answer for a tools/call that arrived after pi's turn closed. */
function strandedNote(kiroName: string): string {
  return (
    `\`${kiroName}\` was not executed: pi had already closed the turn in which you asked ` +
    "for it, so this call could not be dispatched. Any result you are still waiting for " +
    "will be delivered to you in a follow-up message. Do not call this or any other tool " +
    "again in this turn — end your turn now."
  );
}

/** Identity of a tool call: same tool, same arguments, regardless of key order. */
function callFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): string {
  return `${toolName}\u0000${stableJson(args)}`;
}

function toToolBridgeResult(result: {
  result: string;
  isError?: boolean;
  content?: ToolResultContentBlock[];
}): ToolBridgeResult {
  const content: ToolBridgeContent[] = result.content?.length
    ? result.content.map((block) => ({ ...block }))
    : [{ type: "text", text: result.result }];
  return result.isError ? { content, isError: true } : { content };
}

function hashSystemPrompt(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex");
}
