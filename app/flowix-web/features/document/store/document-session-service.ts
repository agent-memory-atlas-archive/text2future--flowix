import {
  applyLoadedContent,
  discardUnsavedLocalChanges,
  flushDocument,
  getBuffer,
  getCurrentIdentity,
  getCurrentPath,
  getOrCreateBuffer,
  hasUnsavedLocalChanges,
  notifyDocumentBufferChanged,
  releaseDocumentBuffer,
  rebaseCurrentDocumentPath,
  setCurrentDocument,
  type FlushCallbacks,
} from '@features/document/store/buffer-registry';
import { isDocumentContentEqual } from '@features/document/store/buffer-equality';
import type { DocumentBuffer } from '@features/document/store/document-buffer';
import {
  documentIdentityKey,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
import { canonicalPath } from '@/lib/path';
import { persistRecoveryDraft } from '@features/document/store/recovery-draft-store';
import { subscribeFileDisplayRelease } from '@features/workspace/store/file-display-store';
import { waitForSaveQueue } from '@features/document/store/save-queue';

const RECOVERY_DRAFT_WRITE_TIMEOUT_MS = 3_000;

type DocumentCapture = () => string | null;
interface RegisteredDocumentCapture {
  hostId?: string;
  capture: DocumentCapture;
}
const documentCaptures = new Map<string, Set<RegisteredDocumentCapture>>();
const pendingReleasedDisplays = new Set<string>();
const releaseChecksInFlight = new Set<string>();

function cleanupReleasedDisplayBuffer(displayId: string): void {
  const key = `md:${displayId}`;
  pendingReleasedDisplays.add(displayId);
  if (releaseChecksInFlight.has(displayId)) return;
  releaseChecksInFlight.add(displayId);

  void waitForSaveQueue(key).then((settled) => {
    if (!settled) {
      pendingReleasedDisplays.delete(displayId);
      return;
    }
    // A store update can release the identity just before React unmounts its
    // editor. The final capture unregister retries this cleanup afterwards.
    if (documentCaptures.has(key)) return;
    releaseDocumentBuffer(displayId);
    stagedDocumentSnapshots.delete(key);
    pendingReleasedDisplays.delete(displayId);
  }).catch(() => {
    pendingReleasedDisplays.delete(displayId);
  }).finally(() => {
    releaseChecksInFlight.delete(displayId);
  });
}

subscribeFileDisplayRelease(cleanupReleasedDisplayBuffer);

/** Register a mounted editor capable of publishing its latest content. */
export function registerDocumentCapture(
  identity: DocumentIdentity,
  capture: DocumentCapture,
  hostId?: string,
): () => void {
  const key = documentIdentityKey(identity);
  const registration = { hostId, capture } satisfies RegisteredDocumentCapture;
  const captures = documentCaptures.get(key) ?? new Set<RegisteredDocumentCapture>();
  captures.add(registration);
  documentCaptures.set(key, captures);
  return () => {
    captures.delete(registration);
    if (captures.size === 0) {
      documentCaptures.delete(key);
      if (pendingReleasedDisplays.has(identity.displayId)) {
        cleanupReleasedDisplayBuffer(identity.displayId);
      }
    }
  };
}

/** Publish all mounted surfaces before the save barrier reads the buffer. */
export function captureLatestDocumentContent(identity: DocumentIdentity, hostId?: string): void {
  const captures = documentCaptures.get(documentIdentityKey(identity));
  if (!captures) return;
  for (const registration of [...captures]) {
    if (hostId !== undefined && registration.hostId !== hostId) continue;
    registration.capture();
  }
}

export async function protectDocumentDraft(
  identity: DocumentIdentity,
  path: string,
  reason: 'autosave' | 'save-timeout' | 'save-error' | 'shutdown',
): Promise<boolean> {
  const buffer = getOrCreateBuffer(identity);
  if (!hasUnsavedLocalChanges(identity)) return true;
  const protectedByDraft = await waitWithTimeout(persistRecoveryDraft({
    identity,
    originalPath: canonicalPath(path),
    revision: buffer.capturedRevision,
    content: buffer.content,
    baseContent: buffer.lastSavedContent,
    reason,
  }), RECOVERY_DRAFT_WRITE_TIMEOUT_MS);
  if (protectedByDraft !== true) return false;
  buffer.durableRevision = Math.max(buffer.durableRevision, buffer.capturedRevision);
  if (buffer.savedRevision < buffer.capturedRevision) buffer.saveState = 'protected';
  notifyDocumentBufferChanged(identity, 'save_settled');
  return true;
}

export function applyRecoveryDraftContent(
  identity: DocumentIdentity,
  content: string,
  revision: number,
): DocumentBuffer {
  const buffer = getOrCreateBuffer(identity);
  buffer.content = content;
  buffer.pendingContent = content;
  buffer.editRevision = Math.max(buffer.editRevision, revision);
  buffer.capturedRevision = Math.max(buffer.capturedRevision, revision);
  buffer.durableRevision = Math.max(buffer.durableRevision, revision);
  buffer.pendingRevision = buffer.capturedRevision;
  buffer.saveState = 'protected';
  notifyDocumentBufferChanged(identity, 'loaded');
  return buffer;
}

function waitWithTimeout(promise: Promise<boolean>, timeoutMs: number): Promise<boolean | 'timeout'> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve('timeout'), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(false);
      },
    );
  });
}


