import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renameTitle = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('@/lib/utils', () => ({
  displayTitleFromFilename: (filename: string) => filename.replace(/\.md$/i, ''),
}));

import {
  useMemoTitleSession,
} from './memo-title-session';
import { enqueueDocumentCommit } from '../store/document-commit-queue';

describe('useMemoTitleSession', () => {
  let container: HTMLDivElement;
  let root: Root;
  let session: ReturnType<typeof useMemoTitleSession> | null;
  let currentDisplayId: string;

  function Harness({ displayId }: { displayId: string }) {
    const currentSession = useMemoTitleSession(displayId, 'Original.md', renameTitle);
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

  it('preserves a boundary edit draft when the rename is refused', async () => {
    renameTitle.mockResolvedValue(null);

    act(() => session?.setDraft('Renamed'));
    await act(async () => session?.commit({ expectBodyMutation: true }));

    expect(container.firstElementChild?.getAttribute('data-title')).toBe('Renamed');
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
