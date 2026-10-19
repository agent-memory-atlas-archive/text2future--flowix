import { afterEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: new Set<(payload: unknown) => void>() }));
vi.mock('./event-bus', () => ({
  subscribe: (_name: string, handler: (payload: unknown) => void) => {
    bus.handlers.add(handler);
    return () => bus.handlers.delete(handler);
  },
}));

import { beginNotebookPathRename, publishNotebookPathMove, subscribeNotebookChanges } from './notebook-change-events';

const disposers: Array<() => void> = [];
const emit = (payload: unknown) => { for (const handler of bus.handlers) handler(payload); };
const deleted = { notebookId: 'book', relativePath: 'old.md', deleted: true };
afterEach(() => { for (const stop of disposers.splice(0)) stop(); });

describe('local rename event ordering', () => {
  it('keeps all consumers alive when old-path deletion arrives before the rename receipt', () => {
    const editor = vi.fn();
    const cards = vi.fn();
    disposers.push(subscribeNotebookChanges(editor), subscribeNotebookChanges(cards));
    const finish = beginNotebookPathRename('book', 'old.md');
    emit(deleted);
    expect(editor).not.toHaveBeenCalled();
    expect(cards).not.toHaveBeenCalled();

    const move = { changeId: 'rename-1', notebookId: 'book', previousRelativePath: 'old.md', relativePath: 'new.md', directory: false };
    publishNotebookPathMove(move);
    finish(true);
    emit(move); // The native broadcast can arrive after the command receipt.
    expect(editor).toHaveBeenCalledExactlyOnceWith({ ...move, kind: 'path-moved' });
    expect(cards).toHaveBeenCalledExactlyOnceWith({ ...move, kind: 'path-moved' });

    // Reusing the old filename must not hide a real deletion of its new file.
    emit({ notebookId: 'book', relativePath: 'old.md', created: true });
    emit(deleted);
    expect(editor.mock.lastCall?.[0].kind).toBe('resource-deleted');
  });

  it('replays a real deletion on rename failure, without holding other files or notebooks', () => {
    const handler = vi.fn();
    disposers.push(subscribeNotebookChanges(handler));
    const finish = beginNotebookPathRename('book', 'old.md');
    emit(deleted);
    emit(deleted);
    emit({ ...deleted, notebookId: 'other-book' });
    emit({ ...deleted, relativePath: 'other.md' });
    expect(handler).toHaveBeenCalledTimes(2);
    finish(false);
    expect(handler.mock.lastCall?.[0]).toMatchObject({ kind: 'resource-deleted', notebookId: 'book', relativePath: 'old.md' });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('does not replay events into an unmounted consumer', () => {
    const handler = vi.fn();
    const stop = subscribeNotebookChanges(handler);
    const finish = beginNotebookPathRename('book', 'old.md');
    emit(deleted);
    stop();
    finish(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
