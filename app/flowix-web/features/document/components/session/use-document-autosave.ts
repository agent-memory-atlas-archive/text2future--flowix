import { useCallback, useEffect, useRef } from 'react';
import { getDocumentSession, listDocumentSessions } from '../../store/document-runtime-session';
import { commitDocumentSession, scheduleDocumentSessionSave, recordDocumentEdit,
  registerDocumentCapture, registerDocumentPersistence, prepareDocumentLeave, discardDocumentDraft } from '../../store/document-session-service';
import { cancelDocumentCapture } from '../../store/document-commit-queue';
import { documentIdentityKey, type DocumentIdentity } from '../../store/document-identity';

interface UseDocumentAutosaveOptions {
  hostId?: string;
  isActive?: () => boolean;
  identity: DocumentIdentity;
  externalScopePath: string | null;
  flushPendingContent?: () => string | null;
}


let visibilityInstalled = false;
function installVisibilityCapture() {
  if (visibilityInstalled) return;
  visibilityInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const session of listDocumentSessions()) {
      if (session.adapters.size) commitDocumentSession(session.identity);
    }
  });
}

/** Views publish input. The session owns scheduling, paths and disk writes. */
export function useDocumentAutosave(options: UseDocumentAutosaveOptions) {
  const live = useRef(options); live.current = options;
  const identity = getDocumentSession(options.identity).identity;
  const key = documentIdentityKey(identity);
  const clearSaveTimer = useCallback(() => cancelDocumentCapture(key), [key]);
  const handleDirty = useCallback(() => {
    if (live.current.isActive?.() === false) return;
    scheduleDocumentSessionSave(identity);
  }, [identity]);
  const handleChange = useCallback((content: string) => {
    if (live.current.isActive?.() === false && !getDocumentSession(identity).capturing) return;
    const edit = recordDocumentEdit(identity, content);
    if (edit.changed) handleDirty();
  }, [identity, handleDirty]);
  const flushDocument = useCallback(async (_options?: { silent?: boolean }) =>
    prepareDocumentLeave(identity, identity.path, live.current.externalScopePath), [identity]);
  const discardDocument = useCallback(() => {
    clearSaveTimer(); discardDocumentDraft(identity);
  }, [identity, clearSaveTimer]);

  useEffect(() => {
    installVisibilityCapture();
    const stopCapture = registerDocumentCapture(identity,
      () => live.current.flushPendingContent?.() ?? null,
      live.current.hostId, () => live.current.isActive?.() !== false);
    const stopPersistence = registerDocumentPersistence(identity, {
      capture: () => {}, path: () => identity.path, scopePath: live.current.externalScopePath,
    });
    return () => {
      commitDocumentSession(identity);
      stopCapture(); stopPersistence();
    };
  }, [identity]);
  return { clearSaveTimer, flushDocument, discardDocument, handleChange, handleDirty };
}
