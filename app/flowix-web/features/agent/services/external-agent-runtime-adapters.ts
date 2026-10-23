import { agent } from '@platform/tauri/client';
import type { AgentTypeKey } from '@/types/agent';

export type ExternalAgentTypeKey = Extract<
  AgentTypeKey,
  'codex' | 'claudecode' | 'hermes' | 'opencode' | 'dsh'
>;

export interface ExternalAgentRuntimeAdapter {
  readonly typeKey: ExternalAgentTypeKey;
  createLocalThreadId(instanceId: string, generation?: string): string;
  isLocalThreadId(threadId: string): boolean;
  resolveSessionId(threadId: string): Promise<string | null>;
}

function createPrefixRuntimeAdapter(
  typeKey: ExternalAgentTypeKey,
  resolveSessionId: (threadId: string) => Promise<string | null>,
  legacyPrefixes: readonly string[] = [],
): ExternalAgentRuntimeAdapter {
  return {
    typeKey,
    createLocalThreadId(instanceId, generation) {
      return `${typeKey}-local-${instanceId}${generation ? `-${generation}` : ""}`;
    },
    isLocalThreadId(threadId) {
      return [typeKey, ...legacyPrefixes].some((prefix) =>
        threadId.startsWith(`${prefix}-local-`) ||
        // Legacy local ids created before instance-backed routing.
        threadId.startsWith(`${prefix}-pending-`),
      );
    },
    resolveSessionId,
  };
}

const externalAgentRuntimeAdapters: Record<ExternalAgentTypeKey, ExternalAgentRuntimeAdapter> = {
  codex: createPrefixRuntimeAdapter('codex', (threadId) => agent.getCodexSessionId(threadId)),
  claudecode: createPrefixRuntimeAdapter('claudecode', (threadId) => agent.getClaudeSessionId(threadId), ['claude']),
  hermes: createPrefixRuntimeAdapter('hermes', (threadId) => agent.getHermesSessionId(threadId)),
  opencode: createPrefixRuntimeAdapter('opencode', (threadId) => agent.getOpenCodeSessionId(threadId)),
  dsh: createPrefixRuntimeAdapter(
    'dsh',
    (threadId) => agent.getDeepSeekHarnessSessionId(threadId),
    ['deepseek-harness'],
  ),
};

/** Create a fresh local id after the provider reports that an older session is gone. */
export function createFreshExternalAgentThreadId(
  typeKey: AgentTypeKey,
  instanceId: string,
): string | null {
  const adapter = getExternalAgentRuntimeAdapter(typeKey);
  if (!adapter) return null;
  const generation = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return adapter.createLocalThreadId(instanceId, generation);
}

export function getExternalAgentRuntimeAdapter(
  typeKey: AgentTypeKey
): ExternalAgentRuntimeAdapter | null {
  if (
    typeKey === 'codex' ||
    typeKey === 'claudecode' ||
    typeKey === 'hermes' ||
    typeKey === 'opencode' ||
    typeKey === 'dsh'
  ) {
    return externalAgentRuntimeAdapters[typeKey];
  }
  return null;
}
