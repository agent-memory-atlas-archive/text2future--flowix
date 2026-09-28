import type { MemoContentCommit } from '@/types/memo';

/** File operations used by an open editable document surface. */
export interface DocumentWriteRequest {
  path: string;
  content: string;
  expectedContent: string;
  scopePath: string | null;
  /** Optional legacy event correlation; never the note address or save guard. */
  memoId?: string | null;
}

export type DocumentWriteOutcome =
  | ({ status: 'saved'; path: string; content: string } & MemoContentCommit)
  | { status: 'conflict'; diskContent: string }
  | { status: 'refused' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export interface DocumentPathRequest {
  path: string;
  scopePath: string | null;
  /** Optional caller context for legacy metadata consumers. */
  memoId?: string | null;
}

/**
 * Shared shape for file-backed editing. A Memo implementation can supply its
 * own backend operations without changing editor or save-queue callers.
 */
export interface EditableDocumentOperations {
  read: (request: DocumentPathRequest) => Promise<string | null>;
  write: (request: DocumentWriteRequest) => Promise<DocumentWriteOutcome>;
  rename: (request: DocumentPathRequest & { name: string }) => Promise<{ path: string }>;
  delete: (request: DocumentPathRequest) => Promise<{ path: string }>;
}
