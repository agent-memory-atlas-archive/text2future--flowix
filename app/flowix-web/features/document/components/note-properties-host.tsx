'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { notes } from '@platform/tauri/client';
import { memoDocumentOperations } from '@features/document/use-cases/memo-document-operations';
import { useNoteStore } from '@features/memo/store/note-store';
import { NotePropertiesDialog } from '@features/document/components/note-properties-dialog';
import {
  applyLoadedDocumentContent,
  captureLatestDocumentContent,
  getDocumentBuffer,
  hasDocumentUnsavedChanges,
} from '@features/document/store/document-session-service';
import { documentIdentityFromFile } from '@features/document/store/document-identity';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';

interface NotePropertiesTarget {
  path: string;
  scopePath: string | null;
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
    const detail = (event as CustomEvent<{ path?: string; scopePath?: string | null }>).detail;
    const path = detail?.path?.trim() || null;
    if (!path) return;

    const sequence = ++requestSequence.current;
    setTarget(null);

    void (async () => {
      try {
        if (sequence !== requestSequence.current) return;
        const targetPath = path;
        const content = await notes.readDocument(targetPath);
        if (content === null) {
          toast.error(t('document.load.failed'));
          return;
        }
        const identity = documentIdentityFromFile(
          ensureFileDisplayIdentity(targetPath),
        );
        // Resolve the memo's current path first, then publish any live editor
        // bytes through the same path-based identity used by its surfaces.
        captureLatestDocumentContent(identity);

        const hasDraft = hasDocumentUnsavedChanges(identity);
        const buffer = hasDraft ? getDocumentBuffer(identity) : null;
        setTarget({
          identity,
          content: buffer?.content ?? content,
          expectedContent: buffer?.lastSavedContent ?? content,
          path: targetPath,
          scopePath: detail?.scopePath ?? null,
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
      // Persist through the document's notebook path and expected-content CAS.
      result = await memoDocumentOperations.write({
        path: target.path,
        scopePath: target.scopePath,
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
    useNoteStore.getState().triggerRefresh();
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
