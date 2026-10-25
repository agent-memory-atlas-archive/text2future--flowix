import { ensureAgentWorkspaceReady } from "@features/agent/store/agent-workspace-store";
import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";
import { isLocalExternalThreadId } from "@features/agent/services/external-agent-runtime-service";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  ensureConversationWorkspaceSnapshot,
  markConversationWorkspaceStarted,
} from "@features/agent/runtime/workspace-snapshot";
import { ensureAgentThreadCardThread } from "@features/agent/thread-card/agent-thread-card-submit";
import {
  defaultThreadTitle,
  deriveThreadTitleFromPrompt,
} from "@features/agent/store/thread-titles";

export interface EnsureAgentConversationDetailThreadResult {
  threadId: string;
  title: string;
  runtimeConfig: RuntimeConfig;
}

/** A recovered local id reserves identity without starting a provider session. */
export function needsAgentConversationInitialization(instance: AgentConversationInstance): boolean {
  const threadId = instance.threadId;
  if (!threadId) return true;
  const store = useAgentSessionStore.getState();
  const projection = store.threadProjections[threadId];
  return isLocalExternalThreadId(threadId, instance.agentType)
    && !instance.providerSessionId
    && !store.sessionMeta.externalSessionResolutions[threadId]
    && !projection?.messages.length
    && !projection?.runs.isLoading
    && !projection?.runs.activeRunId;
}

/**
 * Initialize an empty conversation on its first send, reusing a recovered
 * local product id when present, then freeze the workspace snapshot.
 *
 * Mirrors the note-embedded thread card's first-send path, but reads the
 * conversation's own source instead of ProseMirror node attrs:
 * an independent conversation carries only its owning notebook, never a memo
 * or external document.
 */
export async function ensureAgentConversationDetailThread(input: {
  instanceId: string;
  typeKey: AgentTypeKey;
  prompt: string;
  runtimeHandleId: string;
}): Promise<EnsureAgentConversationDetailThreadResult> {
  const session = useAgentSessionStore.getState();
  const instance = session.getInstance(input.instanceId);
  if (!instance) throw new Error("Agent session instance was not found");

  const ensured = instance.threadId ? {
    threadId: instance.threadId,
    title: instance.title || deriveThreadTitleFromPrompt(input.prompt, defaultThreadTitle(input.typeKey)),
    typeKey: input.typeKey,
  } : await ensureAgentThreadCardThread({
    prompt: input.prompt,
    fallbackTitle: defaultThreadTitle(input.typeKey),
    typeKey: input.typeKey,
    currentThreadId: null,
    runtimeHandleId: input.runtimeHandleId,
    instanceId: input.instanceId,
    buildTitle: (prompt, fallback) => deriveThreadTitleFromPrompt(prompt, fallback),
  });
  if (!ensured) throw new Error("Agent thread id was not created");

  // A newly created thread has no history. Publish that known-empty state
  // before binding the instance, so the detail page never treats it as unknown.
  if (!useAgentSessionStore.getState().threadProjections[ensured.threadId]) {
    session.updateThreadHistory(ensured.threadId, (projection) => ({
      ...projection,
      pagination: { ...projection.pagination, initialStatus: "ready" },
    }));
  }

  await session.initializeThread(input.instanceId, {
    agentType: ensured.typeKey,
    title: ensured.title,
    threadId: ensured.threadId,
    source: instance.source,
    runtimeConfig:
      instance.runtimeConfig ?? buildInitialInstanceRuntimeConfig(ensured.typeKey),
  });
  await ensureAgentWorkspaceReady();
  const runtimeConfig = ensureConversationWorkspaceSnapshot(input.instanceId);
  markConversationWorkspaceStarted(input.instanceId);
  return { threadId: ensured.threadId, title: ensured.title, runtimeConfig };
}
