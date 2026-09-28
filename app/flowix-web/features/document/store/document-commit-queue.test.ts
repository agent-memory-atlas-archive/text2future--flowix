import { afterEach, describe, expect, it, vi } from 'vitest';
import { enqueueDocumentCommit, waitForDocumentCommits, scheduleDocumentCapture, documentCommitDiagnostics } from './document-commit-queue';

function deferred() {
  let resolve!: (value: boolean) => void;
  return { promise: new Promise<boolean>(done => { resolve = done; }), resolve: (value = true) => resolve(value) };
}

describe('document commit coordinator', () => {
  afterEach(() => vi.useRealTimers());
  it('serializes rename with body saves and coalesces 300 repeated edits', async () => {
    const first = deferred(); const events: string[] = [];
    let active = 0; let maximum = 0;
    const key = 'md:repeated-edit-review';
    const done = enqueueDocumentCommit(key, 'body', async () => {
      maximum = Math.max(maximum, ++active); events.push('body:first');
      await first.promise; active--; return true;
    });
    void enqueueDocumentCommit(key, 'title', async () => {
      maximum = Math.max(maximum, ++active); events.push('rename'); active--; return true;
    });
    for (let i = 0; i < 300; i++) void enqueueDocumentCommit(key, 'body', async () => {
      maximum = Math.max(maximum, ++active); events.push('body:' + i); active--; return true;
    });
    expect(documentCommitDiagnostics().pending).toBe(2);
    expect(events).toEqual(['body:first']);
    first.resolve();
    expect(await done).toBe(true);
    expect(await waitForDocumentCommits(key)).toBe(true);
    expect(events).toEqual(['body:first', 'rename', 'body:299']);
    expect(maximum).toBe(1);
    expect(documentCommitDiagnostics()).toEqual({ active: 0, pending: 0, clocks: 0 });
  });
  it('releases ownership after a rejected operation and can retry', async () => {
    const key = 'md:failed-review';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await enqueueDocumentCommit(key, 'title', async () => { throw new Error('disk busy'); })).toBe(false);
    expect(await enqueueDocumentCommit(key, 'body', async () => true)).toBe(true);
    expect(await waitForDocumentCommits(key)).toBe(true);
    errorLog.mockRestore();
  });
  it('confirms a completed rename while a later body write is still running', async () => {
    const key = 'md:operation-result-review';
    const body = deferred();
    const rename = enqueueDocumentCommit(key, 'title', async () => true);
    enqueueDocumentCommit(key, 'body', () => body.promise);
    expect(await rename).toBe(true);
    expect(documentCommitDiagnostics().active).toBe(1);
    body.resolve();
    expect(await waitForDocumentCommits(key)).toBe(true);
  });
  it('uses one 300ms capture deadline and saves during continuous typing by 2s', async () => {
    vi.useFakeTimers(); const capture = vi.fn();
    scheduleDocumentCapture('md:clock', capture);
    await vi.advanceTimersByTimeAsync(299); expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(capture).toHaveBeenCalledTimes(1);
    capture.mockClear();
    for (let i = 0; i < 20; i++) {
      scheduleDocumentCapture('md:clock', capture);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(capture).toHaveBeenCalledTimes(1);
    expect(documentCommitDiagnostics().clocks).toBe(0);
  });
});
