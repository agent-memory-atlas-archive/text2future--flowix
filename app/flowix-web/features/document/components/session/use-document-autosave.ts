import { useCallback, useEffect, useRef } from 'react';
import { installDocumentShutdown } from '../../store/document-shutdown';
import { getDocumentSession, listDocumentSessions } from '../../store/document-runtime-session';
import { commitDocumentSession, scheduleDocumentSessionSave, recordDocumentEdit,
  registerDocumentCapture, registerDocumentPersistence, prepareDocumentLeave, discardDocumentDraft } from '../../store/document-session-service';
import { cancelDocumentCapture } from '../../store/document-commit-queue';
import { documentIdentityKey, type DocumentIdentity } from '../../store/document-identity';
import { countTextUnits, extractBodyContent } from './document-utils';
import type { DocumentContainerState } from './types';

interface UseDocumentAutosaveOptions {
  filePath: string;
  hostId?: string;
  isActive?: () => boolean;
  getCurrentFilePath?: () => string;
  identity: DocumentIdentity;
  memoId: string | null;
  isExternalDocument: boolean;
  externalScopePath: string | null;
  setState: React.Dispatch<React.SetStateAction<DocumentContainerState>>;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
  flushPendingContent?: () => string | null;
  isolatedSession?: boolean;
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
  const mounted = useRef(true);
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
    if (mounted.current) {
      const charCount = countTextUnits(extractBodyContent(content));
      live.current.setState(previous => previous.fullContent === content ? previous : ({
        ...previous, fullContent: content, charCount, tokenCount: Math.ceil(charCount / 4),
      }));
    }
    if (edit.changed) handleDirty();
  }, [identity, handleDirty]);
  const flushDocument = useCallback(async (_options?: { silent?: boolean }) =>
    prepareDocumentLeave(identity, identity.path, live.current.externalScopePath), [identity]);
  const discardDocument = useCallback(() => {
    clearSaveTimer(); discardDocumentDraft(identity);
  }, [identity, clearSaveTimer]);

  useEffect(() => {
    mounted.current = true;
    installDocumentShutdown(); installVisibilityCapture();
    const stopCapture = registerDocumentCapture(identity,
      () => live.current.flushPendingContent?.() ?? null,
      live.current.hostId, () => live.current.isActive?.() !== false);
    const stopPersistence = registerDocumentPersistence(identity, {
      capture: () => {}, path: () => identity.path, scopePath: live.current.externalScopePath,
    });
    return () => {
      mounted.current = false;
      commitDocumentSession(identity);
      stopCapture(); stopPersistence();
    };
  }, [identity]);
  return { clearSaveTimer, flushDocument, discardDocument, handleChange, handleDirty };
}
