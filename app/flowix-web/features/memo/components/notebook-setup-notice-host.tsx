'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n';
import { subscribeNotebookSetupJobs, getNotebookSetupJobs, upsertNotebookSetupJob, useNotebookSetupJob } from '@features/memo/store/notebook-setup-store';
import {
  clearActionableNotice,
  dismissActionableNotice,
  upsertActionableNotice,
} from '@features/notifications/actionable-notice-store';
import { notebooks as notebooksClient, type NotebookSetupJob } from '@platform/tauri/client';
import { notebookCreateErrorMessage } from '@platform/tauri/errors';
import { useNoteStore } from '@features/memo/store/note-store';

function readDismissedSetupKey(notebookId: string | undefined): string | null {
  if (!notebookId) return null;
  try { return window.localStorage.getItem(`flowix:notebook-setup-dismissed:${notebookId}`); }
  catch { return null; }
}

function sameSetupRun(left: NotebookSetupJob | null, right: NotebookSetupJob | null): boolean {
  return Boolean(left && right && left.notebookId === right.notebookId
    && left.jobId === right.jobId && left.runId === right.runId);
}

const EMPTY_JOBS: ReturnType<typeof getNotebookSetupJobs> = [];

export function NotebookSetupNoticeHost() {
  const { t } = useI18n();
  const jobs = useSyncExternalStore(
    subscribeNotebookSetupJobs,
    getNotebookSetupJobs,
    () => EMPTY_JOBS,
  );
  const activeNoticeIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const activeJobs = jobs.filter((job) => job.status === 'running');
    const nextIds = new Set(activeJobs.map((job) => `notebook-setup-running:${job.jobId}`));

    for (const noticeId of activeNoticeIdsRef.current) {
      if (!nextIds.has(noticeId)) clearActionableNotice(noticeId);
    }

    for (const job of activeJobs) {
      const noticeId = `notebook-setup-running:${job.jobId}`;
      const title = job.stage === 'preparing'
        ? t('notebook.setup.preparingTemplate')
        : job.stage === 'indexing'
          ? t('notebook.setup.indexing')
          : t('notebook.setup.applyingTemplate');

      upsertActionableNotice({
        id: noticeId,
        priority: 80,
        tone: 'neutral',
        width: 'narrow',
        title,
        leadingIcon: 'loading',
        revision: `${job.jobId}:${job.runId || `revision:${job.revision}`}`,
        dismissible: true,
        actions: [{
          id: 'hide',
          label: t('notebook.setup.hide'),
          variant: 'outline',
          run: () => dismissActionableNotice(noticeId),
        }],
      });
    }

    activeNoticeIdsRef.current = nextIds;
  }, [jobs, t]);

  useEffect(() => () => {
    for (const noticeId of activeNoticeIdsRef.current) clearActionableNotice(noticeId);
    activeNoticeIdsRef.current.clear();
  }, []);

  return null;
}

/** Selected-notebook results share notification ownership with running jobs.
 * Mounted with the main notebook services to retain the original window scope. */
