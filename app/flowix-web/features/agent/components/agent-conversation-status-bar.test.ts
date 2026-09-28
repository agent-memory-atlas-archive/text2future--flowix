import { describe, expect, it } from 'vitest';

import { conversationStatusEntries } from './agent-conversation-status-bar';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

function instance(
  instanceId: string,
  threadId: string,
  updatedAt: number,
): AgentConversationInstance {
  return {
    instanceId,
    agentType: 'codex',
    title: instanceId,
    threadId,
    source: { kind: 'dedicated' },
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('agent conversation status bar entries', () => {
  it('shows running conversations and explicitly unread completed conversations only', () => {
    const active = instance('active', 'thread-active', 10);
    const unread = instance('unread', 'thread-unread', 20);
    const idle = instance('idle', 'thread-idle', 30);

    const entries = conversationStatusEntries(
      { active, unread, idle },
      {
        'thread-active': 'running\u001frun-active\u001f10\u001f-\u001f-\u001f-\u001f0',
        'thread-unread': 'completed\u001frun-unread\u001f20\u001f-\u001f-\u001f-\u001f0',
        'thread-idle': '-',
      },
      new Set(['unread']),
    );

    expect(entries.map(({ instance: item }) => item.instanceId)).toEqual(['active', 'unread']);
    expect(entries[0]?.run.status).toBe('running');
    expect(entries[1]?.run.status).toBe('completed');
  });

  it('only shows conversations from the selected notebook and excludes removed threads', () => {
    const current = { ...instance('current', 'thread-current', 10), source: { kind: 'dedicated' as const, notebookId: 'notebook-a' } };
    const other = { ...instance('other', 'thread-other', 20), source: { kind: 'dedicated' as const, notebookId: 'notebook-b' } };
    const unscoped = instance('unscoped', 'thread-unscoped', 30);
    const removed = { ...instance('removed', 'thread-removed', 40), source: { kind: 'dedicated' as const, notebookId: 'notebook-a' } };
    const entries = conversationStatusEntries(
      { current, other, unscoped, removed },
      Object.fromEntries(['current', 'other', 'unscoped', 'removed'].map((name) => [
        `thread-${name}`, `running\u001frun-${name}\u001f10\u001f-\u001f-\u001f-\u001f0`,
      ])),
      new Set(),
      'notebook-a',
      { 'thread-removed': true },
    );

    expect(entries.map(({ instance: item }) => item.instanceId)).toEqual(['current']);
  });
});
