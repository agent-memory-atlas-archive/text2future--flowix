import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import type { FixedVirtualListItem } from './use-fixed-virtual-list';
import { mergeConversationPage, sortFavoriteConversations, type ConversationPageState } from './conversation-list-pagination';

type ConversationGroupKey = 'today' | 'yesterday' | 'last7Days' | 'earlier';
type ConversationSectionKey = ConversationGroupKey | 'favorites';

export type ConversationListItem = FixedVirtualListItem & (
  | {
      kind: 'heading';
      sectionKey: ConversationSectionKey;
    }
  | {
      kind: 'conversation';
      instance: AgentConversationInstance;
    }
  | {
      kind: 'loading';
    }
  | {
      kind: 'more-error';
    }
);

/** OpenCode history listing previously materialized provider-only sessions as
 * `legacy-ses_...` instances. They have no Flowix-owned conversation and must
 * not be shown alongside real conversation cards. */
export function isSyntheticOpenCodeHistoryInstance(instance: AgentConversationInstance): boolean {
  return instance.agentType === 'opencode'
    && !!instance.threadId
    && instance.instanceId === `legacy-${instance.threadId}`
    && instance.threadId.startsWith('ses_');
}

/** Empty cards and recovered placeholder threads are not conversation history. */
export function isStartedConversation(instance: AgentConversationInstance): boolean {
  return !!instance.title.trim() || instance.hasMessages === true;
}

/** Keep backend history even when no corresponding editor card is mounted. */
export function selectVisibleConversations(
  page: ConversationPageState,
  liveInstances: Readonly<Record<string, AgentConversationInstance>>,
  notebookId: string | null,
  tombstones: Readonly<Record<string, true>>,
  startedLiveThreads: Readonly<Record<string, true>> = {},
): AgentConversationInstance[] {
  const belongsToNotebook = (instance: AgentConversationInstance) => !notebookId || instance.source?.notebookId === notebookId;
  const merged = mergeConversationPage(page, Object.values(liveInstances).filter(belongsToNotebook));
  return merged.orderedIdentities
    .map((identity) => merged.itemsByIdentity[identity])
    .filter((instance): instance is AgentConversationInstance => !!instance
      && (isStartedConversation(instance)
        || !!(instance.threadId && startedLiveThreads[instance.threadId]))
      && belongsToNotebook(instance)
      && !isSyntheticOpenCodeHistoryInstance(instance)
      && (!instance.threadId || !tombstones[instance.threadId]));
}

/** Partition once, then flatten sections into virtual rows without changing row geometry. */
export function buildConversationListItems(
  conversations: readonly AgentConversationInstance[],
  favoriteIds: ReadonlySet<string>,
  { isLoadingMore, loadMoreError }: { isLoadingMore: boolean; loadMoreError: boolean },
  now = new Date(),
): ConversationListItem[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const favorites: AgentConversationInstance[] = [];
  const buckets: Record<ConversationGroupKey, AgentConversationInstance[]> = { today: [], yesterday: [], last7Days: [], earlier: [] };
  for (const instance of conversations) {
    if (favoriteIds.has(instance.instanceId)) {
      favorites.push(instance);
      continue;
    }
    const timestamp = instance.updatedAt;
    const group = timestamp >= today ? 'today'
      : timestamp >= today - dayMs ? 'yesterday'
        : timestamp >= today - 7 * dayMs ? 'last7Days' : 'earlier';
    buckets[group].push(instance);
  }
  const conversationSections: { key: ConversationSectionKey; items: AgentConversationInstance[] }[] = [];
  if (favorites.length) conversationSections.push({ key: 'favorites', items: sortFavoriteConversations(favorites) });
  for (const key of ['today', 'yesterday', 'last7Days', 'earlier'] as const) {
    if (buckets[key].length) conversationSections.push({ key, items: buckets[key] });
  }
  const items: ConversationListItem[] = [];
  conversationSections.forEach((group, groupIndex) => {
    items.push({
      kind: 'heading',
      key: `heading:${group.key}`,
      sectionKey: group.key,
      // The heading uses a 24px line height. Keep the 12px section margin
      // and 4px outer flex gap in the virtual item.
      size: 24 + (groupIndex > 0 ? 16 : 0),
    });
    group.items.forEach((instance, itemIndex) => {
      items.push({
        kind: 'conversation',
        key: `conversation:${instance.instanceId}`,
        instance,
        // h-9 row plus the existing gap-0.5 between rows.
        size: 36 + (itemIndex < group.items.length - 1 ? 2 : 0),
      });
    });
  });
  if (isLoadingMore) {
    items.push({ kind: 'loading', key: 'loading-more', size: 36 });
  } else if (loadMoreError) {
    items.push({ kind: 'more-error', key: 'loading-more-error', size: 52 });
  }
  return items;
}
