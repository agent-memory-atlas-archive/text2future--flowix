import { describe, expect, it, vi } from 'vitest';

const { rename, updateNoteLinksAfterMove } = vi.hoisted(() => ({
  rename: vi.fn(async () => 'C:/Notes/New.md'),
  updateNoteLinksAfterMove: vi.fn(),
}));
const bus = vi.hoisted(() => ({ handlers: new Set<(payload: unknown) => void>() }));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: (_name: string, handler: (payload: unknown) => void) => {
    bus.handlers.add(handler);
    return () => bus.handlers.delete(handler);
  },
}));

vi.mock('@platform/tauri/client', () => ({ externalDocuments: {} }));
vi.mock('@platform/tauri/client/desktop', () => ({ files: { rename } }));
vi.mock('@features/memo/services/note-link-rewriter', () => ({ updateNoteLinksAfterMove }));

import { renameMarkdownTitle } from './local-document-operations';
import { ensureFileDisplayIdentity, findFileDisplayPath, rebaseFileDisplayPath, reconcileFileDisplays } from '@/lib/file-display-registry';
import { consumeExpectedExternalDocumentEvent, isExternalDocumentRenameInProgress } from '../store/external-document-operation';
import { beginNotebookPathRename, publishNotebookPathMove, subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';

describe('local note rename', () => {
  it('schedules link updates after the editor title renames the file', async () => {
    const identity = ensureFileDisplayIdentity('C:/Notes/Old.md');
    const result = await renameMarkdownTitle({
      path: 'C:/Notes/Old.md',
      title: 'New',
      scopePath: 'C:/Notes',
      notebook: null,
      displayId: identity.displayId,
      onPathChanged: vi.fn(),
    });
    expect(result?.path).toBe('C:/Notes/New.md');
    expect(updateNoteLinksAfterMove).toHaveBeenCalledWith('C:/Notes/Old.md', 'C:/Notes/New.md');
  });

  it('protects the open document and selection from a watcher delete during the real rename use case', async () => {
    const identity = ensureFileDisplayIdentity('C:/RenameRace/folder/Old.md');
    reconcileFileDisplays([identity]);
    let currentPath = identity.path;
    let selectedPath: string | null = 'folder/Old.md';
    const stop = subscribeNotebookChanges(change => {
      if (change.kind === 'resource-deleted') { currentPath = ''; selectedPath = null; }
      if (change.kind === 'path-moved') selectedPath = change.relativePath;
    });
    rename.mockImplementationOnce(async () => {
      for (const handler of bus.handlers) handler({ notebookId: 'book', relativePath: 'folder/Old.md', deleted: true });
      expect(currentPath).toBe(identity.path);
      expect(selectedPath).toBe('folder/Old.md');
      publishNotebookPathMove({ changeId: 'race', notebookId: 'book', previousRelativePath: 'folder/Old.md', relativePath: 'folder/New.md', directory: false });
      return 'C:/RenameRace/folder/New.md';
    });
    try {
      await renameMarkdownTitle({
        path: identity.path, title: 'New', scopePath: 'C:/RenameRace/folder', notebook: { id: 'book', path: 'C:/RenameRace' }, displayId: identity.displayId,
        onPathChanged: (previous, next) => { rebaseFileDisplayPath(previous, next, identity.displayId); currentPath = next; },
      });
      expect(currentPath).toBe('C:/RenameRace/folder/New.md');
      expect(selectedPath).toBe('folder/New.md');
      expect(findFileDisplayPath(identity.displayId)).toBe(currentPath);
      expect(isExternalDocumentRenameInProgress(identity.displayId)).toBe(false);
    } finally { stop(); }
  });

  it('releases the rename lock and delivers a real source deletion if the rename fails', async () => {
    const identity = ensureFileDisplayIdentity('C:/RenameFailure/Old.md');
    reconcileFileDisplays([identity]);
    const handler = vi.fn();
    const stop = subscribeNotebookChanges(handler);
    rename.mockImplementationOnce(async () => {
      for (const notify of bus.handlers) notify({ notebookId: 'failure-book', relativePath: 'Old.md', deleted: true });
      expect(handler).not.toHaveBeenCalled();
      throw new Error('FILE_NOT_FOUND');
    });
    try {
      await expect(renameMarkdownTitle({
        path: identity.path, title: 'New', scopePath: 'C:/RenameFailure',
        notebook: { id: 'failure-book', path: 'C:/RenameFailure' }, displayId: identity.displayId, onPathChanged: vi.fn(),
      })).rejects.toThrow('FILE_NOT_FOUND');
      expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'resource-deleted' }));
      expect(isExternalDocumentRenameInProgress(identity.displayId)).toBe(false);
    } finally { stop(); }
  });

  it('keeps a confirmed move protected even if the UI projection throws', async () => {
    const identity = ensureFileDisplayIdentity('C:/ProjectionFailure/Old.md');
    reconcileFileDisplays([identity]);
    rename.mockResolvedValueOnce('C:/ProjectionFailure/New.md');
    await expect(renameMarkdownTitle({
      path: identity.path, title: 'New', scopePath: 'C:/ProjectionFailure',
      notebook: { id: 'projection-book', path: 'C:/ProjectionFailure' }, displayId: identity.displayId,
      onPathChanged: () => { throw new Error('projection failed'); },
    })).rejects.toThrow('projection failed');
    expect(consumeExpectedExternalDocumentEvent(identity.path, 'deleted', 'missing')).toBe(true);
    expect(isExternalDocumentRenameInProgress(identity.displayId)).toBe(false);

    // The notebook event guard was released independently of the UI failure.
    const finish = beginNotebookPathRename('projection-book', 'Old.md');
    finish(true);
  });

  it('rejects an inconsistent notebook context before taking locks or changing a file', async () => {
    const identity = ensureFileDisplayIdentity('C:/Outside/Old.md');
    const calls = rename.mock.calls.length;
    await expect(renameMarkdownTitle({
      path: identity.path, title: 'New', scopePath: 'C:/Outside',
      notebook: { id: 'wrong-book', path: 'C:/OtherNotebook' }, displayId: identity.displayId, onPathChanged: vi.fn(),
    })).rejects.toThrow('Rename source must belong');
    expect(rename.mock.calls).toHaveLength(calls);
    expect(isExternalDocumentRenameInProgress(identity.displayId)).toBe(false);
  });
});
