import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { KIRO_MODELS } from "./models.ts";
import { log } from "./logging.ts";
import { stopAllSessions } from "./session-manager.ts";
import { streamKiroAcp } from "./stream.ts";

export default function (pi: ExtensionAPI) {
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
		log("session_shutdown event received");
		await stopAllSessions();
	});
}
