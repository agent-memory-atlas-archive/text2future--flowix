'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentConversationCursor } from '@platform/tauri/client/agent';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { agentClient } from '@features/agent/store/agent-client';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';
import { selectAndOpenAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { showAgentConversationsView } from '@features/memo/public/shell-api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

function isSyntheticOpenCodeHistoryInstance(instance: AgentConversationInstance): boolean {
  return instance.agentType === 'opencode'
    && !!instance.threadId
    && instance.instanceId === `legacy-${instance.threadId}`
    && instance.threadId.startsWith('ses_');
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function AgentTasksSection({
  notebookId,
  edgeGutter = 6,
  order,
  onHeightChange,
  sectionActions,
}: {
  notebookId: string;
  edgeGutter?: number;
  order: number;
  onHeightChange: (height: number) => void;
  sectionActions?: ReactNode;
}) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [storedConversations, setStoredConversations] = useState<AgentConversationInstance[]>([]);
  const [todayStart, setTodayStart] = useState(startOfToday);
  const lifecycleVersion = useAgentSessionStore((state) => state.lifecycleVersion);
  const liveInstances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const activeConversationInstanceId = useWorkColumnStore((state) => (
    state.navigation.target.kind === 'agent-conversation'
      ? state.navigation.target.instanceId
      : null
  ));

  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const timeout = window.setTimeout(() => setTodayStart(startOfToday()), nextMidnight - Date.now() + 50);
    return () => window.clearTimeout(timeout);
  }, [todayStart]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const all: AgentConversationInstance[] = [];
      let cursor: AgentConversationCursor | null = null;
      try {
        while (active) {
          const page = await agentClient.listConversationInstancesPage(
            { notebookId, agentType: null, cursor },
            PAGE_SIZE,
          );
          const pageItems = page.items.map(normalizeBackendInstance);
          all.push(...pageItems.filter((instance) => instance.source.notebookId === notebookId));
          const oldest = pageItems.at(-1);
          if (!page.hasMore || !page.nextCursor || !oldest || oldest.updatedAt < todayStart) break;
          cursor = page.nextCursor;
        }
        if (active) setStoredConversations(all);
      } catch {
        if (active) setStoredConversations(all);
      }
    };
    setStoredConversations([]);
    void load();
    return () => { active = false; };
  }, [lifecycleVersion, notebookId, todayStart]);

  const tasks = useMemo(() => {
    const merged = new Map<string, AgentConversationInstance>();
    for (const instance of storedConversations) merged.set(instance.instanceId, instance);
    for (const instance of Object.values(liveInstances)) {
      if (instance.source.notebookId !== notebookId) continue;
      const existing = merged.get(instance.instanceId);
      if (!existing || instance.updatedAt >= existing.updatedAt) merged.set(instance.instanceId, instance);
    }
    const conversations = [...merged.values()]
      .filter((instance) => !isSyntheticOpenCodeHistoryInstance(instance))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const todays = conversations.filter((instance) => instance.updatedAt >= todayStart);
    return todays.length > 0 ? todays.slice(0, 3) : conversations.slice(0, 2);
  }, [liveInstances, notebookId, storedConversations, todayStart]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const reportHeight = () => onHeightChange(section.getBoundingClientRect().height);
    reportHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(section);
    return () => observer.disconnect();
  }, [onHeightChange]);

  const openConversation = useCallback(async (instance: AgentConversationInstance) => {
    useAgentSessionStore.getState().setConversationRegistry((registry) => ({
      ...registry,
      instances: { ...registry.instances, [instance.instanceId]: instance },
    }));
    if (instance.threadId) {
      useAgentSessionStore.getState().markThreadRead(instance.threadId);
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        activeThreadIds: { ...meta.activeThreadIds, [instance.agentType]: instance.threadId! },
        activeAgentTypeKey: instance.agentType,
      }));
    }
    await selectAndOpenAgentConversation(instance.instanceId);
  }, []);

  const width = `calc(100% - ${edgeGutter * 2}px)`;
  return (
    <section
      ref={sectionRef}
      className="pb-3"
      aria-label={t('memo.fileTree.agentsSectionTitle')}
      data-notebook-agent-section="true"
      style={{ order }}
    >
      <div
        className="notebook-file-tree__section-header group mb-0.5 flex h-7 items-center rounded-lg px-1.5 transition-colors hover:bg-[var(--muted)]"
        style={{ marginLeft: edgeGutter, width }}
      >
        <button
          type="button"
          className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
          aria-label={t(collapsed ? 'memo.fileTree.expandAgents' : 'memo.fileTree.collapseAgents')}
          title={t(collapsed ? 'memo.fileTree.expandAgents' : 'memo.fileTree.collapseAgents')}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>{t('memo.fileTree.agentsSectionTitle')}</span>
          <ChevronRight className={`h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100 ${!collapsed ? 'rotate-90' : ''}`} />
        </button>
        <div className="ml-auto flex items-center">
          {sectionActions}
        </div>
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {tasks.map((instance) => (
            <button
              key={instance.instanceId}
              type="button"
              title={instance.title?.trim() || t('common.untitled')}
              onClick={() => { void openConversation(instance); }}
              className={cn(
                'group flex h-8 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm transition-colors hover:bg-[var(--muted)]',
                activeConversationInstanceId === instance.instanceId && 'bg-[var(--muted)] font-medium',
              )}
              style={{ marginLeft: edgeGutter, width }}
            >
              <AgentIcon typeKey={instance.agentType} alt="" className="h-4 w-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">
                {instance.title?.trim() || t('common.untitled')}
              </span>
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <button
          type="button"
          onClick={showAgentConversationsView}
          className="flex h-7 items-center rounded-lg px-1.5 text-left text-xs text-[color-mix(in_oklch,var(--muted-foreground)_67%,var(--background))] transition-colors hover:text-[var(--foreground)]"
          style={{ marginLeft: edgeGutter, width }}
        >
          {t('memo.fileTree.moreAgents')}
        </button>
      )}
    </section>
  );
}
