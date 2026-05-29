import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const KIRO_ACP_PROVIDER = "kiro-acp";

/** Kiro/ACP context-limit errors — avoid rate-limit / throttle phrases. */
const KIRO_CONTEXT_OVERFLOW_PATTERN =
	/(context\s*(window|length|limit)|maximum\s+(allowed\s+)?input|input\s+(is\s+)?too\s+long|prompt\s+is\s+too\s+long|exceeds?\s+(the\s+)?(max(imum)?\s+)?(context|token|length)|token\s+limit|too\s+many\s+tokens)/i;

const RATE_LIMIT_PATTERN = /rate\s*limit|too\s+many\s+requests|throttl/i;

type AssistantErrorMessage = {
	role: string;
	stopReason?: string;
	provider?: string;
	errorMessage?: string;
};

export function normalizeKiroContextOverflow(
	message: AssistantErrorMessage,
	ctx: ExtensionContext,
): { message: AssistantErrorMessage } | undefined {
	if (message.role !== "assistant") return;
	if (message.stopReason !== "error") return;
	if (
		message.provider !== KIRO_ACP_PROVIDER &&
		ctx.model?.provider !== KIRO_ACP_PROVIDER
	) {
		return;
	}

	const errorMessage = message.errorMessage ?? "";
	if (errorMessage.includes("context_length_exceeded")) return;
	if (RATE_LIMIT_PATTERN.test(errorMessage)) return;
	if (!KIRO_CONTEXT_OVERFLOW_PATTERN.test(errorMessage)) return;

	return {
		message: {
			...message,
			errorMessage: `context_length_exceeded: ${errorMessage}`,
		},
	};
}
