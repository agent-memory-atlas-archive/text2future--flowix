import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearActionableNotice,
  getActionableNotices,
  runActionableNoticeAction,
  upsertActionableNotice,
  type ActionableNotice,
} from './actionable-notice-store';

const id = 'action-race-test';
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function notice(run: () => Promise<void>, revision = 1): ActionableNotice {
  return { id, revision, priority: 1, tone: 'error', title: 'Retry', actions: [{ id: 'retry', label: 'Retry', run }] };
}
const current = () => getActionableNotices().find((entry) => entry.id === id)!;
afterEach(() => clearActionableNotice(id));

describe('actionable notice asynchronous actions', () => {
  it.each(['revision', 'recreated'] as const)('ignores old failures after a notice is %s', async (replacement) => {
    const oldAction = deferred();
    const newAction = deferred();
    upsertActionableNotice(notice(() => oldAction.promise));
    const oldRun = runActionableNoticeAction(id, 'retry');
    if (replacement === 'recreated') clearActionableNotice(id);
    upsertActionableNotice(notice(() => newAction.promise, replacement === 'revision' ? 2 : 1));
    const newRun = runActionableNoticeAction(id, 'retry');
    oldAction.reject(new Error('obsolete failure'));
    await oldRun;
    expect(current().actionError).toBeNull();
    expect(current().busyActionId).toBe('retry');
    newAction.resolve();
    await newRun;
    expect(current().busyActionId).toBeNull();
  });

  it('preserves an in-flight action across presentation updates of the same revision', async () => {
    const action = deferred();
    upsertActionableNotice(notice(() => action.promise));
    const run = runActionableNoticeAction(id, 'retry');
    upsertActionableNotice({ ...notice(() => action.promise), title: 'Updated title' });
    expect(current().busyActionId).toBe('retry');
    action.reject(new Error('current failure'));
    await run;
    expect(current().actionError).toBe('current failure');
    expect(current().busyActionId).toBeNull();
  });

  it('prevents duplicate execution and supports retry after failure', async () => {
    const action = deferred();
    const run = vi.fn().mockReturnValueOnce(action.promise).mockResolvedValueOnce(undefined);
    upsertActionableNotice(notice(run));
    const first = runActionableNoticeAction(id, 'retry');
    await runActionableNoticeAction(id, 'retry');
    expect(run).toHaveBeenCalledOnce();
    action.reject(new Error('offline'));
    await first;
    expect(current().actionError).toBe('offline');
    await runActionableNoticeAction(id, 'retry');
    expect(run).toHaveBeenCalledTimes(2);
    expect(current().actionError).toBeNull();
    expect(current().busyActionId).toBeNull();
  });
});
