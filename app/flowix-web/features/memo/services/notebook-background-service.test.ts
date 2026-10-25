import { beforeEach, expect, it, vi } from 'vitest';
import type { NotebookBackgroundStatus } from '@platform/tauri/client/memos';
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), mediaStatus: vi.fn(), subscribe: vi.fn(), invalidate: vi.fn(), setNotes: vi.fn(), stop: vi.fn() }));
// 服务同时拉取媒体维护状态（getMediaMaintenanceStatus）；缺这个桩会在挂载时抛
// "is not a function"，让三个用例一起红。
vi.mock('@platform/tauri/client/memos', () => ({
  notebooks: {
    getBackgroundStatus: mocks.snapshot,
    getMediaMaintenanceStatus: mocks.mediaStatus,
  },
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: mocks.subscribe }));
vi.mock('@platform/tauri/notebook-change-events', () => ({ publishNotebookQueryInvalidated: mocks.invalidate }));
vi.mock('../store/note-store', () => ({ useNoteStore: { setState: mocks.setNotes } }));
import { useNotebookBackgroundStore } from '../store/notebook-background-store';
import { mountNotebookBackgroundUpdates } from './notebook-background-service';
beforeEach(() => {
  vi.resetAllMocks(); mocks.snapshot.mockResolvedValue([]); mocks.mediaStatus.mockResolvedValue([]); mocks.subscribe.mockReturnValue(mocks.stop);
  useNotebookBackgroundStore.setState({ statuses: {} });
});
it('does not let an old snapshot overwrite a newer completion event', async () => {
  let finish!: (value: NotebookBackgroundStatus[]) => void;
  mocks.snapshot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const stop = mountNotebookBackgroundUpdates();
  const deliver = mocks.subscribe.mock.calls[0][1] as (status: NotebookBackgroundStatus) => void;
  deliver({ notebookId: 'a', revision: 2, state: 'ready', memoCount: 4, message: null });
  finish([{ notebookId: 'a', revision: 1, state: 'running', message: null }]);
  await vi.waitFor(() => expect(useNotebookBackgroundStore.getState().statuses.a.memoCount).toBe(4));
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('a');
  stop();
});
it('reconciles a missed completion when the event listener reconnects', async () => {
  const stop = mountNotebookBackgroundUpdates();
  await Promise.resolve();
  mocks.snapshot.mockResolvedValueOnce([{ notebookId: 'a', revision: 3, state: 'ready', memoCount: 0, message: null }]);
  mocks.subscribe.mock.calls[0][2].onListenerReady();
  await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('a'));
  expect(useNotebookBackgroundStore.getState().statuses.a.memoCount).toBe(0);
  stop();
});
it('ignores a snapshot that arrives after the workbench unmounts', async () => {
  let finish!: (value: NotebookBackgroundStatus[]) => void;
  mocks.snapshot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const stop = mountNotebookBackgroundUpdates(); stop();
  finish([{ notebookId: 'a', revision: 1, state: 'ready', memoCount: 2, message: null }]);
  await Promise.resolve();
  expect(mocks.setNotes).not.toHaveBeenCalled(); expect(mocks.invalidate).not.toHaveBeenCalled();
  // 服务现在订阅两条通道（笔记本后台状态 + 媒体维护状态），卸载时都要退订。
  expect(mocks.stop).toHaveBeenCalledTimes(2);
});
