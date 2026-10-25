import { create } from 'zustand';
import { agent } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import type { AgentRuntimeSnapshot, AgentTypeKey } from '@/types/agent';

import { createLogger } from '@/lib/logger';
const logger = createLogger('agent-runtime-store');
const RUNTIME_STATUS_TTL_MS = 120_000;

type RuntimeStatusByType = Partial<Record<AgentTypeKey, AgentRuntimeSnapshot>>;

type RuntimeStatusRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RuntimeStatusRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize the current nested protocol and the flat response returned by
 * older desktop hosts. During development the web bundle can hot reload before
 * the Tauri process is restarted, so the IPC boundary must tolerate both.
 */
function normalizeRuntimeStatusReport(report: unknown): RuntimeStatusByType {
  if (!isRecord(report)) return {};
  const source = isRecord(report.agents) ? report.agents : report;
  const aliases: Record<AgentTypeKey, string[]> = {
    pi: ['pi'],
    codex: ['codex'],
    claudecode: ['claudecode', 'claude'],
    opencode: ['opencode'],
    hermes: ['hermes'],
    dsh: ['dsh', 'deepseek-harness', 'deepseek_harness'],
  };
  const result: RuntimeStatusByType = {};

  for (const [agentId, keys] of Object.entries(aliases) as [AgentTypeKey, string[]][]) {
    const value = keys.map((key) => source[key]).find(isRecord);
    if (!value) continue;

    if (
      ['unknown', 'installed', 'missing'].includes(String(value.installation)) &&
      ['unknown', 'ready', 'blocked'].includes(String(value.readiness))
    ) {
      result[agentId] = value as unknown as AgentRuntimeSnapshot;
      continue;
    }

    // Compatibility with the former { available, installed, reason } shape.
    const installed = value.installed === true || value.available === true;
    const details = {
      reasonCode: null,
      reason: typeof value.reason === 'string' ? value.reason : null,
    };
    result[agentId] = installed
      ? { ...details, installation: 'installed', readiness: value.available === false ? 'blocked' : 'ready' }
      : { ...details, installation: 'missing', readiness: 'unknown' };
  }

  return result;
}

let inFlightRefresh: Promise<void> | null = null;
let refreshGeneration = 0;
let dshRuntimeStatusUnsubscribe: (() => void) | null = null;

function ensureDshRuntimeStatusSubscription(): void {
  if (dshRuntimeStatusUnsubscribe) return;
  dshRuntimeStatusUnsubscribe = subscribe('dsh-runtime-status-changed', () => {
    void useAgentRuntimeStore.getState().refresh({ force: true });
  });
}

export interface AgentRuntimeState {
  statusByType: RuntimeStatusByType;
  isChecking: boolean;
  lastCheckedAt: number | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  refreshIfStale: () => Promise<void>;
}

function isFresh(lastCheckedAt: number | null): boolean {
  return lastCheckedAt !== null && Date.now() - lastCheckedAt < RUNTIME_STATUS_TTL_MS;
}

export const useAgentRuntimeStore = create<AgentRuntimeState>((set, get) => ({
  statusByType: {},
  isChecking: false,
  lastCheckedAt: null,

  refresh: async (options) => {
    ensureDshRuntimeStatusSubscription();
    const { force = false } = options ?? {};
    if (!force && isFresh(get().lastCheckedAt)) return;

    if (force) refreshGeneration += 1;
    if (!inFlightRefresh) {
      const refreshTask = (async () => {
        let completedGeneration = -1;
        do {
          const generationAtStart = refreshGeneration;
          set({ isChecking: true });
          let status: RuntimeStatusByType;
          try {
            const report = await agent.runtimeStatus();
            status = normalizeRuntimeStatusReport(report);
          } catch (err) {
            // A force refresh that arrived during this request still needs its
            // own attempt, even when the older request fails.
            if (generationAtStart !== refreshGeneration) continue;
            throw err;
          }
          completedGeneration = generationAtStart;
          set({
            statusByType: status,
            lastCheckedAt: Date.now(),
            isChecking: false,
          });
        } while (completedGeneration !== refreshGeneration);
      })();

      const handledRefreshTask = refreshTask.catch((err) => {
        logger.warn('Failed to refresh runtime status:', err);
        set({ isChecking: false });
      });
      inFlightRefresh = handledRefreshTask;
      try {
        await handledRefreshTask;
      } finally {
        if (inFlightRefresh === handledRefreshTask) inFlightRefresh = null;
      }
      return;
    }

    await inFlightRefresh;
  },

  refreshIfStale: async () => {
    await get().refresh();
  },
}));

// Recover a bad snapshot left in memory by a previously hot-reloaded bundle.
if (!isRecord(useAgentRuntimeStore.getState().statusByType)) {
  useAgentRuntimeStore.setState({ statusByType: {}, lastCheckedAt: null });
}
