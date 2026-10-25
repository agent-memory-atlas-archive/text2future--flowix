import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notebooks, type NotebookSetupJob } from '@platform/tauri/client';
import { useNoteStore } from '../store/note-store';
import { replaceNotebookSetupSnapshot, upsertNotebookSetupJob } from '../store/notebook-setup-store';
import { clearActionableNotice, dismissActionableNotice, getActionableNotices, runActionableNoticeAction } from '@features/notifications/actionable-notice-store';
import { NotebookSetupNoticeHost, NotebookSetupResultNotices } from './notebook-setup-notice-host';

vi.mock('@/lib/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@platform/tauri/errors', () => ({ notebookCreateErrorMessage: (value: unknown) => String(value) }));
let sequence = 0;
const job = (status: NotebookSetupJob['status']): NotebookSetupJob => ({
  notebookId: 'nb', jobId: 'setup', templateId: 'template', overwriteExisting: false,
  status, stage: 'indexing', revision: ++sequence, runId: 'run', message: null, updatedAt: sequence,
  executionRequested: true,
  report: { totalFiles: 3, writtenFiles: 1, skippedExistingFiles: 2, failedFiles: 0, firstFailurePath: null, firstFailureReason: null },
});
let root: Root;
const notices = () => getActionableNotices();
beforeEach(() => {
  localStorage.clear();
  replaceNotebookSetupSnapshot({ revision: ++sequence, jobs: [] });
  useNoteStore.setState({ selectedNotebook: { id: 'nb', name: 'Notebook', path: '/nb', createdAt: 0, updatedAt: 0, isDefault: false } });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const notice of notices()) clearActionableNotice(notice.id);
  vi.restoreAllMocks();
});
const mount = () => act(async () => root.render(<><NotebookSetupNoticeHost /><NotebookSetupResultNotices /></>));
describe('notebook setup notifications', () => {
  it('replaces a running notice with a dismissible completion result without skipped-file duplication', async () => {
    await mount();
    await act(async () => upsertNotebookSetupJob(job('running')));
    expect(notices().map(item => item.id)).toEqual(['notebook-setup-running:setup']);
    await act(async () => upsertNotebookSetupJob(job('completed')));
    expect(notices().map(item => item.id)).toEqual(['notebook-setup-result:nb']);
    await act(async () => runActionableNoticeAction('notebook-setup-result:nb', 'hide'));
    expect(notices()).toHaveLength(0);
  });
  it.each([0, 1])('uses the current report when a new run completes with %i skipped files', async (skipped) => {
    await mount();
    await act(async () => upsertNotebookSetupJob(job('running')));
    await act(async () => upsertNotebookSetupJob(job('completed')));
    expect(notices().some(item => item.id === 'notebook-setup-result:nb')).toBe(true);
    await act(async () => upsertNotebookSetupJob({ ...job('running'), runId: 'second-run' }));
    const completed = { ...job('completed'), runId: 'second-run' };
    completed.report = { ...completed.report!, writtenFiles: 3 - skipped, skippedExistingFiles: skipped };
    await act(async () => upsertNotebookSetupJob(completed));
    const result = notices().find(item => item.id === 'notebook-setup-result:nb');
    if (skipped === 0) expect(result).toBeUndefined();
    else expect(result?.revision).toBe(`${completed.updatedAt}:2:1`);
  });

  it('keeps a dismissed failure hidden across remount and shows a new run', async () => {
    await act(async () => upsertNotebookSetupJob(job('failed')));
    await mount();
    await act(async () => dismissActionableNotice('notebook-setup:nb'));
    await act(async () => root.render(null));
    await mount();
    expect(notices()).toHaveLength(0);
    await act(async () => upsertNotebookSetupJob({ ...job('failed'), runId: 'next-run' }));
    expect(notices().map(item => item.id)).toEqual(['notebook-setup:nb']);
  });
  it('retries a failed setup and updates the shared job state', async () => {
    const start = vi.spyOn(notebooks, 'startTemplateSetup');
    await act(async () => upsertNotebookSetupJob(job('failed')));
    await mount();
    // The backend revision must be newer than the failed event.
    start.mockResolvedValue(job('running'));
    await act(async () => runActionableNoticeAction('notebook-setup:nb', 'retry'));
    expect(start).toHaveBeenCalledWith('nb', true);
    expect(notices().map(item => item.id)).toEqual(['notebook-setup-running:setup']);
  });
});
