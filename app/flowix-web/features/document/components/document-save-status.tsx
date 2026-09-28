import { listDocumentSessions, findDocumentSession, subscribeDocumentSessions } from '../store/document-runtime-session';
import { isTitleSaving, subscribeTitleChanges } from '../store/document-title-session';
import { clearRecoveryDraftThrough } from '../store/recovery-draft-store';
import { toast as notifications } from 'sonner';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { captureLatestDocumentContent, getDocumentBuffer, protectDocumentDraft, saveDocumentContent, applyLoadedDocumentContent } from '../store/document-session-service';
import { notifyDocumentBufferChanged, subscribeDocumentBufferChanges } from '../store/buffer-registry';
import type { DocumentIdentity } from '../store/document-identity';
import { documentContentOperations } from '../use-cases/document-operations';

export function DocumentSaveStatus({ identity, external, scopePath }: {
  identity: DocumentIdentity; external: boolean; scopePath: string | null;
}) {
  const { t } = useI18n();
  const subscribe = useCallback((notify: () => void) => {
    const stopBody = subscribeDocumentBufferChanges(changed => {
      if (changed.displayId === identity.displayId) notify();
    });
    const stopTitle = subscribeTitleChanges(displayId => {
      if (displayId === identity.displayId) notify();
    });
    return () => { stopBody(); stopTitle(); };
  }, [identity.displayId]);
  const snapshot = useCallback(() => {
    const buffer = getDocumentBuffer(identity);
    return JSON.stringify([buffer.saveState, buffer.saveError, buffer.conflicted, buffer.savingRevision, isTitleSaving(identity.displayId)]);
  }, [identity]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);
  const buffer = getDocumentBuffer(identity);
  const [working, setWorking] = useState(false);
  const saving = buffer.savingRevision !== null || isTitleSaving(identity.displayId);
  void status;

  const resolve = async (choice: 'retry' | 'local' | 'disk') => {
    if (working || saving) return;
    setWorking(true);
    const path = findFileDisplayPath(identity.displayId) ?? identity.path;
    captureLatestDocumentContent(identity);
    const revision = buffer.capturedRevision;
    try {
      if (choice !== 'retry') {
        // Keep the local copy recoverable before an explicit conflict decision.
        if (!await protectDocumentDraft(identity, path, 'save-error')) return;
        const disk = await documentContentOperations(external ? 'external' : 'internal').read({
          path, scopePath, memoId: identity.memoId,
        });
        if (disk === null) throw new Error(t('document.save.missing'));
        captureLatestDocumentContent(identity);
        if (buffer.capturedRevision !== revision) return;
        if (choice === 'disk') {
          await clearRecoveryDraftThrough({ ...identity, path }, findDocumentSession(identity.displayId)!.recoveryRevision);
          captureLatestDocumentContent(identity);
          if (buffer.capturedRevision !== revision) return;
          applyLoadedDocumentContent(identity, path, disk, { preservePending: false });
          void protectDocumentDraft(identity, path, 'autosave');
          return;
        }
        // This explicit decision, unlike an automatic retry, authorizes replacing
        // the disk version just read. A newer external write still fails CAS.
        buffer.lastSavedContent = disk;
        buffer.conflicted = false;
        buffer.conflictContent = null;
      }
      buffer.saveError = null;
      await saveDocumentContent({ identity, path, content: buffer.content,
        channel: external ? 'external' : 'internal', key: identity.memoId, scopePath, force: true });
    } catch (error) {
      buffer.saveError = error instanceof Error ? error.message : String(error);
    } finally {
      notifyDocumentBufferChanged(identity, 'save_settled');
      setWorking(false);
    }
  };
  const notificationId = `document-save:${identity.displayId}`;
  useEffect(() => () => { notifications.dismiss(notificationId); }, [notificationId]);
  useEffect(() => {
    if (!buffer.conflicted && !buffer.saveError) { notifications.dismiss(notificationId); return; }
    notifications.custom(() => <div role="status" aria-live="polite" className="flex w-[var(--width)] flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--floating-bg)] px-4 py-3 text-sm text-[var(--floating-foreground)] shadow-lg">
    <span className="w-full truncate font-medium" title={identity.path}>{identity.path.split(/[\\/]/).pop()}</span>
    <span>{buffer.conflicted ? t('document.save.conflictHelp')
      : t('document.save.failed', { message: buffer.saveError ?? '' })}</span>
    {buffer.conflicted ? <>
      <button className="underline" disabled={working || saving} onClick={() => void resolve('local')}>{t('document.save.keepLocal')}</button>
      <button className="underline" disabled={working || saving} onClick={() => void resolve('disk')}>{t('document.save.useDisk')}</button>
    </> : buffer.saveError ? <button className="underline" disabled={working || saving} onClick={() => void resolve('retry')}>{t('document.save.retry')}</button> : null}
  </div>, { id: notificationId, duration: Infinity });
  });
  return null;
}

const subscribeNotifications = (notify: () => void) => {
  const stopSessions = subscribeDocumentSessions(notify);
  const stopBody = subscribeDocumentBufferChanges(notify);
  const stopTitle = subscribeTitleChanges(notify);
  return () => { stopSessions(); stopBody(); stopTitle(); };
};
const notificationSnapshot = () => JSON.stringify(listDocumentSessions()
  .filter(session => session.buffer?.conflicted || session.buffer?.saveError)
  .map(session => session.identity.displayId).sort());

/** Exactly one host per window, independent of editor mounts. */
export function DocumentSaveNotifications() {
  const snapshot = useSyncExternalStore(subscribeNotifications, notificationSnapshot, notificationSnapshot);
  const displayIds: string[] = JSON.parse(snapshot);
  return <>{displayIds.map(displayId => {
    const session = findDocumentSession(displayId)!;
    return <DocumentSaveStatus key={displayId} identity={session.identity}
      external={!session.identity.memoId} scopePath={session.retainedAdapter?.scopePath ?? null} />;
  })}</>;
}
