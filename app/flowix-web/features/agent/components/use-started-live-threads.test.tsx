import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
vi.mock('@features/agent/store/agent-session-store', () => ({ useAgentSessionStore: vi.fn() }));
import { selectStartedLiveThreads } from './use-started-live-threads';

function instance(id: string, title = ''): AgentConversationInstance {
  return { instanceId: id, agentType: 'codex', title, threadId: id,
    source: { kind: 'dedicated', notebookId: 'nb' }, createdAt: 0, updatedAt: 0 };
}

describe('live conversation visibility subscription', () => {
  it('updates on first message and removal, without rerendering for text chunks or other threads', () => {
    const store = createStore(() => ({
      conversationRegistry: { instances: { untitled: instance('untitled'), named: instance('named', 'Title') } },
      threadProjections: {} as Record<string, { messages: unknown[] }>,
    }));
    let renders = 0;
    let current: Readonly<Record<string, true>> = {};
    function Harness() {
      renders++;
      current = useStore(store, useShallow(selectStartedLiveThreads));
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Harness)));
    expect(current).toEqual({});
    act(() => store.setState({ threadProjections: { untitled: { messages: [{ content: 'A' }] } } }));
    expect(current).toEqual({ untitled: true });
    const beforeChunks = renders;
    const index = current;
    act(() => store.setState({ threadProjections: {
      untitled: { messages: [{ content: 'A longer answer' }] },
      named: { messages: [{ content: 'Already titled' }] },
      unrelated: { messages: [{}] },
    } }));
    expect(renders).toBe(beforeChunks);
    expect(current).toBe(index);
    act(() => store.setState({ threadProjections: {} }));
    expect(current).toEqual({});
    act(() => root.unmount());
    container.remove();
  });

  it('does not subscribe to projections of hydrated or unbound instances', () => {
    expect(selectStartedLiveThreads({
      conversationRegistry: { instances: {
        durable: { ...instance('durable'), hasMessages: true },
        draft: { ...instance('draft'), threadId: null },
      } },
      threadProjections: { durable: { messages: [{}] }, draft: { messages: [{}] } },
    })).toEqual({});
  });
});
