import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  isFileDisplayIdLive,
  pinFileDisplayId,
  subscribeFileDisplayRelease,
} from '@features/workspace/store/file-display-store';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';

export const TITLE_SAVE_DEBOUNCE_MS = 1500;

export interface MemoTitleSessionSnapshot {
  filename: string;
  draft: string;
  saving: boolean;
  error: string | null;
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

interface MemoTitleSession extends MemoTitleSessionSnapshot {
  renameTitle: RenameDocumentTitle;
  snapshot: MemoTitleSessionSnapshot;
  subscribers: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  pendingTitle: PendingTitleRename | null;
  inFlight: Promise<boolean> | null;
  /** Escape/empty blur cannot abort a rename already accepted by the backend. */
  restoreDraftAfterFlight: boolean;
  revision: number;
}

const sessions = new Map<string, MemoTitleSession>();

function discardSession(displayId: string, session: MemoTitleSession): void {
  if (sessions.get(displayId) !== session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.subscribers.clear();
  sessions.delete(displayId);
}

subscribeFileDisplayRelease((displayId) => {
  const session = sessions.get(displayId);
  if (!session) return;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (session.error) {
    discardSession(displayId, session);
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
  session.snapshot = {
    filename: session.filename,
    draft: session.draft,
    saving: session.saving,
    error: session.error,
  };
  session.revision += 1;
  for (const subscriber of session.subscribers) subscriber();
}

function normalizeTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().replace(/\.(md|markdown)$/i, '').trim();
}

function updateSnapshot(
  session: MemoTitleSession,
  patch: Partial<Pick<MemoTitleSession, 'filename' | 'draft' | 'saving' | 'error'>>,
) {
  Object.assign(session, patch);
  notify(session);
}

function getOrCreateSession(
  displayId: string,
  filename: string,
  renameTitle: RenameDocumentTitle,
): MemoTitleSession {
  const existing = sessions.get(displayId);
  if (existing) return existing;

  const session: MemoTitleSession = {
    renameTitle,
    filename,
    draft: displayTitleFromFilename(filename),
    saving: false,
    error: null,
    subscribers: new Set(),
    timer: null,
    pendingTitle: null,
    inFlight: null,
    restoreDraftAfterFlight: false,
    revision: 0,
    snapshot: {
      filename,
      draft: displayTitleFromFilename(filename),
      saving: false,
      error: null,
    },
  };
  sessions.set(displayId, session);
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
        const request = session.pendingTitle;
        session.pendingTitle = null;
        const rename = request.options === undefined
          ? request.renameTitle(request.title, session.filename)
          : request.renameTitle(request.title, session.filename, request.options);
        const renamedFilename = await rename;
        if (!renamedFilename) {
          succeeded = false;
          session.pendingTitle = null;
          session.draft = displayTitleFromFilename(session.filename);
          session.restoreDraftAfterFlight = false;
          notify(session);
          break;
        }
        session.filename = renamedFilename;

        const confirmedTitle = displayTitleFromFilename(session.filename);
        // A second commit may have queued the filename that this request just
        // produced. Coalesce it instead of issuing a redundant rename.
        if (
          session.pendingTitle !== null
          && normalizeTitle(session.pendingTitle.title) === normalizeTitle(confirmedTitle)
          && !session.pendingTitle.options?.expectBodyMutation
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
      const draft = session.restoreDraftAfterFlight
        ? displayTitleFromFilename(session.filename)
        : session.draft;
      session.restoreDraftAfterFlight = false;
      updateSnapshot(session, { draft, error: message, saving: false });
      toast.error(message);
      succeeded = false;
    } finally {
      session.inFlight = null;
      if (session.saving) updateSnapshot(session, { saving: false });
      releaseDisplayPin();
      if (!isFileDisplayIdLive(displayId)) discardSession(displayId, session);
    }
    return succeeded;
  })();

  session.inFlight = run;
  return run;
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

  return {
    snapshot,
    setDraft(value: string) {
      // A fresh edit supersedes a prior Escape/empty-blur restoration request.
      session.renameTitle = renameTitle;
      session.restoreDraftAfterFlight = false;
      updateSnapshot(session, { draft: value, error: null });
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = null;
        void commitMemoTitle(displayId, session, { restoreEmpty: false });
      }, TITLE_SAVE_DEBOUNCE_MS);
    },
    commit(options?: RenameDocumentTitleOptions) {
      session.renameTitle = renameTitle;
      return commitMemoTitle(displayId, session, { restoreEmpty: true, options });
    },
    cancel() {
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
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
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;

  const title = normalizeTitle(session.draft);
  const confirmedTitle = displayTitleFromFilename(session.filename);
  if (!title) {
    if (options.restoreEmpty) {
      session.pendingTitle = null;
      session.restoreDraftAfterFlight = session.inFlight !== null;
      updateSnapshot(session, { draft: confirmedTitle });
    }
    return true;
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
