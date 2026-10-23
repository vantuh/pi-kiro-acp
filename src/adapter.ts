import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { loadKiroAcpConfig, resolveUsageFooterConfig } from './config.ts';
import { LOG_FILE, log } from './logging.ts';
import { stripAssistantContentFrames } from './native-tool-frame.ts';
import { KIRO_ACP_PROVIDER, normalizeKiroContextOverflow } from './overflow.ts';
import { createKiroAcpProvider, type KiroAcpProvider } from './provider.ts';
import { sessionRuntimeRegistry } from './session-runtime-registry.ts';
import { getKiroUsage, type KiroUsage } from './usage.ts';

type UiGetter = () => ExtensionContext['ui'] | undefined;

export default function (pi: ExtensionAPI) {
  const refreshController = new AbortController();
  const provider = createKiroAcpProvider({
    resolveSessionManager: (sessionId) =>
      sessionRuntimeRegistry.resolve(sessionId).sessionManager,
  });
  const runtime = { sessionManager: provider.sessionManager };
  let registeredSessionId: string | undefined;
  log('extension loaded', {
    pid: process.pid,
    models: provider.getModels().length,
    logFile: LOG_FILE,
  });

  // Capture the mode's UI surface so the usage footer can drive the transient
  // status slot (the streaming provider only gets model/context/options).
  let latestUi: ExtensionContext['ui'] | undefined;
  const grabUi = (_event: unknown, ctx: { ui?: ExtensionContext['ui'] }) => {
    if (ctx.ui) latestUi = ctx.ui;
  };
  // session_start fires before the first turn; subscribing here too keeps the
  // usage footer working from the very start of a session (the footer needs
  // `ui` captured as early as possible).
  pi.on('session_start', grabUi);
  pi.on('session_start', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (registeredSessionId && registeredSessionId !== sessionId) {
      sessionRuntimeRegistry.unregister(registeredSessionId, runtime);
    }
    registeredSessionId = sessionId;
    sessionRuntimeRegistry.register(sessionId, runtime);
  });
  pi.on('turn_start', grabUi);
  pi.on('message_start', grabUi);
  const getUi: UiGetter = () => latestUi;

  pi.registerProvider(provider);
  void refreshKiroModels(pi, provider, refreshController.signal);

  // Kiro plan usage in the footer (via kiro-cli /usage). Shown only while a
  // kiro-acp model is active; toggle + poll interval live in
  // ~/.pi/agent/kiro-acp.json (defaults: off, poll every 10 minutes).
  // /kiro-usage forces a refresh.
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  // Guards against an in-flight kiro-cli fetch re-adding the status after the
  // user switched away from a kiro-acp model while the fetch was running.
  let usageFooterActive = false;

  const getTheme = () => {
    try {
      return getUi()?.theme;
    } catch {
      return undefined;
    }
  };

  const refreshKiroUsageStatus = async () => {
    const ui = getUi();
    if (!ui) return;
    try {
      const usage = await getKiroUsage();
      if (!usageFooterActive) return;
      ui.setStatus('kiro', kiroUsageStatusText(usage, getTheme()));
    } catch (error) {
      log('usage status refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clearKiroUsageStatus = () => {
    usageFooterActive = false;
    clearInterval(usageTimer);
    usageTimer = undefined;
    getUi()?.setStatus('kiro', undefined);
  };

  const syncKiroUsageFooter = (model: { provider?: string } | undefined) => {
    const config = resolveUsageFooterConfig(loadKiroAcpConfig());
    if (!config.enabled || model?.provider !== KIRO_ACP_PROVIDER) {
      clearKiroUsageStatus();
      return;
    }
    clearInterval(usageTimer);
    usageFooterActive = true;
    void refreshKiroUsageStatus();
    usageTimer = setInterval(() => {
      void refreshKiroUsageStatus();
    }, config.pollMinutes * 60_000);
  };

  pi.on('session_start', (_event, ctx) => syncKiroUsageFooter(ctx.model));
  pi.on('model_select', (event) => syncKiroUsageFooter(event.model));

  pi.registerCommand('kiro-usage', {
    description: 'Refresh Kiro plan usage shown in the footer',
    handler: async (_args, ctx) => {
      try {
        const usage = await getKiroUsage();
        if (usageFooterActive) {
          ctx.ui.setStatus('kiro', kiroUsageStatusText(usage, getTheme()));
        }
        ctx.ui.notify(
          `Kiro ${usage.plan}: ${usage.credits || `${usage.percent}% used`}, resets ${usage.resetDate}`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(
          `Kiro usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        );
      }
    },
  });

  pi.on('session_shutdown', () => {
    usageFooterActive = false;
    clearInterval(usageTimer);
  });

  // Legacy native-tool frames (see native-tool-frame.ts) are normal text
  // blocks so hide-thinking did not hide them. Remove those display-only
  // blocks from the copy sent to the model.
  pi.on('context', (event) => {
    let changed = false;
    for (const message of event.messages as any[]) {
      if (message.role !== 'assistant' || !Array.isArray(message.content))
        continue;
      const stripped = stripAssistantContentFrames(message.content);
      if (!stripped.changed) continue;
      changed = true;
      message.content = stripped.content;
    }
    return changed ? { messages: event.messages } : undefined;
  });

  pi.on('message_end', (event, ctx) =>
    normalizeKiroContextOverflow(event.message, ctx),
  );

  pi.on('session_shutdown', async (event) => {
    refreshController.abort();
    if (registeredSessionId) {
      sessionRuntimeRegistry.unregister(registeredSessionId, runtime);
      registeredSessionId = undefined;
    }
    log('session_shutdown', {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
    });
    // Reusable host shutdown: /new, /resume, and /fork reuse this extension
    // instance and fire session_start again.
    await provider.sessionManager.stopAllSessions();
  });
}

function kiroUsageStatusText(usage: KiroUsage, theme?: any): string {
  const pct = Math.round(usage.percent);
  const text = `Kiro ${pct}% · resets ${usage.resetDate.slice(5)}`;
  if (!theme) return text;
  // "muted" (gray) — distinct from tokens-per-second's accent/dim; escalation
  // colors kick in as the plan runs out.
  try {
    return theme.fg(
      pct >= 80 ? 'error' : pct >= 60 ? 'warning' : 'muted',
      text,
    );
  } catch {
    return text;
  }
}

async function refreshKiroModels(
  pi: ExtensionAPI,
  provider: KiroAcpProvider,
  signal: AbortSignal,
): Promise<void> {
  try {
    await provider.refreshModels!({
      allowNetwork: true,
      force: true,
      signal,
      publish: async ({ update }) => {
        update?.();
        return true;
      },
    });
    if (signal.aborted) return;
    pi.registerProvider(provider);
    log('dynamic models registered', {
      models: provider.getModels().length,
      ids: provider.getModels().map((model) => model.id),
    });
  } catch (error) {
    log('dynamic model discovery failed; using fallback models', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
