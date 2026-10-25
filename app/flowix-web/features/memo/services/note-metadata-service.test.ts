import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';
const mocks = vi.hoisted(() => ({ getIndexed: vi.fn(), stop: vi.fn(), subscribe: vi.fn(), receive: null as null | ((change: NotebookChange) => void) }));
vi.mock('./note-repository', () => ({ noteRepository: { getIndexed: mocks.getIndexed } }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ subscribeNotebookChanges: mocks.subscribe }));
import { noteMetadata, observeNoteMetadata, refreshNoteMetadata, subscribeNotebookMetadata } from './note-metadata-service';
const scope = { notebookId: 'nb', notebookPath: '/notes' };
const value = { icon: 'book', colors: [], favorited: true };
const entry = { ...value, relativePath: 'a.md', title: 'A', preview: '', thumbnail: null, tags: [], todos: [], agents: [], createdAt: 1, updatedAt: 2, properties: {} };
beforeEach(() => {
  noteMetadata.clear();
  mocks.getIndexed.mockReset();
  mocks.stop.mockClear();
  mocks.subscribe.mockReset().mockImplementation((receive) => { mocks.receive = receive; return mocks.stop; });
});
describe('shared metadata service', () => {
  it('shares a notebook listener until its final consumer leaves', () => {
    const first = subscribeNotebookMetadata(scope);
    const second = subscribeNotebookMetadata(scope);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    first();
    expect(mocks.stop).not.toHaveBeenCalled();
    second();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('coalesces reads and rejects results superseded by force refresh', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.getIndexed.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(value);
    const old = refreshNoteMetadata(scope, 'a.md');
    expect(refreshNoteMetadata(scope, 'a.md')).toBe(old);
    await Promise.resolve();
    await refreshNoteMetadata(scope, 'a.md', true);
    resolveOld({ ...value, icon: 'old' });
    await old;
    expect(noteMetadata.get('/notes/a.md').value).toEqual(value);
  });
  it('refreshes a stale path on reattachment and shares the read', async () => {
    noteMetadata.update('/notes/deep/a.md', value);
    noteMetadata.invalidate('/notes/deep/a.md');
    mocks.getIndexed.mockResolvedValue({ ...entry, icon: 'new' });
    const first = observeNoteMetadata(scope, '/notes/deep/a.md', () => {});
    const second = observeNoteMetadata(scope, '/notes/deep/a.md', () => {});
    await refreshNoteMetadata(scope, 'deep/a.md');
    expect(mocks.getIndexed).toHaveBeenCalledTimes(1);
    expect(noteMetadata.get('/notes/deep/a.md').value?.icon).toBe('new');
    first(); second();
  });
  it('does not loop on unavailable metadata or revive deleted paths on attachment', async () => {
    mocks.getIndexed.mockResolvedValue(null);
    const stop = observeNoteMetadata(scope, '/notes/a.md', () => {});
    await refreshNoteMetadata(scope, 'a.md');
    expect(mocks.getIndexed).toHaveBeenCalledTimes(1);
    stop();
    noteMetadata.deletePrefix('/notes/a.md');
    noteMetadata.invalidate('/notes/a.md');
    const stopDeleted = observeNoteMetadata(scope, '/notes/a.md', () => {});
    await Promise.resolve();
    expect(mocks.getIndexed).toHaveBeenCalledTimes(1);
    expect(noteMetadata.get('/notes/a.md').status).toBe('deleted');
    stopDeleted();
  });
  it('keeps a newer event while an outstanding path read survives cache pressure', async () => {
    let resolve!: (value: unknown) => void;
    mocks.getIndexed.mockReturnValue(new Promise((done) => { resolve = done; }));
    const read = refreshNoteMetadata(scope, 'a.md');
    await Promise.resolve();
    noteMetadata.update('/notes/a.md', value);
    for (let index = 0; index < 5010; index++) noteMetadata.update(`/other/${index}.md`, value);
    resolve({ ...entry, icon: 'old' });
    await read;
    expect(noteMetadata.get('/notes/a.md').value).toEqual(value);
  });
  it('uses explicit previous favorite state for notes outside loaded pages', () => {
    const receive = vi.fn();
    const stop = subscribeNotebookMetadata(scope, receive);
    mocks.receive?.({ kind: 'resource-updated', notebookId: 'nb', relativePath: 'unloaded.md', entry, previousFavorited: true } as NotebookChange);
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ favoriteChanged: false }));
    mocks.receive?.({ kind: 'resource-updated', notebookId: 'nb', relativePath: 'other.md', entry, previousFavorited: false } as NotebookChange);
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ favoriteChanged: true }));
    stop();
  });
});