interface DocumentDraftSnapshot {
  identity: DocumentIdentity;
  path: string;
  content: string;
}

interface DocumentEditResult {
  changed: boolean;
  buffer: DocumentBuffer;
}

interface StagedDocumentSnapshot {
  path: string;
  content: string;
}

const stagedDocumentSnapshots = new Map<string, StagedDocumentSnapshot>();

/** One-shot authoritative content returned together with memo metadata. */
export function stageDocumentSnapshot(
  identity: DocumentIdentity,
  path: string,
  content: string,
): void {
  stagedDocumentSnapshots.set(documentIdentityKey(identity), {
    path: canonicalPath(path),
    content,
  });
}

export function consumeStagedDocumentSnapshot(
  identity: DocumentIdentity,
  path: string,
): string | null {
  const key = documentIdentityKey(identity);
  const snapshot = stagedDocumentSnapshots.get(key);
  if (!snapshot || snapshot.path !== canonicalPath(path)) return null;
  stagedDocumentSnapshots.delete(key);
  return snapshot.content;
}

interface SaveDocumentContentOptions {
  path: string;
  identity: DocumentIdentity;
  content: string;
  /**
   * `internal` (内部 memo 文档) 或 `external` (外部文本文件)。后端
   * 据此分流: 内部走 key 反查 + 派生改名 + memo index 同步, 外部只
   * 做 fs::write + CAS, 不改名不动 memo index。
   */
  channel: 'internal' | 'external';
  /**
   * 内部 memo 文档的 memoId ── closure 期间稳定, 后端用它反查 memo index
   * 拿当前 entry.filename, 走新路径写。外部文件可传 null。
   */
  key: string | null;
  /** Authorized file-tree root for external code/text documents. */
  scopePath?: string | null;
  force?: boolean;
  callbacks?: FlushCallbacks;
}

const selfPathUpdates = new Set<string>();

function selfPathUpdateKey(memoId: string, path: string): string {
  return `${memoId}:${canonicalPath(path)}`;
}

export function markSelfDocumentPathUpdate(memoId: string, path: string): void {
  selfPathUpdates.add(selfPathUpdateKey(memoId, path));
}

export function consumeSelfDocumentPathUpdate(memoId: string, path: string): boolean {
  const key = selfPathUpdateKey(memoId, path);
  const exists = selfPathUpdates.has(key);
  if (exists) {
    selfPathUpdates.delete(key);
  }
  return exists;
}

export function getActiveDocumentDraft(): DocumentDraftSnapshot | null {
  const identity = getCurrentIdentity();
  const path = getCurrentPath();
  return identity && path ? getDocumentDraft(identity, path) : null;
}

export function getDocumentDraft(
  identity: DocumentIdentity,
  path: string,
): DocumentDraftSnapshot | null {
  const buffer = getBuffer(identity);
  if (!path || !buffer || buffer.content == null) return null;
  return { identity, path, content: buffer.content };
}

