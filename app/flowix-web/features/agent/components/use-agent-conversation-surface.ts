import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { getAgentType } from '@/lib/agent-types';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { isInitialConversationHistoryLoading } from './agent-conversation-history-loading';
import type { SurfacePresentationUpdate, SurfaceState } from '@features/workspace/model/surface-contract';

/** Domain hydration and display data shared by both workspace hosts. */
export function useAgentConversationSurface(instanceId: string, reportPresentation?: (update: SurfacePresentationUpdate) => void) {
  const { t } = useI18n();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const threadProjection = useAgentSessionStore((state) => (
    instance?.threadId ? state.threadProjections[instance.threadId] : undefined
  ));
  const [loadState, setLoadState] = useState<{
    instanceId: string;
    status: 'loading' | 'not-found' | 'error';
  } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    if (instance) return;

    let cancelled = false;
    setLoadState({ instanceId, status: 'loading' });
    void useAgentSessionStore.getState().hydrateInstance(instanceId)
      .then((restored) => {
        if (!cancelled && !restored) setLoadState({ instanceId, status: 'not-found' });
      })
      .catch(() => {
        if (!cancelled) setLoadState({ instanceId, status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [instance, instanceId, retryCount]);

  const retry = useCallback(() => {
    setLoadState({ instanceId, status: 'loading' });
    setRetryCount((count) => count + 1);
  }, [instanceId]);
  const status = instance ? 'ready' : loadState?.instanceId === instanceId ? loadState.status : 'loading';
  const isInitialHistoryLoading = isInitialConversationHistoryLoading(
    instance?.threadId ?? null,
    threadProjection?.messages.length ?? 0,
    threadProjection?.pagination.initialStatus,
  );
  const title = instance ? getAgentConversationPresentation(instance, t('common.untitled')).title : t('common.untitled');
  const icon = instance ? getAgentType(instance.agentType).icon : undefined;
  useEffect(() => {
    const actions = [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retry }];
    const state: SurfaceState = status === 'ready' && !isInitialHistoryLoading ? { status: 'ready' }
      : status === 'loading' || isInitialHistoryLoading
        ? { status: 'loading', loadingMode: 'blocking', retainContent: true }
        : status === 'not-found' ? { status: 'unavailable', reason: 'missing', message: { key: 'status.agent.conversationNotFound' }, actions }
          : { status: 'error', message: { key: 'status.agent.loadConversationsFailed' }, actions };
    reportPresentation?.({ title, icon, state });
  }, [icon, isInitialHistoryLoading, reportPresentation, retry, status, title]);

  return { instance, status, retry };
}
