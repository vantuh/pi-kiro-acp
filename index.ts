import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverKiroModels, KIRO_MODELS, type KiroModelConfig } from "./models.ts";
import { LOG_FILE, log } from "./logging.ts";
import { KIRO_ACP_PROVIDER, normalizeKiroContextOverflow } from "./overflow.ts";
import { stripAssistantContentFrames } from "./native-tool-frame.ts";
import { createKiroToolFrameTransformer } from "./tool-frame-transformer.ts";
import { stopAllSessions } from "./session-manager.ts";
import { streamKiroAcp } from "./stream.ts";

type UiGetter = () => ExtensionContext["ui"] | undefined;

export default function (pi: ExtensionAPI) {
	log("extension loaded", { pid: process.pid, models: KIRO_MODELS.length, logFile: LOG_FILE });

	// Capture the mode's UI surface so the streaming provider (which only gets
	// model/context/options) can drive the transient working indicator when
	// mirroring Kiro's native tool activity (Phase 4).
	let latestUi: ExtensionContext["ui"] | undefined;
	const grabUi = (_event: unknown, ctx: { ui?: ExtensionContext["ui"] }) => {
		if (ctx.ui) latestUi = ctx.ui;
	};
	// session_start fires before historical thinking is painted; turn_start
	// alone left getUi() empty, so the transformer passed markers through.
	pi.on("session_start", grabUi);
	pi.on("turn_start", grabUi);
	pi.on("message_start", grabUi);
	const getUi: UiGetter = () => latestUi;

	registerKiroProvider(pi, KIRO_MODELS, getUi);
	void refreshKiroModels(pi, getUi);

	// Render mirrored native Kiro tool frames inline, styled like native tool rows.
	pi.registerMarkdownTransformer(
		createKiroToolFrameTransformer(() => {
			try {
				return getUi()?.theme;
			} catch {
				return undefined;
			}
		}),
	);

	// Cards are normal text blocks so hide-thinking does not hide them. Remove
	// those display-only blocks from the copy sent to the model.
	pi.on("context", (event) => {
		let changed = false;
		for (const message of event.messages as any[]) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const stripped = stripAssistantContentFrames(message.content);
			if (!stripped.changed) continue;
			changed = true;
			message.content = stripped.content;
		}
		return changed ? { messages: event.messages } : undefined;
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

function registerKiroProvider(pi: ExtensionAPI, models: KiroModelConfig[], getUi: UiGetter): void {
	pi.registerProvider(KIRO_ACP_PROVIDER, {
		name: "Kiro ACP",
		baseUrl: "local",
		apiKey: "unused",
		api: "kiro-acp-api" as any,
		models,
		streamSimple: (model, context, options) => streamKiroAcp(pi, model, context, options, getUi),
	});
}

async function refreshKiroModels(pi: ExtensionAPI, getUi: UiGetter): Promise<void> {
	try {
		const models = await discoverKiroModels();
		registerKiroProvider(pi, models, getUi);
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
