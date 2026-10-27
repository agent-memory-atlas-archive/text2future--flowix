import { isSyntheticOpenCodeHistoryInstance, isStartedConversation } from './conversation-list-model';
import { EMPTY_CONVERSATION_PAGE_STATE, mergeConversationPage } from './conversation-list-pagination';
export { isSyntheticOpenCodeHistoryInstance } from './conversation-list-model';
import type {
  AgentConversationInstance as BackendConversationInstance,
  AgentConversationCursor,
  AgentConversationListPage,
  AgentConversationListQuery,
} from '@platform/tauri/client/agent';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';

export const RECENT_CONVERSATIONS_LIMIT = 6;

type ListPage = (
  query: AgentConversationListQuery,
  limit: number,
) => Promise<AgentConversationListPage>;
type GetConversations = (notebookId: string, instanceIds: string[]) => Promise<BackendConversationInstance[]>;

/** Load saved favorites directly by instance id so older favorites are not
 * lost behind the recent-conversation page window. */
export async function loadFavoriteAgentConversations(
  notebookId: string,
  favoriteIds: ReadonlySet<string>,
  getConversations: GetConversations,
): Promise<AgentConversationInstance[]> {
  if (favoriteIds.size === 0) return [];
  const instances = await getConversations(notebookId, [...favoriteIds]);
  return instances.map(normalizeBackendInstance).filter((instance) => (
    instance.source.notebookId === notebookId && isStartedConversation(instance) && !isSyntheticOpenCodeHistoryInstance(instance)
  ));
}

/** Pages are ordered newest first by the backend; only fetch rows this section can show. */
export async function loadRecentAgentConversations(
  notebookId: string,
  listPage: ListPage,
  isActive: () => boolean = () => true,
  onHasMoreChange?: (hasMore: boolean) => void,
  limit = RECENT_CONVERSATIONS_LIMIT,
): Promise<AgentConversationInstance[]> {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  let snapshot = EMPTY_CONVERSATION_PAGE_STATE;
  let recent: AgentConversationInstance[] = [];
  let cursor: AgentConversationCursor | null = null;

  while (isActive()) {
    let page: AgentConversationListPage;
    try {
      page = await listPage({ notebookId, agentType: null, cursor }, safeLimit);
    } catch {
      break; // Keep any already loaded rows when a later page fails.
    }
    if (!isActive()) break;

    for (const raw of page.items) {
      const instance = normalizeBackendInstance(raw);
      if (instance.source.notebookId !== notebookId || !isStartedConversation(instance) || isSyntheticOpenCodeHistoryInstance(instance)) continue;

      snapshot = mergeConversationPage(snapshot, [instance]);
      recent = snapshot.orderedIdentities.map((id) => snapshot.itemsByIdentity[id]);
      if (recent.length > safeLimit) {
        onHasMoreChange?.(true);
        return recent.slice(0, safeLimit);
      }
    }

    if (!page.hasMore || !page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }

  onHasMoreChange?.(false);
  return recent.slice(0, safeLimit);
}
