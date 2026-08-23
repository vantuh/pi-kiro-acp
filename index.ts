import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { discoverKiroModels, KIRO_MODELS, type KiroModelConfig } from "./models.ts";
import { LOG_FILE, log } from "./logging.ts";
import { KIRO_ACP_PROVIDER, normalizeKiroContextOverflow } from "./overflow.ts";
import { stopAllSessions } from "./session-manager.ts";
import { streamKiroAcp } from "./stream.ts";

export default function (pi: ExtensionAPI) {
	log("extension loaded", { pid: process.pid, models: KIRO_MODELS.length, logFile: LOG_FILE });
	registerKiroProvider(pi, KIRO_MODELS);
	void refreshKiroModels(pi);

	pi.on("message_end", (event, ctx) => normalizeKiroContextOverflow(event.message, ctx));

	pi.on("session_shutdown", async (event) => {
		log("session_shutdown", {
			reason: event.reason,
			targetSessionFile: event.targetSessionFile,
		});
		await stopAllSessions();
	});
}

function registerKiroProvider(pi: ExtensionAPI, models: KiroModelConfig[]): void {
	pi.registerProvider(KIRO_ACP_PROVIDER, {
		name: "Kiro ACP",
		baseUrl: "local",
		apiKey: "unused",
		api: "kiro-acp-api" as any,
		models,
		streamSimple: (model, context, options) => streamKiroAcp(pi, model, context, options),
	});
}

async function refreshKiroModels(pi: ExtensionAPI): Promise<void> {
	try {
		const models = await discoverKiroModels();
		registerKiroProvider(pi, models);
		log("dynamic models registered", {
			models: models.length,
			ids: models.map((model) => model.id),
		});
	} catch (error) {
		log("dynamic model discovery failed; using fallback models", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
