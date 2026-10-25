import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalDocumentChangedEvent } from '@platform/tauri/client';

const mocks = vi.hoisted(() => ({
  ready: null as null | (() => void),
  emit: null as null | ((event: ExternalDocumentChangedEvent) => void),
  stop: vi.fn(), watch: vi.fn().mockResolvedValue('lease'), unwatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: (_event: string, emit: typeof mocks.emit, options: { onListenerReady: () => void }) => {
  mocks.emit = emit;
  mocks.ready = options.onListenerReady;
  return mocks.stop;
} }));
vi.mock('@platform/tauri/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@platform/tauri/client', () => ({ windows: { watchExternalDocument: mocks.watch, unwatchExternalDocument: mocks.unwatch } }));
vi.mock('./external-document-operation', () => ({ consumeExpectedExternalDocumentEvent: () => false }));
import { subscribeExternalDocumentChanges } from './external-document-watch';

const stops: (() => void)[] = [];
beforeEach(() => { mocks.watch.mockReset().mockResolvedValue('lease'); });
afterEach(async () => {
  stops.splice(0).forEach(stop => stop());
  await Promise.resolve();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('external document listener reconciliation', () => {
  it('retries registration with backoff and reconciles after recovery', async () => {
    vi.useFakeTimers();
    mocks.watch.mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('busy')).mockResolvedValue('recovered-lease');
    const receive = vi.fn();
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', '/notes', receive));
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', '/notes', receive));
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.watch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.watch).toHaveBeenCalledTimes(3);
    expect(receive.mock.calls[0][0]).toEqual({ kind: 'invalidated', path: '/notes/a.md' });
    stops.splice(0).forEach(stop => stop());
    expect(mocks.unwatch).toHaveBeenCalledWith('recovered-lease');
  });

  it('cancels retries on disposal and releases a lease that resolves after disposal', async () => {
    vi.useFakeTimers();
    mocks.watch.mockRejectedValueOnce(new Error('busy'));
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', '/notes', vi.fn()));
    await vi.advanceTimersByTimeAsync(0);
    stops.pop()!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.watch).toHaveBeenCalledOnce();
    let finish!: (lease: string) => void;
    mocks.watch.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const receive = vi.fn();
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', '/notes', receive));
    stops.pop()!();
    finish('late-lease');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.unwatch).toHaveBeenCalledWith('late-lease');
    expect(receive).not.toHaveBeenCalled();
  });

  it('rechecks every active file after recovery, sharing reconciliation between views', async () => {
    const reconcile = vi.fn();
    const receive = vi.fn((_event, context) => context.runOnce('shared-file', reconcile));
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', '/notes', receive));
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', null, receive));
    const removed = vi.fn();
    stops.push(subscribeExternalDocumentChanges('/notes/b.md', '/notes', removed));
    stops.pop()!();
    mocks.ready?.();
    await Promise.resolve();
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[0][0]).toEqual({ kind: 'invalidated', path: '/notes/a.md' });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    mocks.ready?.();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate recovery checks and allows native notifications after recovery', () => {
    const receive = vi.fn();
    stops.push(subscribeExternalDocumentChanges('/notes/a.md', '/notes', receive));
    const event = { path: '/notes/a.md', kind: 'modified', revision: 'r1' } as const;
    mocks.emit?.(event);
    mocks.emit?.(event);
    expect(receive).toHaveBeenCalledOnce();
    mocks.ready?.();
    mocks.emit?.(event);
    expect(receive).toHaveBeenCalledTimes(3);
    stops.pop()!();
    mocks.ready?.();
    expect(receive).toHaveBeenCalledTimes(3);
  });
});
