import { describe, expect, it, vi } from 'vitest';
import type {
  AgentConversationInstance,
  AgentConversationListPage,
  AgentConversationListQuery,
} from '@platform/tauri/client/agent';
import { loadFavoriteAgentConversations, loadRecentAgentConversations } from './agent-tasks-recent';

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
  it('skips empty placeholders across pages and preserves untitled message history', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValueOnce(page([
        { ...conversation('empty', 300), threadTitle: '', hasMessages: false },
      ], true))
      .mockResolvedValueOnce(page([
        { ...conversation('untitled', 200), threadTitle: '', hasMessages: true },
      ]));
    expect((await loadRecentAgentConversations('nb-1', listPage)).map((row) => row.instanceId)).toEqual(['untitled']);
    expect(listPage).toHaveBeenCalledTimes(2);
  });

  it('loads up to the ten newest conversations regardless of date', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValue(page([
        conversation('newest', 300),
        conversation('middle', 200),
        conversation('third', 100),
      ]));

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['newest', 'middle', 'third']);
    expect(listPage).toHaveBeenCalledOnce();
    expect(listPage).toHaveBeenCalledWith({ notebookId: 'nb-1', agentType: null, cursor: null }, 10);
  });

  it('keeps older conversations in the result when fewer than ten are available', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValue(page([
        conversation('today', 120),
        conversation('older', 99),
        conversation('oldest', 98),
      ]));

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['today', 'older', 'oldest']);
    expect(listPage).toHaveBeenCalledOnce();
  });

  it('keeps up to ten conversations even when none are from today', async () => {
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValue(page([
        conversation('latest', 99),
        conversation('second', 98),
        conversation('third', 97),
      ]));

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
    ]);
    const listPage = vi.fn<(query: AgentConversationListQuery, limit: number) => Promise<AgentConversationListPage>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const result = await loadRecentAgentConversations('nb-1', listPage);

    expect(result.map((item) => item.instanceId)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(listPage).toHaveBeenNthCalledWith(2, {
      notebookId: 'nb-1', agentType: null, cursor: first.nextCursor,
    }, 10);
  });
  it('stops at ten conversations when more are available', async () => {
    const items = Array.from({ length: 12 }, (_, index) => conversation(`thread-${index}`, 100 - index));
    const listPage = vi.fn().mockResolvedValue(page(items, true));
    const result = await loadRecentAgentConversations('nb-1', listPage);
    expect(result.map((item) => item.instanceId)).toEqual(items.slice(0, 10).map((item) => item.instanceId));
    expect(listPage).toHaveBeenCalledOnce();
  });

});


describe('loadFavoriteAgentConversations', () => {
  it('loads all favorites in one request and keeps only the selected notebook', async () => {
    const getConversations = vi.fn().mockResolvedValue([
      conversation('old-favorite', 1),
      conversation('other-notebook', 2, 'nb-2'),
    ]);
    const ids = new Set(['old-favorite', 'other-notebook']);
    const result = await loadFavoriteAgentConversations('nb-1', ids, getConversations);
    expect(getConversations).toHaveBeenCalledExactlyOnceWith('nb-1', [...ids]);
    expect(result.map((item) => item.instanceId)).toEqual(['old-favorite']);
  });

  it('propagates query failures so the caller can retain the previous snapshot', async () => {
    const error = new Error('database unavailable');
    const getConversations = vi.fn().mockRejectedValue(error);
    await expect(loadFavoriteAgentConversations('nb-1', new Set(['favorite']), getConversations))
      .rejects.toBe(error);
  });

  it('skips the backend when no conversations are favorited', async () => {
    const getConversations = vi.fn();
    expect(await loadFavoriteAgentConversations('nb-1', new Set(), getConversations)).toEqual([]);
    expect(getConversations).not.toHaveBeenCalled();
  });
});
