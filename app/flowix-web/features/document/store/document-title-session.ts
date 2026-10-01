import { getDocumentSession, findDocumentSession, releaseDocumentSession } from './document-runtime-session';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { enqueueDocumentCommit } from './document-commit-queue';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  isFileDisplayIdLive,
  pinFileDisplayId,
  subscribeFileDisplayRelease,
} from '@/lib/file-display-registry';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';

export interface MemoTitleSessionSnapshot {
  filename: string;
  draft: string;
  saving: boolean;
  error: string | null;
  /** Uncommitted input kept separately from the filename-backed title. */
  recoverableDraft?: string | null;
}

export interface RenameDocumentTitleOptions {
  expectBodyMutation?: boolean;
}

export type RenameDocumentTitle = (
  title: string,
  expectedFilename: string,
  options?: RenameDocumentTitleOptions,
) => Promise<string | null>;

interface PendingTitleRename {
  title: string;
  renameTitle: RenameDocumentTitle;
  options?: RenameDocumentTitleOptions;
}

export interface MemoTitleSession extends MemoTitleSessionSnapshot {
  displayId: string;
  renameTitle: RenameDocumentTitle;
  snapshot: MemoTitleSessionSnapshot;
  subscribers: Set<() => void>;
  pendingTitle: PendingTitleRename | null;
  inFlight: Promise<boolean> | null;
  /** Escape/empty blur cannot abort a rename already accepted by the backend. */
  restoreDraftAfterFlight: boolean;
  revision: number;
  protectedRevision: number;
}

const listeners = new Set<(displayId: string, edited: boolean) => void>();
export function subscribeTitleChanges(listener: (displayId: string, edited: boolean) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getTitleDraft(displayId: string) {
  const session = findDocumentSession(displayId)?.title;
  if (!session) {
    const restored = findDocumentSession(displayId)?.restoredTitle;
    return restored ? { ...restored, revision: 0 } : null;
  }
  if (session.draft === displayTitleFromFilename(session.filename)) {
    const recovered = findDocumentSession(displayId)?.restoredTitle;
    return recovered ? { ...recovered, revision: session.revision } : null;
  }
  return { draft: session.draft, filename: session.filename, revision: session.revision };
}
export function isTitleSaving(displayId: string): boolean { return findDocumentSession(displayId)?.title?.saving ?? false; }
export function hasTitleDraft(displayId: string): boolean { return getTitleDraft(displayId) !== null; }
export function isTitleProtected(displayId: string): boolean {
  const session = findDocumentSession(displayId)?.title;
  return !session || !hasTitleDraft(displayId) || session.protectedRevision >= session.revision;
}
export function markTitleProtected(displayId: string, revision: number) {
  const session = findDocumentSession(displayId)?.title;
  if (session) session.protectedRevision = Math.max(session.protectedRevision, revision);
}
export function flushTitleDraft(displayId: string): Promise<boolean> {
  const session = findDocumentSession(displayId)?.title;
  return session ? commitMemoTitle(displayId, session) : Promise.resolve(true);
}
export function restoreTitleDraft(displayId: string, title: { draft: string; filename: string }) {
  const session = findDocumentSession(displayId)?.title;
  if (session && session.draft !== displayTitleFromFilename(session.filename)) return;
  // Recovery preserves input, but must never rename a file or replace its
  // displayed title without a new editing action from the user.
  if (title.draft === displayTitleFromFilename(session?.filename ?? title.filename)) return;
  getDocumentSession(displayId).restoredTitle = title;
  if (session) notify(session);
}


// Async rename callbacks can enqueue another request while a write is in flight.
function pendingRename(session: MemoTitleSession): PendingTitleRename | null {
  return session.pendingTitle;
}

function discardSession(displayId: string, session: MemoTitleSession): void {
  if (findDocumentSession(displayId)?.title !== session) return;
  session.subscribers.clear();
  getDocumentSession(displayId).title = undefined;
  releaseDocumentSession(displayId);
}

subscribeFileDisplayRelease((displayId) => {
  const session = findDocumentSession(displayId)?.title;
  if (!session) return;
  if (session.error) {
    if (session.protectedRevision >= session.revision) discardSession(displayId, session);
    return;
  }
  const titleChanged = normalizeTitle(session.draft)
    !== normalizeTitle(displayTitleFromFilename(session.filename));
  if (session.pendingTitle !== null || titleChanged) {
    void commitMemoTitle(displayId, session, { restoreEmpty: false });
  } else if (!session.inFlight) {
    discardSession(displayId, session);
  }
});

function notify(session: MemoTitleSession) {
  if (session.error && session.error !== session.snapshot.error) toast.error(session.error);
  session.snapshot = {
    filename: session.filename,
    draft: session.draft,
    saving: session.saving,
    error: session.error,
    recoverableDraft: findDocumentSession(session.displayId)?.restoredTitle?.draft ?? null,
  };
  for (const subscriber of session.subscribers) subscriber();
  for (const listener of listeners) listener(session.displayId, false);
}

function normalizeTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().replace(/\.(md|markdown)$/i, '').trim();
}

