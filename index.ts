import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { KIRO_MODELS } from "./models.ts";
import { log } from "./logging.ts";
import { stopAllSessions } from "./session-manager.ts";
import { streamKiroAcp } from "./stream.ts";

const REGISTERED_SYMBOL = Symbol.for("kiro-acp:registered");

export default function (pi: ExtensionAPI) {
  if ((globalThis as any)[REGISTERED_SYMBOL]) {
    log("extension skipped (subagent context)", { pid: process.pid });
    return;
  }
  (globalThis as any)[REGISTERED_SYMBOL] = true;

  log("extension loaded", { pid: process.pid, models: KIRO_MODELS.length });
  pi.registerProvider("kiro-acp", {
    name: "Kiro ACP",
    baseUrl: "local",
    apiKey: "KIRO_ACP_DUMMY",
    api: "kiro-acp-api" as any,
    models: KIRO_MODELS,
    streamSimple: streamKiroAcp,
  });

  pi.on("session_shutdown", async () => {
    await stopAllSessions();
  });
}
