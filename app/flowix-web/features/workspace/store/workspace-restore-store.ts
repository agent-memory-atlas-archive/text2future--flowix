import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { STORAGE_KEYS } from '@/lib/constants';

interface AgentConversationRestoreState {
  selectedInstanceId: string | null;
  detailOpen: boolean;
}

export type PersistedWorkspaceTarget =
  | { kind: 'memo'; memoId: string }
  | { kind: 'external'; path: string; scopePath: string | null }
  | {
      kind: 'media';
      filePath: string;
      notebookId: string | null;
      notebookPath: string | null;
      resourceKind: 'image' | 'video';
    }
  | { kind: 'agent-conversation'; instanceId: string };

export type WorkspaceRestoreStatus = 'idle' | 'restoring' | 'restored' | 'unavailable';

interface WorkspaceRestoreStore {
  version: 4;
  agentConversation: AgentConversationRestoreState;
  desiredTarget: PersistedWorkspaceTarget | null;
  restoreStatus: WorkspaceRestoreStatus;
  selectAgentConversation: (instanceId: string, detailOpen?: boolean) => void;
  closeAgentConversationDetail: () => void;
  clearAgentConversation: (instanceId?: string) => void;
  setDesiredTarget: (target: PersistedWorkspaceTarget | null) => void;
  setRestoreStatus: (status: WorkspaceRestoreStatus) => void;
}

const EMPTY_AGENT_CONVERSATION_RESTORE: AgentConversationRestoreState = {
  selectedInstanceId: null,
  detailOpen: false,
};

export const useWorkspaceRestoreStore = create<WorkspaceRestoreStore>()(
  persist(
    (set) => ({
      version: 4,
      agentConversation: EMPTY_AGENT_CONVERSATION_RESTORE,
      desiredTarget: null,
      restoreStatus: 'idle',
      selectAgentConversation: (instanceId, detailOpen = true) => {
        const normalized = instanceId.trim();
        if (!normalized) return;
        set({
          agentConversation: {
            selectedInstanceId: normalized,
            detailOpen,
          },
        });
      },
      closeAgentConversationDetail: () => set((state) => ({
        agentConversation: {
          ...state.agentConversation,
          detailOpen: false,
        },
      })),
      clearAgentConversation: (instanceId) => set((state) => {
        if (
          instanceId
          && state.agentConversation.selectedInstanceId !== instanceId
        ) {
          return state;
        }
        const clearsDesiredTarget = state.desiredTarget?.kind === 'agent-conversation'
          && (!instanceId || state.desiredTarget.instanceId === instanceId);
        return {
          agentConversation: EMPTY_AGENT_CONVERSATION_RESTORE,
          ...(clearsDesiredTarget ? { desiredTarget: null } : {}),
        };
      }),
      setDesiredTarget: (desiredTarget) => set({ desiredTarget, restoreStatus: 'restored' }),
      setRestoreStatus: (restoreStatus) => set({ restoreStatus }),
    }),
    {
      name: STORAGE_KEYS.WORKSPACE_RESTORE,
      partialize: (state) => ({
        version: state.version,
        agentConversation: state.agentConversation,
        desiredTarget: state.desiredTarget,
      }),
      version: 4,
      migrate: (persisted, version) => {
        const state = persisted as (Partial<WorkspaceRestoreStore> & {
          externalDocument?: { path: string; scopePath: string | null } | null;
        }) | undefined;
        const legacyAgent = state?.agentConversation ?? EMPTY_AGENT_CONVERSATION_RESTORE;
        const desiredTarget = version < 3
          ? state?.externalDocument?.path
            ? {
                kind: 'external' as const,
                path: state.externalDocument.path,
                scopePath: state.externalDocument.scopePath ?? null,
              }
            : legacyAgent.detailOpen && legacyAgent.selectedInstanceId
              ? { kind: 'agent-conversation' as const, instanceId: legacyAgent.selectedInstanceId }
              : null
          : state?.desiredTarget ?? null;
        return {
          ...state,
          version: 4 as const,
          agentConversation: legacyAgent,
          desiredTarget,
          restoreStatus: 'idle' as const,
        };
      },
    },
  ),
);
