import type {
  AgentConversationCursor,
  AgentConversationListPage,
  AgentConversationListQuery,
} from '@platform/tauri/client/agent';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';

const RECENT_LIMIT = 5;
const PAGE_SIZE = RECENT_LIMIT;

type ListPage = (
  query: AgentConversationListQuery,
  limit: number,
) => Promise<AgentConversationListPage>;

export function isSyntheticOpenCodeHistoryInstance(instance: AgentConversationInstance): boolean {
  return instance.agentType === 'opencode'
    && !!instance.threadId
    && instance.instanceId === `legacy-${instance.threadId}`
    && instance.threadId.startsWith('ses_');
}

/** Pages are ordered newest first by the backend; only fetch rows this section can show. */
export async function loadRecentAgentConversations(
  notebookId: string,
  listPage: ListPage,
  isActive: () => boolean = () => true,
): Promise<AgentConversationInstance[]> {
  const recent: AgentConversationInstance[] = [];
  let cursor: AgentConversationCursor | null = null;

  while (isActive()) {
    let page: AgentConversationListPage;
    try {
      page = await listPage({ notebookId, agentType: null, cursor }, PAGE_SIZE);
    } catch {
      break; // Keep any already loaded rows when a later page fails.
    }
    if (!isActive()) break;

    for (const raw of page.items) {
      const instance = normalizeBackendInstance(raw);
      if (instance.source.notebookId !== notebookId || isSyntheticOpenCodeHistoryInstance(instance)) continue;

      recent.push(instance);
      if (recent.length >= RECENT_LIMIT) return recent;
    }

    if (!page.hasMore || !page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }

  return recent;
}
