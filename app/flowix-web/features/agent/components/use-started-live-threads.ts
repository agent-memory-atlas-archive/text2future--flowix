import { useShallow } from 'zustand/react/shallow';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

interface ConversationVisibilityState {
  conversationRegistry: { instances: Readonly<Record<string, AgentConversationInstance>> };
  threadProjections: Readonly<Record<string, { messages: readonly unknown[] }>>;
}

/** Only untitled live instances need projection evidence. Text chunks do not
 * change this boolean index, so neither list follows streamed message content. */
export function selectStartedLiveThreads(state: ConversationVisibilityState): Record<string, true> {
  const started: Record<string, true> = {};
  for (const instance of Object.values(state.conversationRegistry.instances)) {
    if (instance.title.trim() || instance.hasMessages || !instance.threadId) continue;
    if (state.threadProjections[instance.threadId]?.messages.length) started[instance.threadId] = true;
  }
  return started;
}

export function useStartedLiveThreads(): Readonly<Record<string, true>> {
  return useAgentSessionStore(useShallow(selectStartedLiveThreads));
}
