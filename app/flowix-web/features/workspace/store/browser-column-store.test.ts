import { beforeEach, expect, it } from 'vitest';
import { useBrowserColumnStore } from './browser-column-store';
import type { BrowserColumnEntry } from '../model/browser-column-session';
const tab = (name: string): BrowserColumnEntry => ({ id: name, title: name, icon: null, target: { kind: 'web', url: `https://${name}.example/` } });
beforeEach(() => useBrowserColumnStore.getState().reset());
it('replaces the only surface and records visits, including revisits', () => {
  const store = useBrowserColumnStore.getState();
  store.openContent(tab('a')); store.openContent(tab('b')); store.openContent(tab('a'));
  const state = useBrowserColumnStore.getState();
  expect(state.current?.title).toBe('a');
  expect(state.backStack.map((item) => item.title)).toEqual(['a', 'b']);
  expect(new Set([...state.backStack, state.current!].map((item) => item.id)).size).toBe(3);
});
it('focuses the current content without pushing duplicate visits', () => {
  const store = useBrowserColumnStore.getState();
  const id = store.openContent(tab('a'));
  expect(store.openContent({ ...tab('a'), title: 'updated' })).toBe(id);
  expect(useBrowserColumnStore.getState().backStack).toEqual([]);
  expect(useBrowserColumnStore.getState().current!.title).toBe('updated');
});
it('moves history in both directions and truncates the forward branch on a new open', () => {
  const store = useBrowserColumnStore.getState();
  store.openContent(tab('a')); store.openContent(tab('b')); store.openContent(tab('c'));
  store.restoreHistoryEntry(useBrowserColumnStore.getState().backStack[1], 'back');
  expect(useBrowserColumnStore.getState().current!.title).toBe('b');
  expect(useBrowserColumnStore.getState().forwardStack[0].title).toBe('c');
  store.restoreHistoryEntry(useBrowserColumnStore.getState().forwardStack[0], 'forward');
  expect(useBrowserColumnStore.getState().current!.title).toBe('c');
  store.restoreHistoryEntry(useBrowserColumnStore.getState().backStack[1], 'back');
  store.openContent(tab('d'));
  expect(useBrowserColumnStore.getState().backStack.map((item) => item.title)).toEqual(['a', 'b']);
  expect(useBrowserColumnStore.getState().forwardStack).toEqual([]);
});
it('keeps history when hidden, bounds visits and rejects stale metadata', () => {
  const store = useBrowserColumnStore.getState();
  const old = store.openContent(tab('a'));
  for (let index = 0; index < 110; index++) store.openContent(tab(`b${index}`));
  store.setVisible(false); store.setVisible(true);
  store.updateContentMetadata(old, { title: 'stale' });
  expect(useBrowserColumnStore.getState().backStack).toHaveLength(100);
  expect(useBrowserColumnStore.getState().current!.title).toBe('b109');
});
it('renames retained file history and removes deleted targets from both stacks', () => {
  const store = useBrowserColumnStore.getState();
  store.openContent({ id: 'file', title: 'a', icon: null, target: { kind: 'file-browser', activeFilePath: '/book/a.md', folderPath: '/book', notebookId: null, scopePath: '/book', fileTreeVisible: false, fileTreeWidth: 220 } });
  store.openContent(tab('b'));
  store.replaceExternalPath('/book/a.md', '/book/c.md');
  expect(useBrowserColumnStore.getState().backStack[0].target).toMatchObject({ activeFilePath: '/book/c.md' });
  store.clearExternalPath('/book/c.md');
  expect(useBrowserColumnStore.getState().backStack).toEqual([]);
});

it('updates all retained descriptions atomically and avoids publishing no-op transformations', () => {
  const store = useBrowserColumnStore.getState();
  store.openContent(tab('a')); store.openContent(tab('b')); store.openContent(tab('c'));
  store.restoreHistoryEntry(useBrowserColumnStore.getState().backStack[1], 'back');
  let updates = 0;
  const stop = useBrowserColumnStore.subscribe(() => { updates++; });
  try {
    store.updateEntries((entry) => entry);
    expect(updates).toBe(0);
    store.updateEntries((entry) => ({ ...entry, title: `${entry.title}!` }));
    expect(updates).toBe(1);
    const state = useBrowserColumnStore.getState();
    expect(state.current?.title).toBe('b!');
    expect(state.backStack[0].title).toBe('a!');
    expect(state.forwardStack[0].title).toBe('c!');
  } finally { stop(); }
});

it('rejects stale WebView updates while keeping web URL navigation out of column history', () => {
  const store = useBrowserColumnStore.getState();
  const retired = store.openContent(tab('a'));
  const current = store.openContent(tab('b'));
  expect(store.navigateWeb(retired, 'https://stale.example/')).toBe(false);
  expect(store.navigateWeb(current, 'https://next.example/')).toBe(true);
  expect(useBrowserColumnStore.getState().backStack).toHaveLength(1);
  expect(store.goBackWeb(current)).toBe(true);
  expect(useBrowserColumnStore.getState().current?.target).toEqual(tab('b').target);
});
