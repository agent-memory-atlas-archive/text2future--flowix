import { scheduleSave } from '@features/document/store/save-queue';
import { emptyDocumentBuffer, type DocumentBuffer } from '@features/document/store/document-buffer';
import { canonicalPath } from '@/lib/path';
import { isDocumentContentEqual } from '@features/document/store/buffer-equality';
import {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
import { clearRecoveryDraftThrough } from '@features/document/store/recovery-draft-store';
import { pinFileDisplayId } from '@features/workspace/store/file-display-store';

const documentBuffers = new Map<string, DocumentBuffer>();

let currentPath: string | null = null;
let currentIdentity: DocumentIdentity | null = null;

export type DocumentBufferChangeReason = 'edited' | 'loaded' | 'save_settled';
type DocumentBufferChangeListener = (
  identity: DocumentIdentity,
  reason: DocumentBufferChangeReason,
) => void;
const documentBufferChangeListeners = new Set<DocumentBufferChangeListener>();

export function subscribeDocumentBufferChanges(
  listener: DocumentBufferChangeListener,
): () => void {
  documentBufferChangeListeners.add(listener);
  return () => documentBufferChangeListeners.delete(listener);
}

export function notifyDocumentBufferChanged(
  identity: DocumentIdentity,
  reason: DocumentBufferChangeReason,
): void {
  const normalized = normalizeDocumentIdentity(identity);
  for (const listener of [...documentBufferChangeListeners]) {
    listener(normalized, reason);
  }
}

export function getCurrentPath(): string | null {
  return currentPath;
}

export function getCurrentIdentity(): DocumentIdentity | null {
  return currentIdentity;
}

export function getBuffer(identity: DocumentIdentity): DocumentBuffer | undefined {
  const normalized = normalizeDocumentIdentity(identity);
  return documentBuffers.get(documentIdentityKey(normalized));
}

export function getOrCreateBuffer(identity: DocumentIdentity): DocumentBuffer {
  const normalized = normalizeDocumentIdentity(identity);
  const key = documentIdentityKey(normalized);
  const existing = documentBuffers.get(key);
  if (existing) return existing;
  const created = emptyDocumentBuffer();
  documentBuffers.set(key, created);
  return created;
}

/** Drop an unowned buffer once its latest revision is safely durable. */
export function releaseDocumentBuffer(displayId: string): void {
  const key = `md:${displayId}`;
  const buffer = documentBuffers.get(key);
  if (buffer && (
    buffer.savingRevision !== null
    || (buffer.saveState !== 'clean' && buffer.durableRevision < buffer.capturedRevision)
  )) return;

  if (currentIdentity && documentIdentityKey(currentIdentity) === key) {
    currentIdentity = null;
    currentPath = null;
  }
  documentBuffers.delete(key);
}

export function setCurrentDocument(identity: DocumentIdentity | null, path: string | null): void {
  if (!identity || !path) {
    currentPath = null;
    currentIdentity = null;
    return;
  }

  const normalized = normalizeDocumentIdentity(identity);
  const nextPath = canonicalPath(path);
  const currentKey = currentIdentity ? documentIdentityKey(currentIdentity) : null;
  if (documentIdentityKey(normalized) === currentKey && nextPath === currentPath) {
    currentIdentity = normalized;
    return;
  }

  currentIdentity = normalized;
  currentPath = nextPath;
  getOrCreateBuffer(normalized);
}

/** Rebase the active path without treating live editor bytes as a disk load. */
export function rebaseCurrentDocumentPath(identity: DocumentIdentity, path: string): void {
  const normalized = normalizeDocumentIdentity(identity);
  if (!currentIdentity || documentIdentityKey(normalized) !== documentIdentityKey(currentIdentity)) return;
  const nextPath = canonicalPath(path);
  currentIdentity = {
    ...normalized,
    memoId: normalized.memoId ?? currentIdentity.memoId,
    path: nextPath,
  };
  currentPath = nextPath;
}

export function hasUnsavedLocalChanges(identity?: DocumentIdentity): boolean {
  const target = identity ?? getCurrentIdentity();
  if (!target) return false;
  const buf = getBuffer(target);
  if (!buf) return false;
  return !isDocumentContentEqual(target, buf.content, buf.lastSavedContent);
}

/**
 * Accept the in-memory content as intentionally abandoned without writing it.
 * This is reserved for a document whose backing source has already vanished;
 * normal navigation must continue to use the save barrier.
 */
export function discardUnsavedLocalChanges(identity: DocumentIdentity): void {
  const normalized = normalizeDocumentIdentity(identity);
  const buf = getBuffer(normalized);
  if (!buf) return;
  buf.lastSavedContent = buf.content;
  buf.pendingContent = null;
  buf.savedRevision = buf.capturedRevision;
  buf.durableRevision = buf.capturedRevision;
  buf.pendingRevision = null;
  buf.savingRevision = null;
  buf.saveState = 'clean';
  void clearRecoveryDraftThrough(normalized, buf.savedRevision);
  notifyDocumentBufferChanged(normalized, 'save_settled');
}

export function applyLoadedContent(
  identity: DocumentIdentity,
  path: string,
  fullContent: string,
  options?: { preservePending?: boolean; setAsCurrent?: boolean },
): DocumentBuffer {
  if (options?.setAsCurrent !== false) setCurrentDocument(identity, path);
  const buf = getOrCreateBuffer(identity);
  const initialContent = options?.preservePending
    ? (buf.pendingContent ?? fullContent)
    : fullContent;
  buf.content = initialContent;
  buf.lastSavedContent = fullContent;
  if (!options?.preservePending) {
    buf.pendingContent = null;
    buf.editRevision = 0;
    buf.capturedRevision = 0;
    buf.durableRevision = 0;
    buf.savedRevision = 0;
    buf.savingRevision = null;
    buf.pendingRevision = null;
    buf.saveState = 'clean';
  }
  notifyDocumentBufferChanged(identity, 'loaded');
  return buf;
}

export interface FlushCallbacks {
  onSaved?: (writtenPath: string, content: string, revision: number) => void;
  onCasRefused?: (content: string, revision: number) => void;
  onError?: (content: string, revision: number, err: unknown) => void;
}

export async function flushDocument(
  identity: DocumentIdentity,
  path: string,
  callbacks?: FlushCallbacks & {
    channel?: 'internal' | 'external';
    key?: string | null;
    scopePath?: string | null;
    force?: boolean;
  },
): Promise<boolean> {
  const normalized = normalizeDocumentIdentity(identity);
  const buf = getBuffer(normalized);
  if (!buf) return true;
  if (!callbacks?.force && isDocumentContentEqual(normalized, buf.content, buf.lastSavedContent)) {
    return true;
  }

  const channel: 'internal' | 'external' = callbacks?.channel
    ?? (normalized.memoId ? 'internal' : 'external');
  const key: string | null = callbacks?.key
    ?? normalized.memoId;
  const revision = buf.capturedRevision;
  buf.savingRevision = revision;
  buf.pendingRevision = revision;
  buf.saveState = 'saving';

  const releaseDisplayPin = pinFileDisplayId(normalized.displayId);
  try {
    return await scheduleSave({
      queueKey: documentIdentityKey(normalized),
      path: canonicalPath(path),
      channel,
      key,
      revision,
      scopePath: callbacks?.scopePath ?? null,
      readExpected: () => buf.lastSavedContent,
      onSaved: (writtenPath, writtenContent, savedRevision) => {
        buf.lastSavedContent = writtenContent;
        buf.savedRevision = Math.max(buf.savedRevision, savedRevision);
        buf.durableRevision = Math.max(buf.durableRevision, savedRevision);
        if (buf.savingRevision === savedRevision) buf.savingRevision = null;
        if (isDocumentContentEqual(normalized, buf.content, writtenContent)) {
          buf.pendingContent = null;
          buf.pendingRevision = null;
          // The current bytes are now canonical even if an equivalent edit
          // revision was captured while this request was in flight.
          buf.savedRevision = Math.max(buf.savedRevision, buf.capturedRevision);
          buf.durableRevision = Math.max(buf.durableRevision, buf.capturedRevision);
          buf.saveState = 'clean';
        } else if (buf.pendingContent !== null && isDocumentContentEqual(normalized, buf.pendingContent, writtenContent)) {
          buf.pendingContent = null;
          buf.pendingRevision = null;
          buf.saveState = 'clean';
        } else {
          buf.saveState = buf.savingRevision !== null ? 'saving' : 'dirty';
        }
        void clearRecoveryDraftThrough(normalized, buf.savedRevision);
        callbacks?.onSaved?.(writtenPath, writtenContent, savedRevision);
        notifyDocumentBufferChanged(normalized, 'save_settled');
      },
      onCasRefused: (written, refusedRevision) => {
        if (buf.savingRevision === refusedRevision) buf.savingRevision = null;
        buf.saveState = buf.savingRevision !== null ? 'saving' : 'conflict';
        callbacks?.onCasRefused?.(written, refusedRevision);
        notifyDocumentBufferChanged(normalized, 'save_settled');
      },
      onError: (written, failedRevision, err) => {
        if (buf.savingRevision === failedRevision) buf.savingRevision = null;
        buf.saveState = buf.savingRevision !== null ? 'saving' : 'error';
        callbacks?.onError?.(written, failedRevision, err);
        notifyDocumentBufferChanged(normalized, 'save_settled');
      },
    }, buf.content);
  } finally {
    releaseDisplayPin();
  }
}
