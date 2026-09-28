/**
 * Mutable buffer for a runtime document identity. The 3 fields here used to be
 * module-singleton refs in useDocumentContent; now they live in a
 * module-level Map<documentIdentityKey, DocumentBuffer> owned by buffer-registry so
 * switching memos doesn't trample the previously-open memo's pending
 * state, and so the document store can coordinate save flushes without
 * going through module-singleton closer hooks.
 *
 *   - `content`         — the live working content. Updated on every
 *                         keystroke (handleChange).
 *   - `lastSavedContent` — the last content successfully written to disk.
 *                         Used as the CAS expected value.
 *   - `pendingContent`  — the content waiting to be written, if any.
 *                         Cleared by onSaved when content == written.
 */
export interface DocumentBuffer {
  content: string;
  saveError: string | null;
  conflicted: boolean;
  conflictContent: string | null;
  lastSavedContent: string;
  pendingContent: string | null;
  /** Latest user content revision captured in this buffer. */
  editRevision: number;
  /** Highest editor revision published to the buffer. */
  capturedRevision: number;
  /** Highest revision known to be recoverable from disk or recovery storage. */
  durableRevision: number;
  /** Highest revision confirmed in the canonical document file. */
  savedRevision: number;
  /** Revision currently being written to the canonical file. */
  savingRevision: number | null;
  /** Latest revision waiting behind an in-flight write. */
  pendingRevision: number | null;
  saveState: 'clean' | 'dirty' | 'saving' | 'protected' | 'conflict' | 'error';
}

export function emptyDocumentBuffer(): DocumentBuffer {
  return {
    content: '',
    saveError: null,
    conflicted: false,
    conflictContent: null,
    lastSavedContent: '',
    pendingContent: null,
    editRevision: 0,
    capturedRevision: 0,
    durableRevision: 0,
    savedRevision: 0,
    savingRevision: null,
    pendingRevision: null,
    saveState: 'clean',
  };
}
