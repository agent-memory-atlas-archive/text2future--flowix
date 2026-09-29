import { beforeEach, describe, expect, it } from 'vitest';

import { useDocumentHistoryStore } from '@features/document/store/document-history-store';

describe('document history store', () => {
  beforeEach(() => {
    useDocumentHistoryStore.getState().clear();
  });

  it('keeps agent conversations as navigable history entries', () => {
    const conversation = {
      kind: 'agent-conversation' as const,
      instanceId: 'conversation-1',
      openedAt: 1,
    };
    const memo = {
      kind: 'external' as const,
      scopePath: '/notes',
      path: '/notes/memo-1.md',
      openedAt: 2,
    };

    useDocumentHistoryStore.getState().pushBack(memo);
    useDocumentHistoryStore.getState().commitBackNavigation(conversation);

    expect(useDocumentHistoryStore.getState().peekBack()).toBeNull();
    expect(useDocumentHistoryStore.getState().peekForward()).toEqual(conversation);
  });

  it('does not duplicate the same conversation at the top of a stack', () => {
    const conversation = {
      kind: 'agent-conversation' as const,
      instanceId: 'conversation-1',
      openedAt: 1,
    };

    useDocumentHistoryStore.getState().pushBack(conversation);
    useDocumentHistoryStore.getState().pushBack({ ...conversation, openedAt: 2 });

    expect(useDocumentHistoryStore.getState().backStack).toHaveLength(1);
  });

  it('keeps generated documents distinct by file path', () => {
    const artifact = {
      kind: 'external' as const,
      path: '/notes/map-one.md',
      scopePath: '/notes',
      openedAt: 1,
    };

    useDocumentHistoryStore.getState().pushBack(artifact);
    useDocumentHistoryStore.getState().pushBack({
      ...artifact,
      path: '/notes/map-two.md',
      openedAt: 2,
    });

    expect(useDocumentHistoryStore.getState().backStack).toEqual([artifact, {
      ...artifact,
      path: '/notes/map-two.md',
      openedAt: 2,
    }]);
  });

  it('keeps image and video resources as distinct history entries', () => {
    const image = {
      kind: 'media' as const,
      filePath: '/notes/image.png',
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      resourceKind: 'image' as const,
      openedAt: 1,
    };
    const video = {
      ...image,
      filePath: '/notes/video.mp4',
      resourceKind: 'video' as const,
      openedAt: 2,
    };

    useDocumentHistoryStore.getState().pushBack(image);
    useDocumentHistoryStore.getState().pushBack({ ...image, openedAt: 3 });
    useDocumentHistoryStore.getState().pushBack(video);

    expect(useDocumentHistoryStore.getState().backStack).toEqual([image, video]);
  });
});
