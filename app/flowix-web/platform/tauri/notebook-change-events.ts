import { subscribe, type SubscribeOptions, type UnlistenFn } from './event-bus';
import { createLogger } from '@/lib/logger';
import type { NoteEntry } from './client/notes';
import { canonicalPath } from '@/lib/path';

/** Compatibility payload. Only this boundary interprets the legacy optional fields. */
interface PathNoteChangedPayload {
  changeId?: string;
  notebookId: string;
  relativePath?: string;
  previousRelativePath?: string;
  created?: boolean;
  directory?: boolean;
  deleted?: boolean;
  source?: 'external_tool';
  originWindowLabel?: string;
  entry?: NoteEntry;
}

export type NotebookPathMove = {
  changeId: string;
  notebookId: string;
  previousRelativePath: string;
  relativePath: string;
  directory: boolean;
};

export type NotebookPathCreated = {
  changeId?: string;
  notebookId: string;
  relativePath: string;
  source?: 'external_tool';
  originWindowLabel?: string;
};

export interface PathMutationResult {
  path: string;
  notebookChange?: NotebookPathMove | null;
}

export type NotebookChange = (
  | { kind: 'path-moved'; notebookId: string; relativePath: string; previousRelativePath: string; directory: boolean }
  | { kind: 'resource-created'; notebookId: string; relativePath: string; source?: 'external_tool'; originWindowLabel?: string }
  | { kind: 'resource-updated'; notebookId: string; relativePath: string; entry: NoteEntry; originWindowLabel?: string }
  | { kind: 'resource-deleted'; notebookId: string; relativePath: string }
  | { kind: 'query-invalidated'; notebookId: string; relativePath: string | null }
) & { changeId?: string };

type NotebookChangeHandler = (change: NotebookChange) => void;
type NotebookDeletion = Extract<NotebookChange, { kind: 'resource-deleted' }>;

const localHandlers = new Set<NotebookChangeHandler>();
const logger = createLogger('notebook-change');
const pendingPathRenames = new Map<string, Map<NotebookChangeHandler, NotebookDeletion>>();
const pathKey = (notebookId: string, path: string) => JSON.stringify([notebookId, canonicalPath(path)]);

/** Hold old-path deletes until a local rename has a confirmed outcome. */
export function beginNotebookPathRename(notebookId: string, relativePath: string): (succeeded: boolean) => void {
  const key = pathKey(notebookId, relativePath);
  if (pendingPathRenames.has(key)) throw new Error('此笔记正在重命名，请稍后重试');
  const deferred = new Map<NotebookChangeHandler, NotebookDeletion>();
  pendingPathRenames.set(key, deferred);
  return (succeeded) => {
    if (pendingPathRenames.get(key) !== deferred) return;
    pendingPathRenames.delete(key);
    if (!succeeded) for (const [deliver, change] of deferred) {
      try { deliver(change); }
      catch (error) { logger.warn('apply deferred path deletion failed', { error, notebookId, relativePath }); }
    }
    deferred.clear();
  };
}

/** Command receipts use the same subscription and dedup boundary as broadcasts. */
function publishNotebookChange(change: NotebookChange): void {
  for (const handler of [...localHandlers]) {
    try { handler({ ...change }); }
    catch (error) { logger.warn('apply notebook change failed', { error, kind: change.kind, notebookId: change.notebookId, changeId: change.changeId }); }
  }
}

export function publishNotebookQueryInvalidated(notebookId: string): void {
  publishNotebookChange({ kind: 'query-invalidated', notebookId, relativePath: null });
}

export function publishNotebookPathMove(change: NotebookPathMove | null | undefined): void {
  if (change) publishNotebookChange({ ...change, kind: 'path-moved' });
}

export function publishNotebookPathCreated(change: NotebookPathCreated | null | undefined): void {
  if (change) publishNotebookChange({ ...change, kind: 'resource-created' });
}

export function acceptPathMutationResult(result: string | PathMutationResult): string {
  // Frontend HMR can precede the Rust process restart during development.
  if (typeof result === 'string') return result;
  if (result.notebookChange) publishNotebookPathMove(result.notebookChange);
  return result.path;
}

/** A path-only notification without a note entry or confirmed move/create/delete
 * is an invalidation. Empty paths invalidate the whole notebook.
 */
export function normalizeNotebookChange(payload: PathNoteChangedPayload): NotebookChange {
  const { notebookId, relativePath, previousRelativePath } = payload;
  if (relativePath && payload.entry) {
    return {
      kind: 'resource-updated',
      notebookId,
      relativePath,
      entry: payload.entry,
      originWindowLabel: payload.originWindowLabel,
      changeId: payload.changeId,
    };
  }
  if (relativePath && payload.created) {
    return {
      kind: 'resource-created', notebookId, relativePath, source: payload.source,
      originWindowLabel: payload.originWindowLabel, changeId: payload.changeId,
    };
  }
  if (relativePath && payload.deleted) {
    return { kind: 'resource-deleted', notebookId, relativePath, changeId: payload.changeId };
  }
  if (relativePath && previousRelativePath && relativePath !== previousRelativePath) {
    return {
      kind: 'path-moved', notebookId, relativePath, previousRelativePath, changeId: payload.changeId,
      directory: payload.directory === true,
    };
  }
  return { kind: 'query-invalidated', notebookId, relativePath: relativePath || null };
}

export function subscribeNotebookChanges(
  handler: NotebookChangeHandler,
  options?: SubscribeOptions,
): UnlistenFn {
  // Per-consumer tracking: one consumer must not suppress delivery to another.
  // Bound memory; path application must remain safe even after an ID is evicted.
  const seen = new Set<string>();
  let active = true;
  const deliver = (change: NotebookChange) => {
    if (!active) return;
    if (change.changeId && seen.has(change.changeId)) return;
    if (change.kind === 'resource-deleted') {
      const deferred = pendingPathRenames.get(pathKey(change.notebookId, change.relativePath));
      if (deferred) {
        deferred.set(deliver, change);
        return;
      }
    }
    handler(change);
    if (change.changeId) {
      seen.add(change.changeId);
      if (seen.size > 512) seen.delete(seen.values().next().value!);
    }
  };
  localHandlers.add(deliver);
  const stop = subscribe<PathNoteChangedPayload>('flowix:path-note-changed', (payload) => {
    deliver(normalizeNotebookChange(payload));
  }, options);
  return () => {
    active = false;
    localHandlers.delete(deliver);
    for (const deferred of pendingPathRenames.values()) deferred.delete(deliver);
    stop();
  };
}
