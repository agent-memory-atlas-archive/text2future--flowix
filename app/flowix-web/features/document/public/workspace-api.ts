import { getDocumentSession } from '../store/document-runtime-session';
import { useDocumentStore } from '@features/document/store/document-store';
import type {
  ExternalDocumentSession,
  MemoDocumentSession,
} from '@features/document/store/document-store';
import {
  useDocumentHistoryStore,
  type ArtifactHistoryEntry,
  type DocumentHistoryEntry,
  type MediaHistoryEntry,
} from '@features/document/store/document-history-store';
import {
  flushDocumentPath,
  rebaseActiveDocumentPath,
} from '@features/document/store/document-session-service';
import { findFileDisplayId, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { canonicalPath } from '@/lib/path';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { rebaseRecoveryDraftPath } from '@features/document/store/recovery-draft-store';
import { waitForSaveQueue } from '@features/document/store/save-queue';
import { documentIdentityKey } from '@features/document/store/document-identity';

export { documentIdentityFromFile } from '@features/document/store/document-identity';
export { deleteExternalDocument } from '@features/document/use-cases/delete-external-document';

/** Navigation waits for document persistence without knowing queue keys. */
export function waitForWorkspaceDocumentSaves(identity: DocumentIdentity): Promise<boolean> {
  return waitForSaveQueue(documentIdentityKey(identity));
}

export function getWorkspaceDocumentPaths(): string[] {
  const state = useDocumentStore.getState();
  return [state.activeMemoSession?.fileIdentity.path, state.activeExternalSession?.fileIdentity.path]
    .filter((path): path is string => Boolean(path));
}

export function subscribeWorkspaceDocumentPaths(listener: () => void): () => void {
  return useDocumentStore.subscribe((state, previous) => {
    if (state.activeMemoSession !== previous.activeMemoSession
      || state.activeExternalSession !== previous.activeExternalSession) listener();
  });
}

type DocumentState = ReturnType<typeof useDocumentStore.getState>;

/**
 * Document capabilities used by workspace navigation.
 *
 * Keep this contract narrower than DocumentStore: workspace owns placement and
 * navigation transactions, while document owns session lifecycle and flushing.
 */
export type WorkspaceDocumentState = Pick<
  DocumentState,
  | 'activeMemoSession'
  | 'activeExternalSession'
  | 'activeAgentConversationId'
  | 'openMemoDocument'
  | 'openExternalDocument'
  | 'openAgentConversation'
  | 'closeAgentConversation'
  | 'clearDocument'
  | 'discardMemoDocument'
  | 'replaceActiveMemoPath'
  | 'replaceActiveExternalPath'
>;

export function getWorkspaceDocumentState(): WorkspaceDocumentState {
  return useDocumentStore.getState();
}

export function recordWorkspaceDocumentNavigation(
  current: DocumentHistoryEntry | null,
  next: DocumentHistoryEntry | null,
): void {
  useDocumentHistoryStore.getState().recordNavigation(current, next);
}

export function replaceWorkspaceMemoHistoryPath(memoId: string, path: string): void {
  useDocumentHistoryStore.getState().replaceMemoPath(memoId, canonicalPath(path));
}

export function replaceWorkspaceDocumentPath(
  identity: DocumentIdentity,
  path: string,
): void {
  const previous = canonicalPath(identity.path);
  const next = canonicalPath(path);
  if (!previous || !next || previous === next) return;
  if (!rebaseWorkspaceDocumentPath(identity, next)) return;
  useDocumentStore.getState().replaceActiveExternalPath(identity.displayId, next);
  useDocumentHistoryStore.getState().replaceFilePath(previous, next);
  if (identity.memoId) {
    useDocumentHistoryStore.getState().replaceMemoPath(identity.memoId, next);
  }
}

/** Rebase the shared live document identity after either a Memo or file rename. */
export function rebaseWorkspaceDocumentPath(
  identity: DocumentIdentity,
  path: string,
): boolean {
  const previous = canonicalPath(identity.path);
  const next = canonicalPath(path);
  if (!previous || !next) return false;
  if (previous === next) return true;
  const ownsPrevious = findFileDisplayId(previous) === identity.displayId;
  if (!rebaseFileDisplayPath(previous, next, identity.displayId)) return false;
  if (ownsPrevious) rebaseRecoveryDraftPath({ ...identity, path: previous }, next);
  getDocumentSession(identity).fallbackPath = next;
  rebaseActiveDocumentPath(identity, next);
  return true;
}

export async function flushWorkspaceDocumentPath(
  identity: DocumentIdentity,
  path: string,
  scopePath?: string | null,
): Promise<boolean> {
  return flushDocumentPath(identity, path, scopePath);
}

export type {
  ArtifactHistoryEntry,
  DocumentHistoryEntry,
  MediaHistoryEntry,
  ExternalDocumentSession,
  MemoDocumentSession,
};
