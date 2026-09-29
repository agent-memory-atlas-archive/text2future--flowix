import { create } from 'zustand';
import { flushDocumentPath } from '@features/document/store/document-session-service';
import { canonicalPath } from '@/lib/path';
import {
  markDocumentOpenTrace,
  startDocumentOpenTrace,
} from '@/lib/document-open-perf';
import { documentIdentityFromFile, type DocumentIdentity } from '@features/document/store/document-identity';
import { ensureFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';


export type DocumentSource = 'external';

export interface ExternalDocumentSession {
  fileIdentity: FileDisplayIdentity;
  scopePath: string | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  relativePath?: string | null;
  indexable?: boolean;
  initialFocus?: 'title' | 'body';
  openedAt: number;
  transitionId: number;
}

function sessionIdentity(session: ExternalDocumentSession): DocumentIdentity {
  return documentIdentityFromFile(session.fileIdentity);
}

function sessionPath(session: ExternalDocumentSession): string {
  return session.fileIdentity.path;
}

function sessionScopePath(session: ExternalDocumentSession): string | null {
  return session.scopePath;
}

interface DocumentStore {
  currentDocumentPath: string | null;
  currentDocumentSource: DocumentSource | null;
  /** A right-panel surface which is not backed by an editable document. */
  activeAgentConversationId: string | null;
  activeExternalSession: ExternalDocumentSession | null;
  isDocumentTransitioning: boolean;
  documentTransitionId: number;
  finishDocumentTransition: (transitionId: number) => void;
  replaceActiveExternalPath: (displayId: string, path: string) => void;
  openExternalDocument: (path: string | null, options?: {
    scopePath?: string | null;
    notebookId?: string | null;
    notebookPath?: string | null;
    relativePath?: string | null;
    indexable?: boolean;
    initialFocus?: 'title' | 'body';
  }) => Promise<void>;
  openAgentConversation: (instanceId: string) => Promise<void>;
  closeAgentConversation: () => void;
  clearDocument: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
//
// A document session transition has two phases, both owned by this store:
//   1. flush the outgoing document's pending edits to disk
//      (calls document-session-service.flushDocumentPath for the previous path)
//   2. commit the new session state via set(...)
//
// The flush awaits the save queue's chain — see save-queue.ts — so by
// the time set() runs, the outgoing document's last edit is on disk
// (or a CAS refusal toast has been surfaced). React then re-renders
// with the new session; useDocumentContent's reloadDocument effect
// reads the new path and re-hydrates the buffer.
//
// If there is no previous session (first open after launch), the flush
// is a no-op.
// ---------------------------------------------------------------------------

function documentState(path: string | null, source: DocumentSource | null) {
  return {
    currentDocumentPath: path,
    currentDocumentSource: path ? source : null,
    activeAgentConversationId: null,
    activeExternalSession: null,
    isDocumentTransitioning: false,
  };
}

function isSameExternalTarget(
  state: DocumentStore,
  canonicalNewPath: string | null,
  canonicalScopePath: string | null,
): boolean {
  return (
    !!canonicalNewPath &&
    state.currentDocumentSource === 'external' &&
    !!state.activeExternalSession &&
    canonicalPath(state.activeExternalSession.fileIdentity.path) === canonicalNewPath &&
    state.activeExternalSession.scopePath === canonicalScopePath
  );
}

let transitionChain: Promise<void> = Promise.resolve();

function enqueueTransition<T>(work: () => Promise<T>): Promise<T> {
  const run = transitionChain.catch(() => undefined).then(work);
  transitionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const useDocumentStore = create<DocumentStore>()(
  (set, get) => ({
    currentDocumentPath: null,
    currentDocumentSource: null,
    activeAgentConversationId: null,
    activeExternalSession: null,
    isDocumentTransitioning: false,
    documentTransitionId: 0,
    finishDocumentTransition: (transitionId) => {
      set((state) => {
        if (state.documentTransitionId !== transitionId) return state;
        return { isDocumentTransitioning: false };
      });
    },
    replaceActiveExternalPath: (displayId, path) => {
      const canonicalNewPath = canonicalPath(path);
      set((state) => {
        if (
          state.currentDocumentSource !== 'external' ||
          state.activeExternalSession?.fileIdentity.displayId !== displayId
        ) {
          return state;
        }
        return {
          currentDocumentPath: canonicalNewPath,
          activeExternalSession: {
            ...state.activeExternalSession,
            fileIdentity: { ...state.activeExternalSession.fileIdentity, path: canonicalNewPath },
            relativePath: state.activeExternalSession.notebookId && state.activeExternalSession.notebookPath
              && canonicalNewPath.startsWith(`${canonicalPath(state.activeExternalSession.notebookPath).replace(/\/+$/, '')}/`)
              ? canonicalNewPath.slice(canonicalPath(state.activeExternalSession.notebookPath).replace(/\/+$/, '').length + 1)
              : state.activeExternalSession.relativePath,
          },
        };
      });
    },
    openExternalDocument: async (path, {
      scopePath = null, notebookId = null, notebookPath = null, relativePath = null, indexable = false, initialFocus,
    } = {}) => {
      const canonicalNewPath = path ? canonicalPath(path) : null;
      const canonicalScopePath = scopePath ? canonicalPath(scopePath) : null;
      if (isSameExternalTarget(get(), canonicalNewPath, canonicalScopePath)) {
        return;
      }

      const transitionId = get().documentTransitionId + 1;
      startDocumentOpenTrace(transitionId, {
        source: 'external',
        path,
        hasPrevious: !!get().activeExternalSession,
      });
      markDocumentOpenTrace(transitionId, 'navigation:external-start', {
        scopePath: canonicalScopePath,
      });
      set({ isDocumentTransitioning: true, documentTransitionId: transitionId });
      return enqueueTransition(async () => {
        try {
          if (isSameExternalTarget(get(), canonicalNewPath, canonicalScopePath)) {
            get().finishDocumentTransition(transitionId);
            return;
          }

          const prev = get().activeExternalSession;
          if (prev) {
            const flushed = await flushDocumentPath(
              sessionIdentity(prev),
              sessionPath(prev),
              sessionScopePath(prev),
            );
            if (!flushed) throw new Error('Document switch cancelled because saving did not complete');
          }
          set(() => {
            if (!canonicalNewPath) return documentState(null, null);
            const openedAt = Date.now();
            return {
              currentDocumentPath: canonicalNewPath,
              currentDocumentSource: 'external',
              activeAgentConversationId: null,
              activeExternalSession: {
                fileIdentity: ensureFileDisplayIdentity(canonicalNewPath),
                scopePath: canonicalScopePath,
                notebookId,
                notebookPath,
                relativePath,
                indexable,
                initialFocus,
                openedAt,
                transitionId,
              },
              isDocumentTransitioning: true,
            };
          });
        } catch (err) {
          get().finishDocumentTransition(transitionId);
          throw err;
        }
      });
    },
    openAgentConversation: async (instanceId) => {
      const normalizedInstanceId = instanceId.trim();
      if (!normalizedInstanceId || get().activeAgentConversationId === normalizedInstanceId) return;

      return enqueueTransition(async () => {
        const prev = get().activeExternalSession;
        if (prev) {
          const flushed = await flushDocumentPath(sessionIdentity(prev), sessionPath(prev), sessionScopePath(prev));
          if (!flushed) throw new Error('Session switch cancelled because saving did not complete');
        }
        set({
          ...documentState(null, null),
          activeAgentConversationId: normalizedInstanceId,
        });
      });
    },
    closeAgentConversation: () => {
      if (!get().activeAgentConversationId) return;
      set({ activeAgentConversationId: null });
    },
    clearDocument: async () => {
      return enqueueTransition(async () => {
        const prev = get().activeExternalSession;
        if (prev) {
          const flushed = await flushDocumentPath(sessionIdentity(prev), sessionPath(prev), sessionScopePath(prev));
          if (!flushed) throw new Error('Document close cancelled because saving did not complete');
        }
        set(documentState(null, null));
      });
    },
  })
);
