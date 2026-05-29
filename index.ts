import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { KIRO_MODELS } from "./models.ts";
import { log } from "./logging.ts";
import { KIRO_ACP_PROVIDER, normalizeKiroContextOverflow } from "./overflow.ts";
import { stopAllSessions } from "./session-manager.ts";
import { streamKiroAcp } from "./stream.ts";

export default function (pi: ExtensionAPI) {
	log("extension loaded", { pid: process.pid, models: KIRO_MODELS.length });
	pi.registerProvider(KIRO_ACP_PROVIDER, {
		name: "Kiro ACP",
		baseUrl: "local",
		apiKey: "unused",
		api: "kiro-acp-api" as any,
		models: KIRO_MODELS,
		streamSimple: streamKiroAcp,
	});

	pi.on("message_end", (event, ctx) => normalizeKiroContextOverflow(event.message, ctx));

	pi.on("session_shutdown", async (event) => {
		log("session_shutdown", {
			reason: event.reason,
			targetSessionFile: event.targetSessionFile,
		});
		await stopAllSessions();
	});
}
