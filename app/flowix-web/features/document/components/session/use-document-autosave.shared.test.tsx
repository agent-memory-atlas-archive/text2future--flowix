import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentAutosave } from './use-document-autosave';
import { applyLoadedDocumentContent, recordDocumentEdit } from '../../store/document-session-service';
import { subscribeDocumentBufferChanges, getBuffer } from '../../store/buffer-registry';
import { enqueueDocumentCommit } from '../../store/document-commit-queue';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath, reconcileFileDisplays } from '@/lib/file-display-registry';

const save = vi.hoisted(() => vi.fn().mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content })));
vi.mock('../../use-cases/local-document-operations', () => ({ localDocumentOperations: { write: save } }));
vi.mock('../../store/recovery-draft-store', () => ({
  persistRecoveryDraft: vi.fn().mockResolvedValue(true),
  clearRecoveryDraftThrough: vi.fn().mockResolvedValue(undefined),
  flushRecoveryOperations: vi.fn().mockResolvedValue(true),
}));

describe('shared document autosave', () => {
  afterEach(() => { vi.useRealTimers(); save.mockClear(); });

  it('saves the latest shared draft when the outgoing surface timer fires', async () => {
    vi.useFakeTimers();
    const identity = { kind: 'md' as const, path: '/shared-autosave.md', displayId: 'display-shared-autosave' };
    applyLoadedDocumentContent(identity, '/notes/shared.md', '# Base');
    let onChange: ((content: string) => void) | undefined;
    const setState = vi.fn();
    const reloadDocument = vi.fn().mockResolvedValue(undefined);
    function Surface() {
      onChange = useDocumentAutosave({
        identity, filePath: '/notes/shared.md',
        externalScopePath: null, setState, reloadDocument,
      }).handleChange;
      return null;
    }
    const element = document.createElement('div');
    const root = createRoot(element);
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => root.render(<Surface />));
      onChange?.('# Left edit');
      recordDocumentEdit(identity, '# Newer right edit');
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ content: '# Newer right edit' }));
    } finally {
      await act(async () => root.unmount());
      environment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it.each([false, true])('waits for a title rename and saves %s document edits at the new path', async (isExternalDocument) => {
    vi.useFakeTimers();
    const originalPath = '/notes/old-' + isExternalDocument + '.md';
    const identity = { kind: 'md' as const, ...ensureFileDisplayIdentity(originalPath) };
    reconcileFileDisplays([identity]);
    applyLoadedDocumentContent(identity, '/notes/old.md', 'Base');
    let currentPath = originalPath;
    let onChange: ((content: string) => void) | undefined;
    function Surface() {
      onChange = useDocumentAutosave({
        identity, filePath: '/notes/old.md', getCurrentFilePath: () => currentPath,
        externalScopePath: isExternalDocument ? '/notes' : null,
        setState: vi.fn(), reloadDocument: vi.fn().mockResolvedValue(undefined),
      }).handleChange;
      return null;
    }
    const element = document.createElement('div');
    const root = createRoot(element);
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    let finishRename: (() => void) | null = null;
    try {
      await act(async () => root.render(<Surface />));
      const gate = new Promise<void>(resolve => { finishRename = resolve; });
      const rename = enqueueDocumentCommit('md:' + identity.displayId, 'title', async () => {
        await gate;
        rebaseFileDisplayPath(originalPath, '/notes/new.md', identity.displayId);
        return true;
      });
      onChange?.('Edited during rename');
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(save).not.toHaveBeenCalled();

      currentPath = '/notes/new.md';
      finishRename!();
      finishRename = null;
      await act(async () => { await rename; });
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        path: '/notes/new.md', content: 'Edited during rename',
      }));
    } finally {
      (finishRename as (() => void) | null)?.();
      await act(async () => root.unmount());
      environment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('publishes unsaved edits to both subscribers and preserves them when another surface loads', () => {
    const identity = { kind: 'md' as const, path: '/shared-live.md', displayId: 'display-shared-live' };
    applyLoadedDocumentContent(identity, '/notes/live.md', '# Disk');
    const left: string[] = [];
    const right: string[] = [];
    const subscribe = (view: string[]) => subscribeDocumentBufferChanges((changed) => {
      if (changed.displayId === identity.displayId) view.push(getBuffer(identity)!.content);
    });
    const stopLeft = subscribe(left);
    const stopRight = subscribe(right);
    try {
      recordDocumentEdit(identity, '# Unsaved');
      applyLoadedDocumentContent(identity, '/notes/live.md', '# Disk', { preservePending: true, setAsCurrent: false });
      recordDocumentEdit(identity, '# Edited from right');
      expect(left).toEqual(['# Unsaved', '# Unsaved', '# Edited from right']);
      expect(right).toEqual(left);
    } finally { stopLeft(); stopRight(); }
  });
});
