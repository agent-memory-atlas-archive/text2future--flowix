import { describe, expect, it, vi } from 'vitest';
import type {
  AgentConversationInstance,
  AgentConversationListPage,
  AgentConversationListQuery,
} from '@platform/tauri/client/agent';
import { loadRecentAgentConversations } from './agent-tasks-recent';

function conversation(instanceId: string, updatedAt: number, notebookId = 'nb-1'): AgentConversationInstance {
  return {
    instanceId,
    agentType: 'codex',
    threadTitle: instanceId,
    threadId: null,
    source: { kind: 'dedicated', notebookId },
    createdAt: updatedAt,
    updatedAt,
  };
}

function page(items: AgentConversationInstance[], hasMore = false): AgentConversationListPage {
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: last ? { updatedAt: last.updatedAt, instanceId: last.instanceId } : null,
  };
}

describe('loadRecentAgentConversations', () => {
  it('loads up to the five newest conversations regardless of date', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValue(page([
        conversation('newest', 300),
        conversation('middle', 200),
        conversation('third', 100),
      ], true));

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['newest', 'middle', 'third']);
    expect(listPage).toHaveBeenCalledOnce();
    expect(listPage).toHaveBeenCalledWith({ notebookId: 'nb-1', agentType: null, cursor: null }, 5);
  });

  it('keeps older conversations in the result when fewer than five are available', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValue(page([
        conversation('today', 120),
        conversation('older', 99),
        conversation('oldest', 98),
      ], true));

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['today', 'older', 'oldest']);
    expect(listPage).toHaveBeenCalledOnce();
  });

  it('keeps up to five conversations even when none are from today', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValue(page([
        conversation('latest', 99),
        conversation('second', 98),
        conversation('third', 97),
      ], true));

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['latest', 'second', 'third']);
    expect(listPage).toHaveBeenCalledOnce();
  });

  it('continues only when filtered rows leave too few displayable conversations', async () => {
    const synthetic = {
      ...conversation('legacy-ses_1', 300),
      agentType: 'opencode' as const,
      threadId: 'ses_1',
    };
    const first = page([
      synthetic,
      conversation('other-notebook', 250, 'nb-2'),
      conversation('first', 200),
    ], true);
    const second = page([
      conversation('second', 180),
      conversation('third', 160),
      conversation('fourth', 140),
    ], true);
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(listPage).toHaveBeenNthCalledWith(2, {
      notebookId: 'nb-1', agentType: null, cursor: first.nextCursor,
    }, 5);
  });
});
