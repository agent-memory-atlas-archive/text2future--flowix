import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useNoteStore } from '@features/memo/store/note-store';
import { isAgentTypeEnabled } from '@features/preferences/public/runtime-api';
import {
  getNewConversationAgentSelection,
  type NewConversationAgentSelection,
} from '@features/agent/runtime/new-conversation-agent-selection';
import type { AgentTypeKey } from '@/types/agent';

/** Refresh status in the background and decide from the latest known snapshot. */
export function requestNewConversationAgentSelection(): NewConversationAgentSelection {
  const runtime = useAgentRuntimeStore.getState();
  void runtime.refreshIfStale();
  return getNewConversationAgentSelection(
    runtime.statusByType,
    runtime.isChecking,
    isAgentTypeEnabled,
  );
}

function createAgentConversationInstance(typeKey: AgentTypeKey, notebookId: string | null) {
  return useAgentSessionStore.getState().createInstance({
    agentType: typeKey,
    title: '',
    threadId: null,
    source: { kind: 'dedicated', notebookId, documentPath: null },
    runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
  });
}

function openAgentConversation(instanceId: string): void {
  void openWorkspaceSurface({
    host: 'main-third',
    target: { kind: 'agent-conversation', instanceId, blankIfMissing: true },
  });
}

/** Create a conversation instance for the browser column's host-specific navigation. */
export function createBrowserColumnAgentConversation(typeKey: AgentTypeKey, notebookId: string): string {
  return createAgentConversationInstance(typeKey, notebookId).instanceId;
}

/** Drop an empty Browser conversation when its navigation is cancelled before mounting. */
export function discardUnopenedBrowserColumnAgentConversation(instanceId: string): void {
  const instance = useAgentSessionStore.getState().conversationRegistry.instances[instanceId];
  if (instance && !instance.threadId) useAgentSessionStore.getState().removeInstance(instanceId);
}

/** Create and open a blank conversation scoped to a notebook. */
export function createAndOpenAgentConversation(typeKey: AgentTypeKey, notebookId: string | null): void {
  const instance = createAgentConversationInstance(typeKey, notebookId);
  openAgentConversation(instance.instanceId);
}

export function createAndOpenPiConversation(): void {
  const notebookId = useNoteStore.getState().selectedNotebook?.id ?? null;
  createAndOpenAgentConversation('pi', notebookId);
}
