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
import { findFileDisplayId, rebaseFileDisplayPath } from '@features/workspace/store/file-display-store';
import { canonicalPath } from '@/lib/path';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { rebaseRecoveryDraftPath } from '@features/document/store/recovery-draft-store';

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
  rebaseWorkspaceDocumentPath(identity, next);
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
): void {
  const previous = canonicalPath(identity.path);
  const next = canonicalPath(path);
  if (!previous || !next || previous === next) return;
  // A memo rename can carry several stale historical paths. Only the path
  // that currently owns this runtime ID is the live file whose draft moves.
  if (findFileDisplayId(previous) === identity.displayId) {
    rebaseRecoveryDraftPath(identity, next);
  }
  rebaseFileDisplayPath(previous, next, identity.displayId);
  rebaseActiveDocumentPath(identity, next);
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
