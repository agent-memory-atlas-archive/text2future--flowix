import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createErrorReport,
  getRecentUncaughtErrors,
  installGlobalErrorHandlers,
  reportUncaughtError,
  subscribeUncaughtErrors,
} from './global-error';

describe('global error boundary', () => {
  beforeEach(() => {
    installGlobalErrorHandlers();
  });

  it('buffers a report and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUncaughtErrors(listener);
    const before = getRecentUncaughtErrors().length;

    reportUncaughtError(createErrorReport('error', new Error('boom'), 'test'));

    expect(getRecentUncaughtErrors()).toHaveLength(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].message).toBe('boom');
    unsubscribe();
  });

  it('does not notify when the caller already renders a fallback', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUncaughtErrors(listener);

    reportUncaughtError(createErrorReport('boundary', new Error('render')), { notify: false });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('captures an unhandled promise rejection', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUncaughtErrors(listener);

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    Object.defineProperty(event, 'reason', { value: new Error('rejected') });
    window.dispatchEvent(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ kind: 'rejection', message: 'rejected' });
    unsubscribe();
  });

  it('ignores resource load errors that carry no error object', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUncaughtErrors(listener);

    const event = new Event('error');
    window.dispatchEvent(event);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('captures a window error event', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUncaughtErrors(listener);

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('thrown'), message: 'thrown' }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ kind: 'error', message: 'thrown' });
    unsubscribe();
  });
});