function updateSnapshot(
  session: MemoTitleSession,
  patch: Partial<Pick<MemoTitleSession, 'filename' | 'draft' | 'saving' | 'error'>>,
) {
  if (patch.draft !== undefined && patch.draft !== session.draft) session.revision += 1;
  Object.assign(session, patch);
  notify(session);
}

function getOrCreateSession(
  displayId: string,
  filename: string,
  renameTitle: RenameDocumentTitle,
): MemoTitleSession {
  const existing = findDocumentSession(displayId)?.title;
  if (existing) return existing;

  const session: MemoTitleSession = {
    displayId,
    renameTitle,
    filename,
    draft: displayTitleFromFilename(filename),
    saving: false,
    error: null,
    subscribers: new Set(),
    pendingTitle: null,
    inFlight: null,
    restoreDraftAfterFlight: false,
    revision: 0,
    protectedRevision: -1,
    snapshot: {
      filename,
      draft: displayTitleFromFilename(filename),
      saving: false,
      error: null,
    },
  };
  const restored = findDocumentSession(displayId)?.restoredTitle;
  session.snapshot.recoverableDraft = restored?.draft ?? null;
  getDocumentSession(displayId).title = session;
  return session;
}

function observeFilename(session: MemoTitleSession, filename: string) {
  if (!filename || filename === session.filename) return;
  const currentTitle = displayTitleFromFilename(session.filename);
  const hasLocalDraft = normalizeTitle(session.draft) !== normalizeTitle(currentTitle);
  if (session.inFlight || session.pendingTitle !== null || hasLocalDraft) return;
  updateSnapshot(session, {
    filename,
    draft: displayTitleFromFilename(filename),
    error: null,
  });
}

async function runQueue(displayId: string, session: MemoTitleSession): Promise<boolean> {
  if (session.inFlight) return session.inFlight;

  const releaseDisplayPin = pinFileDisplayId(displayId);
  const run = (async (): Promise<boolean> => {
    updateSnapshot(session, { saving: true, error: null });
    let succeeded = true;
    try {
      while (session.pendingTitle !== null) {
        let request = session.pendingTitle;
        let didRun = false;
        let renamedFilename: string | null = null;
        let failure: unknown;
        await enqueueDocumentCommit('md:' + displayId, 'title', async () => {
          if (!session.pendingTitle) return true;
          request = session.pendingTitle; session.pendingTitle = null; didRun = true;
          try {
            renamedFilename = request.options === undefined
              ? await request.renameTitle(request.title, session.filename)
              : await request.renameTitle(request.title, session.filename, request.options);
            return renamedFilename !== null;
          } catch (error) { failure = error; return false; }
        });
        if (!didRun) break;
        if (failure) throw failure;
        if (!renamedFilename) {
          succeeded = false;
          session.pendingTitle = null;
          rejectTitle(session, translate(getCurrentAppLanguage(), 'document.save.titleFailed'));
          break;
        }
        session.filename = renamedFilename;

        const confirmedTitle = displayTitleFromFilename(session.filename);
        const queued = pendingRename(session);
        // A second commit may have queued the filename that this request just
        // produced. Coalesce it instead of issuing a redundant rename.
        if (
          queued !== null
          && normalizeTitle(queued.title) === normalizeTitle(confirmedTitle)
          && !queued.options?.expectBodyMutation
        ) {
          session.pendingTitle = null;
        }

        if (session.pendingTitle === null) {
          if (session.restoreDraftAfterFlight) {
            session.draft = confirmedTitle;
            session.restoreDraftAfterFlight = false;
          } else if (normalizeTitle(session.draft) === normalizeTitle(request.title)) {
            session.draft = confirmedTitle;
          }
        }
        notify(session);
      }
    } catch (error) {
      session.pendingTitle = null;
      const message = error instanceof Error ? error.message : String(error);
      rejectTitle(session, message.includes('FILE_EXISTS')
        ? translate(getCurrentAppLanguage(), 'memo.fileTree.nameConflict')
        : message);
      succeeded = false;
    } finally {
      session.inFlight = null;
      if (session.saving) updateSnapshot(session, { saving: false });
      releaseDisplayPin();
      if (!isFileDisplayIdLive(displayId) && !hasTitleDraft(displayId)) discardSession(displayId, session);
    }
    return succeeded;
  })();

  session.inFlight = run;
  return run;
}

