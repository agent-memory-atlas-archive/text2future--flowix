import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renameTitle = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));
import {
  useMemoTitleSession,
  restoreTitleDraft,
  getTitleDraft,
  flushTitleDraft,
} from './memo-title-session';
import { enqueueDocumentCommit } from '../store/document-commit-queue';

describe('useMemoTitleSession', () => {
  let container: HTMLDivElement;
  let root: Root;
  let session: ReturnType<typeof useMemoTitleSession> | null;
  let currentDisplayId: string;

  function Harness({ displayId, filename = 'Original.md' }: { displayId: string; filename?: string }) {
    const currentSession = useMemoTitleSession(displayId, filename, renameTitle);
    session = currentSession;
    return createElement('div', { 'data-title': currentSession.snapshot.draft });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    session = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      currentDisplayId = `display:title-${Math.random()}`;
      root.render(createElement(Harness, { displayId: currentDisplayId }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('enqueues the next title before later body writes', async () => {
    let finishRename!: (name: string) => void;
    let finishBody!: (ok: boolean) => void;
    let finishLaterBody!: (ok: boolean) => void;
    renameTitle.mockImplementationOnce(() => new Promise(resolve => { finishRename = resolve; })).mockResolvedValue('C.md');
    act(() => { session!.setDraft('B'); void session!.commit(); });
    const body = enqueueDocumentCommit('md:' + currentDisplayId, 'body', () => new Promise(resolve => { finishBody = resolve; }));
    await act(async () => { finishRename('B.md'); });
    act(() => { session!.setDraft('C'); void session!.commit(); });
    enqueueDocumentCommit('md:' + currentDisplayId, 'body', () => new Promise(resolve => { finishLaterBody = resolve; }));
    await act(async () => { finishBody(true); });
    const callsBeforeLaterBodySettles = renameTitle.mock.calls.length;
    await act(async () => { finishLaterBody(true); await body; });
    expect(callsBeforeLaterBodySettles).toBe(2);
  });
  it('keeps an empty draft local while editing', () => {
    expect(session).not.toBeNull();

    act(() => session?.setDraft(''));
    expect(container.firstElementChild?.getAttribute('data-title')).toBe('');

    expect(renameTitle).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute('data-title')).toBe('');
  });

  it('keeps an empty title draft and reports validation without renaming', async () => {
    expect(session).not.toBeNull();

    act(() => session?.setDraft(''));
    await act(async () => session?.commit());

    expect(renameTitle).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute('data-title')).toBe('');
    expect(session?.snapshot.error).toBeTruthy();
  });

  it('keeps a non-empty title local until editing ends', async () => {
    expect(session).not.toBeNull();
    renameTitle.mockResolvedValue('Renamed.md');

    act(() => session?.setDraft('Renamed'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(renameTitle).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute('data-title')).toBe('Renamed');
  });

  it('submits immediately on explicit commit', async () => {
    renameTitle.mockResolvedValue('Renamed.md');

    act(() => session?.setDraft('Renamed'));
    await act(async () => session?.commit());

    expect(renameTitle).toHaveBeenCalledTimes(1);
    expect(renameTitle).toHaveBeenCalledWith('Renamed', 'Original.md');
  });

  it('submits the latest draft when the editor unmounts', async () => {
    renameTitle.mockResolvedValue('Renamed.md');

    act(() => session?.setDraft('Ren'));
    act(() => session?.setDraft('Renamed'));
    await act(async () => {
      root.render(null);
      await Promise.resolve();
    });
    expect(renameTitle).toHaveBeenCalledTimes(1);
    expect(renameTitle).toHaveBeenCalledWith('Renamed', 'Original.md');
  });

  it('keeps refused input recoverable while displaying the actual filename', async () => {
    renameTitle.mockResolvedValue(null);

    act(() => session?.setDraft('Renamed'));
    await act(async () => session?.commit({ expectBodyMutation: true }));

    expect(container.firstElementChild?.getAttribute('data-title')).toBe('Original');
    expect(session?.snapshot.recoverableDraft).toBe('Renamed');
    expect(getTitleDraft(currentDisplayId)?.draft).toBe('Renamed');
  });

  it.each(['before', 'after'])('opens with the real filename when recovery arrives %s the title mounts', async (timing) => {
    await act(async () => root.render(null));
    currentDisplayId = `display:recovery-${Math.random()}`;
    const recovery = { draft: '2026-10', filename: '2026-10-.md' };
    if (timing === 'before') restoreTitleDraft(currentDisplayId, recovery);
    await act(async () => root.render(createElement(Harness, {
      displayId: currentDisplayId, filename: '2026-10-.md',
    })));
    if (timing === 'after') act(() => restoreTitleDraft(currentDisplayId, recovery));
    expect(session?.snapshot.draft).toBe('2026-10-');
    expect(session?.snapshot.recoverableDraft).toBe('2026-10');
    expect(getTitleDraft(currentDisplayId)?.draft).toBe('2026-10');
    await act(async () => { await flushTitleDraft(currentDisplayId); });
    await act(async () => root.render(null));
    expect(renameTitle).not.toHaveBeenCalled();
  });

  it('keeps recovered input when a no-op input event reports the displayed filename', () => {
    const recovery = { draft: '2026-10', filename: 'Original.md' };
    act(() => restoreTitleDraft(currentDisplayId, recovery));

    act(() => session!.setDraft('Original'));

    expect(session!.snapshot.draft).toBe('Original');
    expect(session!.snapshot.recoverableDraft).toBe('2026-10');
    expect(getTitleDraft(currentDisplayId)?.draft).toBe('2026-10');
  });

  it('does not retry a failed rename during a later save or unmount, and permits explicit recovery', async () => {
    renameTitle.mockRejectedValueOnce('FILE_EXISTS: File exists (os error 17)');
    act(() => session!.setDraft('Occupied'));
    await act(async () => { expect(await session!.commit()).toBe(false); });
    expect(session!.snapshot.draft).toBe('Original');
    expect(session!.snapshot.recoverableDraft).toBe('Occupied');
    await act(async () => { await flushTitleDraft(currentDisplayId); });
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Harness, { displayId: currentDisplayId })));
    expect(session!.snapshot.draft).toBe('Original');
    expect(renameTitle).toHaveBeenCalledTimes(1);

    act(() => session!.recoverDraft());
    expect(session!.snapshot.draft).toBe('Occupied');
    expect(renameTitle).toHaveBeenCalledTimes(1);
    renameTitle.mockResolvedValueOnce('Occupied.md');
    await act(async () => { await session!.commit(); });
    expect(session!.snapshot.draft).toBe('Occupied');
    expect(getTitleDraft(currentDisplayId)).toBeNull();
    await act(async () => root.render(null));
    expect(renameTitle).toHaveBeenCalledTimes(2);
  });

  it('coalesces title intents while a body write owns the writer', async () => {
    let finish!: (value: boolean) => void;
    const body = enqueueDocumentCommit(`md:${currentDisplayId}`, 'body', () => new Promise(resolve => { finish = resolve; }));
    renameTitle.mockImplementation(async title => `${title}.md`);
    for (const title of ['B', 'C', 'D']) {
      act(() => { session!.setDraft(title); void session!.commit(); });
    }
    expect(renameTitle).not.toHaveBeenCalled();
    await act(async () => { finish(true); await body; });
    expect(renameTitle).toHaveBeenCalledTimes(1);
    expect(renameTitle).toHaveBeenCalledWith('D', 'Original.md');
  });

  it('cancels a title intent before its queued rename starts', async () => {
    let finish!: (value: boolean) => void;
    const body = enqueueDocumentCommit(`md:${currentDisplayId}`, 'body', () => new Promise(resolve => { finish = resolve; }));
    act(() => { session!.setDraft('B'); void session!.commit(); session!.cancel(); });
    await act(async () => { finish(true); await body; });
    expect(renameTitle).not.toHaveBeenCalled();
    expect(session!.snapshot.draft).toBe('Original');
  });
});
