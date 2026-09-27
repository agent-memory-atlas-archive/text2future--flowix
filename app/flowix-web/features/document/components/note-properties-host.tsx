'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { memos } from '@platform/tauri/client';
import { memoDocumentOperations } from '@features/document/use-cases/memo-document-operations';
import { useMemoStore } from '@features/memo/store/memo-store';
import { NotePropertiesDialog } from '@features/document/components/note-properties-dialog';
import {
  applyLoadedDocumentContent,
  captureLatestDocumentContent,
  getDocumentBuffer,
  hasDocumentUnsavedChanges,
} from '@features/document/store/document-session-service';
import { documentIdentityFromFile } from '@features/document/store/document-identity';
import type { DocumentIdentity } from '@features/document/store/document-identity';

interface NotePropertiesTarget {
  memoId: string;
  identity: DocumentIdentity;
  content: string;
  /** The content against which the global save performs its CAS check. */
  expectedContent: string;
}

const logger = createLogger('note-properties-host');

/**
 * Application-level owner for note properties.
 *
 * Properties belong to a note, but their editor is independent of the
 * currently-visible document surface. Keeping the host above DocumentContainer
 * lets a sidebar action edit any note without navigating to it first.
 */
export function NotePropertiesHost() {
  const { t } = useI18n();
  const [target, setTarget] = useState<NotePropertiesTarget | null>(null);
  const requestSequence = useRef(0);

  const close = useCallback(() => {
    requestSequence.current += 1;
    setTarget(null);
  }, []);

  const handleOpen = useCallback((event: Event) => {
    const memoId = (event as CustomEvent<{ memoId?: string }>).detail?.memoId?.trim();
    if (!memoId) return;

    const sequence = ++requestSequence.current;
    setTarget(null);

    void (async () => {
      try {
        const session = await memos.openMemoSession(memoId);
        if (sequence !== requestSequence.current) return;
        if (!session) {
          toast.error(t('document.load.failed'));
          return;
        }

        const identity = documentIdentityFromFile(session.fileIdentity);
        // Resolve the memo's current path first, then publish any live editor
        // bytes through the same path-based identity used by its surfaces.
        captureLatestDocumentContent(identity);

        const hasDraft = hasDocumentUnsavedChanges(identity);
        const buffer = hasDraft ? getDocumentBuffer(identity) : null;
        setTarget({
          memoId,
          identity,
          content: buffer?.content ?? session.content,
          expectedContent: buffer?.lastSavedContent ?? session.content,
        });
      } catch (error) {
        if (sequence !== requestSequence.current) return;
        logger.warn('failed to load note properties', { error });
        toast.error(t('document.load.failed'));
      }
    })();
  }, [t]);

  useEffect(() => {
    window.addEventListener('flowix:open-note-properties', handleOpen);
    return () => window.removeEventListener('flowix:open-note-properties', handleOpen);
  }, [handleOpen]);

  const handleSave = useCallback(async (nextContent: string) => {
    if (!target) return;

    let result: Awaited<ReturnType<typeof memoDocumentOperations.write>>;
    try {
      // Write by memo id rather than by the currently selected notebook/path.
      // The backend resolves the current path and performs the CAS check.
      result = await memoDocumentOperations.write({
        memoId: target.memoId,
        content: nextContent,
        expectedContent: target.expectedContent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('document.save.failed', { message }));
      throw error;
    }

    if (result.status !== 'saved') {
      toast.error(t('document.save.casRefused'));
      throw new Error('Note properties save was refused');
    }

    // Reconcile any mounted editor sharing this memo's buffer without making
    // this target the current document when it was opened from another row.
    applyLoadedDocumentContent(
      target.identity,
      result.path,
      result.content,
      { preservePending: false, setAsCurrent: false },
    );
    useMemoStore.getState().triggerRefresh();
  }, [t, target]);

  if (!target) return null;

  return (
    <NotePropertiesDialog
      open
      content={target.content}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onSave={handleSave}
    />
  );
}
