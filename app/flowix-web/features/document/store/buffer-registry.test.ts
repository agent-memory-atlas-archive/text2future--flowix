import { describe, expect, it, vi } from 'vitest';

import {
  applyLoadedDocumentContent,
  discardDocumentDraft,
  getActiveDocumentDraft,
  getDocumentBuffer,
  rebaseActiveDocumentPath,
  recordDocumentEdit,
  hasDocumentUnsavedChanges,
  registerDocumentCapture,
  captureLatestDocumentContent,
} from './document-session-service';
import { subscribeDocumentBufferChanges } from './buffer-registry';

describe('document buffer change notifications', () => {
  it('captures only the requested document host when one is provided', () => {
    const identity = { kind: 'md' as const, memoId: 'memo-capture-host', path: '/memo-capture-host.md', displayId: 'display-capture-host' };
    const mainCapture = vi.fn(() => '# main');
    const browserCapture = vi.fn(() => '# browser');
    const unregisterMain = registerDocumentCapture(identity, mainCapture, 'main-third');
    const unregisterBrowser = registerDocumentCapture(identity, browserCapture, 'browser-column');

    try {
      captureLatestDocumentContent(identity, 'main-third');
      expect(mainCapture).toHaveBeenCalledOnce();
      expect(browserCapture).not.toHaveBeenCalled();

      captureLatestDocumentContent(identity);
      expect(mainCapture).toHaveBeenCalledTimes(2);
      expect(browserCapture).toHaveBeenCalledOnce();
    } finally {
      unregisterMain();
      unregisterBrowser();
    }
  });

  it('notifies listeners when a memo is loaded and edited', () => {
    const identity = { kind: 'md' as const, memoId: 'memo-buffer-events', path: '/memo-buffer-events.md', displayId: 'display-buffer-events' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);

    try {
      applyLoadedDocumentContent(identity, '/notes/events.md', 'base content');
      recordDocumentEdit(identity, 'local edit');
    } finally {
      unsubscribe();
    }

    expect(listener).toHaveBeenNthCalledWith(1, identity, 'loaded');
    expect(listener).toHaveBeenNthCalledWith(2, identity, 'edited');
  });

  it('stops notifying after unsubscribe', () => {
    const identity = { kind: 'md' as const, memoId: 'memo-buffer-unsubscribe', path: '/memo-buffer-unsubscribe.md', displayId: 'display-buffer-unsubscribe' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);
    unsubscribe();

    recordDocumentEdit(identity, 'ignored edit');

    expect(listener).not.toHaveBeenCalled();
  });

  it('rebases a renamed memo path without changing the unsaved content baseline', () => {
    const identity = { kind: 'md' as const, memoId: 'memo-path-rebase', path: '/before.md', displayId: 'display-path-rebase' };
    applyLoadedDocumentContent(identity, '/notes/old.md', 'saved body');
    recordDocumentEdit(identity, 'unsaved body');

    rebaseActiveDocumentPath(identity, '/notes/new.md');

    expect(getActiveDocumentDraft()).toMatchObject({ path: '/notes/new.md', content: 'unsaved body' });
    expect(getDocumentBuffer(identity)).toMatchObject({
      content: 'unsaved body',
      pendingContent: 'unsaved body',
      lastSavedContent: 'saved body',
    });
  });

  it('clears the dirty barrier when a missing source is explicitly discarded', () => {
    const identity = { kind: 'md' as const, memoId: 'memo-missing-source', path: '/memo-missing-source.md', displayId: 'display-missing-source' };
    applyLoadedDocumentContent(identity, '/notes/deleted.md', 'saved body');
    recordDocumentEdit(identity, 'unsaved body');

    discardDocumentDraft(identity);

    expect(hasDocumentUnsavedChanges(identity)).toBe(false);
    expect(getDocumentBuffer(identity)).toMatchObject({
      content: 'unsaved body',
      pendingContent: null,
      lastSavedContent: 'unsaved body',
    });
  });
});