export function NotebookSetupResultNotices() {
  const { t } = useI18n();
  const selectedNotebook = useNoteStore((value) => value.selectedNotebook);
  const notebookSetupJob = useNotebookSetupJob(selectedNotebook?.id);
  // Track the completion we observed; read its report from the current store job.
  const [observedCompletion, setObservedCompletion] = useState<NotebookSetupJob | null>(null);
  const notebookSetupNotice = notebookSetupJob?.status === 'completed' && sameSetupRun(observedCompletion, notebookSetupJob)
    ? notebookSetupJob.report : null;
  const [sessionDismissal, setSessionDismissal] = useState<{ notebookId: string; key: string } | null>(null);
  const persistedDismissal = useMemo(() => readDismissedSetupKey(selectedNotebook?.id), [selectedNotebook?.id]);
  const dismissedNotebookSetupKey = sessionDismissal?.notebookId === selectedNotebook?.id
    ? sessionDismissal?.key : persistedDismissal;
  const previousNotebookSetupJobRef = useRef(notebookSetupJob);
  const activeSetupNoticeIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousNotebookSetupJobRef.current;
    if (!sameSetupRun(previous, notebookSetupJob) || notebookSetupJob?.status !== 'completed') {
      setObservedCompletion(null);
    }
    if (previous?.status === 'running' && notebookSetupJob?.status === 'completed'
      && sameSetupRun(previous, notebookSetupJob)) {
      setObservedCompletion(notebookSetupJob);
    }
    previousNotebookSetupJobRef.current = notebookSetupJob;
  }, [notebookSetupJob]);

  const retryNotebookSetup = useCallback(async (notebookId: string) => {
    try {
      const job = await notebooksClient.startTemplateSetup(notebookId, true);
      if (job && useNoteStore.getState().selectedNotebook?.id === notebookId) {
        upsertNotebookSetupJob(job);
      }
    } catch (error) {
      throw new Error(notebookCreateErrorMessage(error, t));
    }
  }, [t]);

  const setupJobNoticeKey = notebookSetupJob
    ? `${notebookSetupJob.jobId}:${notebookSetupJob.runId || notebookSetupJob.revision}:${notebookSetupJob.status}`
    : null;
  const notebookSetupNoticeDismissed = setupJobNoticeKey !== null
    && dismissedNotebookSetupKey === setupJobNoticeKey;
  const dismissNotebookSetupNotice = useCallback(() => {
    if (!setupJobNoticeKey || !notebookSetupJob) return;
    setSessionDismissal({ notebookId: notebookSetupJob.notebookId, key: setupJobNoticeKey });
    try {
      window.localStorage.setItem(
        `flowix:notebook-setup-dismissed:${notebookSetupJob.notebookId}`,
        setupJobNoticeKey,
      );
    } catch {
      // Keep the notice dismissible for this session when persistent storage is unavailable.
    }
  }, [notebookSetupJob, setupJobNoticeKey]);

  useEffect(() => {
    const job = notebookSetupJob;
    const previousId = activeSetupNoticeIdRef.current;
    if (job?.status !== 'partial' && job?.status !== 'failed') {
      if (previousId) clearActionableNotice(previousId);
      activeSetupNoticeIdRef.current = null;
      return;
    }
    const noticeId = `notebook-setup:${job.notebookId}`;
    if (previousId && previousId !== noticeId) clearActionableNotice(previousId);
    activeSetupNoticeIdRef.current = noticeId;
    if (notebookSetupNoticeDismissed) return;

    const failedFiles = job.report?.failedFiles ?? 0;
    const summary = failedFiles > 0
      ? t('notebook.setup.partialSummary', {
        written: job.report?.writtenFiles ?? 0,
        existing: job.report?.skippedExistingFiles ?? 0,
        failed: failedFiles,
        path: job.report?.firstFailurePath ?? '',
        reason: job.report?.firstFailureReason ?? '',
      })
      : null;
    const details = [
      summary,
      job.message ? notebookCreateErrorMessage(job.message, t) : null,
    ].filter(Boolean).join('\n');
    upsertActionableNotice({
      id: noticeId,
      priority: 50,
      tone: 'error',
      title: `${selectedNotebook?.name ?? t('notebook.create.title')} · ${t(job.status === 'partial' ? 'notebook.setup.partial' : 'notebook.setup.failed')}`,
      message: details || undefined,
      revision: `${job.updatedAt}:${job.status}:${failedFiles}:${job.message ?? ''}`,
      dismissible: true,
      onDismiss: dismissNotebookSetupNotice,
      actions: [{
        id: 'retry',
        label: t('notebook.setup.retry'),
        variant: 'default',
        run: () => retryNotebookSetup(job.notebookId),
      }],
    });
  }, [dismissNotebookSetupNotice, notebookSetupJob, notebookSetupNoticeDismissed, retryNotebookSetup, selectedNotebook?.name, t]);

  useEffect(() => {
    const job = notebookSetupJob;
    if (!job || job.status !== 'completed' || !notebookSetupNotice
      || notebookSetupNotice.skippedExistingFiles <= 0) return;
    const noticeId = `notebook-setup-result:${job.notebookId}`;
    upsertActionableNotice({
      id: noticeId,
      priority: 40,
      tone: 'neutral',
      dismissible: true,
      title: t('notebook.setup.completedWithSkips', {
        written: notebookSetupNotice.writtenFiles,
        existing: notebookSetupNotice.skippedExistingFiles,
      }),
      revision: `${job.updatedAt}:${notebookSetupNotice.writtenFiles}:${notebookSetupNotice.skippedExistingFiles}`,
      actions: [{
        id: 'hide',
        label: t('notebook.setup.hide'),
        variant: 'outline',
        run: () => dismissActionableNotice(noticeId),
      }],
    });
    return () => clearActionableNotice(noticeId);
  }, [notebookSetupJob, notebookSetupNotice, t]);

  useEffect(() => () => {
    if (activeSetupNoticeIdRef.current) clearActionableNotice(activeSetupNoticeIdRef.current);
  }, []);

  return null;
}
