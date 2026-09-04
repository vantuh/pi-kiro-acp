import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { log } from "./logging.ts";
import { stableValue } from "./helpers.ts";
import {
  KIRO_TOOL_FRAME_PREFIX,
  isNativeToolTextFrameLine,
  stripNativeToolFrames,
} from "./native-tool-frame.ts";

const APP_DIR = "pi-kiro-acp";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PersistedKiroSession {
  version: 1;
  kiroSessionId: string;
  historyFingerprint: string;
  modelId?: string | null;
  createdAt: number;
  lastUsed: number;
}

export function persistenceKeyForSession(
  piSessionId: string,
  cwd: string,
): string {
  const cwdHash = hashText(cwd).slice(0, 12);
  return `${cwdHash}/${sanitizePathPart(piSessionId)}`;
}

export function loadPersistedKiroSession(
  key: string,
): PersistedKiroSession | null {
  try {
    const raw = readFileSync(sessionPath(key), "utf-8");
    const parsed = JSON.parse(raw) as PersistedKiroSession;
    if (parsed.version !== 1) return null;
    if (!parsed.kiroSessionId || typeof parsed.kiroSessionId !== "string")
      return null;
    if (
      !parsed.historyFingerprint ||
      typeof parsed.historyFingerprint !== "string"
    )
      return null;
    if (Date.now() - parsed.lastUsed > SESSION_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePersistedKiroSession(
  key: string,
  session: PersistedKiroSession,
): void {
  try {
    const filePath = sessionPath(key);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(session, null, 2), { mode: 0o600 });
    renameSync(tmpPath, filePath);
    log("persisted kiro session", {
      key,
      kiroSessionId: session.kiroSessionId,
      modelId: session.modelId,
    });
  } catch (error) {
    log("failed to persist kiro session", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function clearPersistedKiroSession(key: string): void {
  try {
    unlinkSync(sessionPath(key));
    log("cleared persisted kiro session", { key });
  } catch {
    // Missing or unreadable persistence is fine.
  }
}

export function historyFingerprintBeforeCurrentUser(context: Context): string {
  const messages = context.messages || [];
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  return fingerprintMessages(
    lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : messages,
  );
}

export function historyFingerprintAfterAssistantTurn(
  context: Context,
  assistant: AssistantMessage,
): string {
  return fingerprintMessages([...(context.messages || []), assistant] as Array<
    Context["messages"][number] | AssistantMessage
  >);
}

function sessionPath(key: string): string {
  return join(dataHome(), APP_DIR, "sessions", key + ".json");
}

function dataHome(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return process.env.LOCALAPPDATA;
  return join(homedir(), ".local", "share");
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return sanitized || hashText(value).slice(0, 16);
}

function fingerprintMessages(
  messages: Array<Context["messages"][number] | AssistantMessage>,
): string {
  return hashText(JSON.stringify(messages.map(normalizeMessage)));
}

function normalizeMessage(
  message: Context["messages"][number] | AssistantMessage,
): unknown {
  const role = (message as any).role;
  if (role === "toolResult") {
    return {
      role,
      toolName: (message as any).toolName,
      isError: !!(message as any).isError,
      content: normalizeContent((message as any).content),
    };
  }
  return {
    role,
    content: normalizeContent((message as any).content),
  };
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? null : String(content);
  return content
    .map((block: any) => {
      if (block?.type === "thinking") return null;
      if (block?.type === "text") {
        const raw = block.text || "";
        if (isNativeToolTextFrameLine(raw)) return null;
        const text = raw.includes(KIRO_TOOL_FRAME_PREFIX)
          ? stripNativeToolFrames(raw)
          : raw;
        return text ? { type: "text", text } : null;
      }
      if (block?.type === "toolCall")
        return {
          type: "toolCall",
          name: block.name,
          arguments: stableValue(block.arguments),
        };
      if (block?.type === "image")
        return {
          type: "image",
          mimeType: block.mimeType,
          dataHash: hashText(String(block.data || "")).slice(0, 16),
        };
      return stableValue(block);
    })
    .filter((block) => block !== null);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
