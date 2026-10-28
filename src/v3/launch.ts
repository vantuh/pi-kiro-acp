/** Kiro CLI V3 launch, agent-profile and session shapes (verified against
 * 2.35.1; see docs/kiro-v3-acp-probes.md). Pure shapes only — AcpSession owns
 * the branch points that use them, so the v2 path stays untouched. */

/** V3 rejects the v2-only flags (`--agent`, `--model`, `--effort`,
 * `--trust-all-tools`, `--trust-tools`): the agent is selected per session and
 * pi_host is trusted by the profile's permission rules instead. */
export function v3SpawnArgs(): string[] {
  return ['acp', '--agent-engine=v3', '--auth-method=cli'];
}

export interface V3SessionOptions {
  agentName: string;
  /** The real project directory the turn runs in. */
  cwd: string;
  /** Scratch root holding `.kiro/agents/<agentName>.json`. */
  agentRootPath: string;
  mcpServers: unknown;
}

/** V3 resolves agent profiles from the session's directories, not from the
 * process cwd, so the scratch root has to be declared and the profile named. */
export function v3SessionParams(options: V3SessionOptions) {
  return {
    cwd: options.cwd,
    additionalDirectories: [options.agentRootPath],
    mcpServers: options.mcpServers,
    _meta: { kiro: { modeId: options.agentName } },
  };
}

export function v3LoadSessionParams(
  sessionId: string,
  options: V3SessionOptions,
) {
  return { sessionId, ...v3SessionParams(options) };
}

/** V3 skips a profile that lists `allowedTools` without `permissions`, and
 * `excludedTools: ['@builtin']` removes the `tool_load`/`tool_call` meta tools
 * the model needs to reach pi_host — so the v2 profile cannot be reused. */
export function v3AgentProfile(agentName: string, prompt: string) {
  return {
    name: agentName,
    tools: ['@pi_host'],
    includeMcpJson: false,
    mcpServers: {},
    permissions: {
      rules: [
        { capability: 'mcp', match: ['pi_host/*'], effect: 'allow' },
        { capability: 'builtin', effect: 'deny' },
      ],
    },
    prompt,
  };
}