function rejectTitle(session: MemoTitleSession, message: string) {
  const confirmedTitle = displayTitleFromFilename(session.filename);
  if (!session.restoreDraftAfterFlight && session.draft !== confirmedTitle) {
    getDocumentSession(session.displayId).restoredTitle = {
      draft: session.draft, filename: session.filename,
    };
  }
  session.restoreDraftAfterFlight = false;
  updateSnapshot(session, { draft: confirmedTitle, error: message, saving: false });
}

export function useMemoTitleSession(
  displayId: string,
  filename: string,
  renameTitle: RenameDocumentTitle,
) {
  const session = useMemo(
    () => getOrCreateSession(displayId, filename, renameTitle),
    [displayId],
  );
  const subscribe = useCallback((listener: () => void) => {
    session.subscribers.add(listener);
    return () => session.subscribers.delete(listener);
  }, [session]);
  const getSnapshot = useCallback(() => session.snapshot, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    observeFilename(session, filename);
  }, [filename, session]);

  useEffect(() => () => {
    void commitMemoTitle(displayId, session, { restoreEmpty: false });
  }, [displayId, session]);

  return {
    snapshot,
    setDraft(value: string) {
      // A fresh edit supersedes a prior Escape/empty-blur restoration request.
      session.renameTitle = renameTitle;
      session.restoreDraftAfterFlight = false;
      const changed = session.draft !== value;
      if (changed) {
        getDocumentSession(displayId).restoredTitle = undefined;
        for (const listener of listeners) listener(displayId, true);
      }
      updateSnapshot(session, { draft: value, error: null });
    },
    recoverDraft() {
      const recovered = findDocumentSession(displayId)?.restoredTitle;
      if (!recovered) return;
      getDocumentSession(displayId).restoredTitle = undefined;
      session.renameTitle = renameTitle;
      for (const listener of listeners) listener(displayId, true);
      updateSnapshot(session, { draft: recovered.draft, error: null });
    },
    commit(options?: RenameDocumentTitleOptions) {
      session.renameTitle = renameTitle;
      return commitMemoTitle(displayId, session, { restoreEmpty: true, options });
    },
    cancel() {
      getDocumentSession(displayId).restoredTitle = undefined;
      session.pendingTitle = null;
      session.restoreDraftAfterFlight = session.inFlight !== null;
      updateSnapshot(session, {
        draft: displayTitleFromFilename(session.filename),
        error: null,
      });
    },
  };
}

async function commitMemoTitle(
  displayId: string,
  session: MemoTitleSession,
  options: { restoreEmpty: boolean; options?: RenameDocumentTitleOptions } = { restoreEmpty: true },
): Promise<boolean> {
  const title = normalizeTitle(session.draft);
  const confirmedTitle = displayTitleFromFilename(session.filename);
  if (!title) {
    if (options.restoreEmpty) updateSnapshot(session, { error: translate(getCurrentAppLanguage(), 'document.save.titleEmpty') });
    return false;
  }
  if (title === normalizeTitle(confirmedTitle)) {
    if (!session.inFlight) {
      session.pendingTitle = null;
      session.restoreDraftAfterFlight = false;
      updateSnapshot(session, { draft: confirmedTitle });
      return true;
    }
  }

  // Even if the title matches the currently confirmed filename, an in-flight
  // request may still rename it. Queue this latest intent so it runs after the
  // active request instead of returning against stale session.filename.
  session.pendingTitle = {
    title,
    renameTitle: session.renameTitle,
    options: options.options,
  };
  return runQueue(displayId, session);
}
