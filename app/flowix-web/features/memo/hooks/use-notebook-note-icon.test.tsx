import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';
const mocks = vi.hoisted(() => ({
  getIndexed: vi.fn(), stop: vi.fn(),
  receive: null as null | ((change: NotebookChange) => void),
  ready: null as null | (() => void),
}));
vi.mock('../services/note-repository', () => ({ noteRepository: { getIndexed: mocks.getIndexed } }));
vi.mock('../store/note-store', () => ({ useNoteStore: (select: (state: unknown) => unknown) => select({ notebooks: [{ id: 'nb', path: '/notes' }] }) }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ subscribeNotebookChanges: (receive: typeof mocks.receive, options: { onListenerReady: () => void }) => {
  mocks.receive = receive; mocks.ready = options.onListenerReady; return mocks.stop;
} }));
import { noteMetadata } from '../services/note-metadata-service';
import { useNotebookNoteIcon } from './use-notebook-note-icon';
const entry = { relativePath: 'a.md', title: 'A', preview: '', thumbnail: null, tags: [], todos: [], agents: [], createdAt: 1, updatedAt: 2, properties: {}, icon: 'book', colors: [], favorited: false };
let root: Root;
let result: string | null;
function Harness({ path }: { path: string | null }) { result = useNotebookNoteIcon(path); return null; }
beforeEach(() => {
  noteMetadata.clear(); mocks.getIndexed.mockReset(); mocks.stop.mockClear();
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
it('reads only the current document and clears its icon when content changes', async () => {
  mocks.getIndexed.mockResolvedValue(entry);
  await act(async () => root.render(createElement(Harness, { path: '/notes/a.md' })));
  expect(result).toBe('book');
  await act(async () => root.render(createElement(Harness, { path: null })));
  expect(result).toBeNull();
  expect(mocks.getIndexed).toHaveBeenCalledTimes(1);
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it('consumes shared updates and listener recovery without a private icon cache', async () => {
  noteMetadata.update('/notes/a.md', entry);
  await act(async () => root.render(createElement(Harness, { path: '/notes/a.md' })));
  expect(result).toBe('book');
  expect(mocks.getIndexed).not.toHaveBeenCalled();
  await act(async () => mocks.receive?.({ kind: 'resource-updated', notebookId: 'nb', relativePath: 'a.md', entry: { ...entry, icon: 'new' } }));
  expect(result).toBe('new');
  mocks.getIndexed.mockResolvedValue({ ...entry, icon: 'recovered' });
  await act(async () => mocks.ready?.());
  expect(result).toBe('recovered');
});
it('does not display a previous document while the next read is pending', async () => {
  mocks.getIndexed.mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...entry, icon: 'next' });
  await act(async () => root.render(createElement(Harness, { path: '/notes/a.md' })));
  await act(async () => root.render(createElement(Harness, { path: '/notes/b.md' })));
  expect(result).toBe('next');
  expect(mocks.getIndexed).toHaveBeenLastCalledWith('nb', 'b.md');
});
