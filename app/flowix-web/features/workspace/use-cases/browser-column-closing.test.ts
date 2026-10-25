import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { registerWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { resetBrowserColumnCoordinator } from './browser-column-coordinator';
import { clearBrowserColumnSession, closeBrowserColumnContent } from './browser-column-closing';
const tab = (id: string) => ({ id, title: id, icon: null, target: { kind: 'web' as const, url: `https://${id}.example/` } });
afterEach(() => {
  registerWorkspaceSurfaceLifecycle('b', null);
  resetBrowserColumnCoordinator(); useBrowserColumnStore.getState().reset();
});
it('retains the current surface and its history when close cannot save', async () => {
  const store = useBrowserColumnStore.getState();
  store.openContent(tab('a')); store.openContent(tab('b'));
  const flush = vi.fn(async () => false);
  registerWorkspaceSurfaceLifecycle('b', { status: 'ready', flush });
  await expect(closeBrowserColumnContent('b')).resolves.toBeNull();
  expect(useBrowserColumnStore.getState().current?.id).toBe('b');
  expect(useBrowserColumnStore.getState().backStack).toHaveLength(1);
});
it('can discard the active surface and clear the session', async () => {
  const store = useBrowserColumnStore.getState();
  store.openContent(tab('a')); store.openContent(tab('b'));
  const discard = vi.fn();
  registerWorkspaceSurfaceLifecycle('b', { status: 'ready', flush: async () => false, discard });
  await expect(clearBrowserColumnSession({ discardChanges: true })).resolves.toBe(true);
  expect(discard).toHaveBeenCalledOnce();
  expect(useBrowserColumnStore.getState().current).toBeNull();
  expect(useBrowserColumnStore.getState().backStack).toEqual([]);
});
it('ignores retired history identities without flushing current content', async () => {
  const store = useBrowserColumnStore.getState();
  store.openContent(tab('a')); store.openContent(tab('b'));
  const flush = vi.fn(async () => false);
  registerWorkspaceSurfaceLifecycle('b', { status: 'ready', flush });
  await expect(closeBrowserColumnContent('a')).resolves.toBe(true);
  expect(flush).not.toHaveBeenCalled();
});
