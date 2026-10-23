import type { AgentTypeKey } from '@/types/agent';
import type { ChatMessage } from '@/types';
import { getAgentType } from '@/lib/agent-types';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  isLocalExternalThreadId,
  resolveExternalSessionId,
} from '@features/agent/services/external-agent-runtime-service';
import { isMissingAgentSessionError } from '@features/agent/services/history-error';

export interface LoadAgentThreadCardCacheInput {
  threadId: string;
  typeKey: AgentTypeKey;
}

export interface LoadAgentThreadCardCacheResult {
  resolvedSessionId: string | null;
  loadedThreadId: string | null;
  messages: ChatMessage[];
}

const inFlightThreadLoads = new Map<string, Promise<LoadAgentThreadCardCacheResult>>();

async function loadThreadMessages(typeKey: AgentTypeKey, threadId: string): Promise<ChatMessage[]> {
  const result = await useAgentSessionStore.getState().loadMessages(typeKey, threadId);
  if (result !== "ready") throw new Error(`Thread history load ${result}`);
  return useAgentSessionStore.getState().threadProjections[threadId]?.messages ?? [];
}

/** Coalesce session resolution and history loading across views of one thread. */
export function loadAgentThreadCardCache(
  input: LoadAgentThreadCardCacheInput,
): Promise<LoadAgentThreadCardCacheResult> {
  const key = JSON.stringify([input.typeKey, input.threadId]);
  const existing = inFlightThreadLoads.get(key);
  if (existing) return existing;
  const load = readThreadHistory(input).catch(async (error) => {
    if (!isMissingAgentSessionError(error)) throw error;
    const recovered = await useAgentSessionStore.getState()
      .recoverThreadCardAfterMissingSession(input.threadId);
    if (!recovered) throw error;
    return {
      resolvedSessionId: null,
      loadedThreadId: recovered.threadId,
      messages: [],
    };
  }).finally(() => {
    if (inFlightThreadLoads.get(key) === load) inFlightThreadLoads.delete(key);
  });
  inFlightThreadLoads.set(key, load);
  return load;
}

async function readThreadHistory(input: LoadAgentThreadCardCacheInput): Promise<LoadAgentThreadCardCacheResult> {
  const { threadId, typeKey } = input;
  const type = getAgentType(typeKey);

  if (type.capabilities.externalSessionBacked) {
    const isLocalThreadId = isLocalExternalThreadId(threadId, typeKey);
    const sessionId = isLocalThreadId
      ? await resolveExternalSessionId(threadId, typeKey)
      : threadId;

    if (isLocalThreadId && sessionId && sessionId !== threadId) {
      // Bind first so history and its opaque cursor are created under the
      // product thread id. Native projections must never be copied into it.
      useAgentSessionStore.getState().bindProviderSessionId(threadId, sessionId, typeKey);
      const messages = await loadThreadMessages(typeKey, threadId);
      return { resolvedSessionId: sessionId, loadedThreadId: threadId, messages };
    }

    if (sessionId) {
      const messages = await loadThreadMessages(typeKey, sessionId);
      return { resolvedSessionId: null, loadedThreadId: sessionId, messages };
    }

    // No provider session means this local thread is a known-empty
    // conversation. Publish completion so the detail surface can leave its
    // blocking history-loading state. Never replace live messages or runs.
    const store = useAgentSessionStore.getState();
    store.updateThreadHistory(threadId, (projection) => {
      if (projection.messages.length || projection.runs.isLoading || projection.runs.activeRunId) {
        return projection;
      }
      return {
        ...projection,
        pagination: {
          ...projection.pagination,
          initialStatus: 'ready',
          initialError: null,
          loadingInitial: false,
        },
      };
    });
    return { resolvedSessionId: null, loadedThreadId: null, messages: [] };
  }

  const messages = await loadThreadMessages(typeKey, threadId);
  return { resolvedSessionId: null, loadedThreadId: threadId, messages };
}