/** Record user edits against the buffer owned by the runtime display identity. */
export function recordDocumentEdit(identity: DocumentIdentity, content: string): DocumentEditResult {
  const buffer = getOrCreateBuffer(identity);
  if (content === buffer.content) {
    return { changed: !isDocumentContentEqual(identity, content, buffer.lastSavedContent), buffer };
  }
  buffer.editRevision += 1;
  buffer.capturedRevision = buffer.editRevision;
  if (isDocumentContentEqual(identity, content, buffer.lastSavedContent)) {
    buffer.content = content;
    buffer.pendingContent = null;
    buffer.pendingRevision = null;
    buffer.savedRevision = buffer.capturedRevision;
    buffer.durableRevision = buffer.capturedRevision;
    buffer.saveState = 'clean';
    notifyDocumentBufferChanged(identity, 'edited');
    return { changed: false, buffer };
  }
  buffer.content = content;
  buffer.pendingContent = content;
  buffer.pendingRevision = buffer.capturedRevision;
  buffer.saveState = 'dirty';
  notifyDocumentBufferChanged(identity, 'edited');
  return { changed: true, buffer };
}

/** Write a buffer snapshot to its current backing path. */
export async function saveDocumentContent({
  path,
  identity,
  content,
  channel,
  key,
  scopePath,
  force,
  callbacks,
}: SaveDocumentContentOptions): Promise<boolean> {
  if (!path) return true;
  const buffer = getOrCreateBuffer(identity);

  if (content !== buffer.content) {
    recordDocumentEdit(identity, content);
  }

  return flushDocument(identity, path, { key, channel, scopePath, force, ...callbacks });
}

export function flushDocumentPath(
  identity: DocumentIdentity,
  path: string,
  scopePath: string | null = null,
): Promise<boolean> {
  return prepareDocumentLeave(identity, path, scopePath);
}

/**
 * Capture the outgoing editor and make its latest revision durable without
 * putting canonical disk/index latency on the navigation critical path.
 * Canonical saves continue in the background; a small recovery draft is the
 * only bounded, non-destructive navigation barrier.
 */
export async function prepareDocumentLeave(
  identity: DocumentIdentity,
  path: string,
  scopePath: string | null = null,
): Promise<boolean> {
  captureLatestDocumentContent(identity);
  const buffer = getOrCreateBuffer(identity);
  if (!hasUnsavedLocalChanges(identity)) return true;

  const revision = buffer.capturedRevision;
  const content = buffer.content;
  const baseContent = buffer.lastSavedContent;
  const save = flushDocument(identity, path, { scopePath });
  if (buffer.durableRevision >= revision) {
    // The revision is already recoverable. Keep the canonical write alive,
    // but do not make navigation wait for it again.
    void save;
    return true;
  }

  // Preserve the exact captured snapshot immediately. Waiting for the full
  // memo write here can include filesystem, index and watcher latency and used
  // to freeze every document switch for up to five seconds.
  const protectedByDraft = await waitWithTimeout(persistRecoveryDraft({
    identity,
    originalPath: canonicalPath(path),
    revision,
    content,
    baseContent,
    reason: 'autosave',
  }), RECOVERY_DRAFT_WRITE_TIMEOUT_MS);
  if (protectedByDraft !== true) return false;

  // The canonical save may have won the race while the draft was being
  // persisted. Do not regress an already-clean buffer back to `protected`.
  if (buffer.savedRevision >= revision) return true;

  buffer.durableRevision = Math.max(buffer.durableRevision, revision);
  buffer.saveState = 'protected';
  notifyDocumentBufferChanged(identity, 'save_settled');
  return true;
}

export function getDocumentBuffer(identity: DocumentIdentity): DocumentBuffer {
  return getOrCreateBuffer(identity);
}

export function hasDocumentUnsavedChanges(identity?: DocumentIdentity): boolean {
  return hasUnsavedLocalChanges(identity);
}

export function discardDocumentDraft(identity: DocumentIdentity): void {
  discardUnsavedLocalChanges(identity);
}

export function applyLoadedDocumentContent(
  identity: DocumentIdentity,
  path: string,
  fullContent: string,
  options?: { preservePending?: boolean; setAsCurrent?: boolean },
): DocumentBuffer {
  return applyLoadedContent(identity, path, fullContent, options);
}

export function setActiveDocumentPath(identity: DocumentIdentity | null, path: string | null): void {
  setCurrentDocument(identity, path);
}

export function rebaseActiveDocumentPath(identity: DocumentIdentity, path: string): void {
  rebaseCurrentDocumentPath(identity, path);
}
