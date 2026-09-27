import { recoveryDrafts } from '@platform/tauri/client/recovery';
import { canonicalPath } from '@/lib/path';
import { fileLocatorKey } from '@/lib/path';
import {
  documentLocator,
  documentLocatorKey,
  type DocumentIdentity,
  type DocumentLocator,
} from './document-identity';

const recoveryOperations = new Map<string, Promise<unknown>>();
const RECOVERY_READ_TIMEOUT_MS = 2_000;

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function enqueueRecoveryOperationForKeys<T>(
  keys: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const uniqueKeys = [...new Set(keys)];
  const previous = uniqueKeys.map((key) => recoveryOperations.get(key) ?? Promise.resolve());
  const current = Promise.all(previous.map((pending) => pending.catch(() => undefined)))
    .then(operation);
  for (const key of uniqueKeys) recoveryOperations.set(key, current);
  const cleanup = () => {
    for (const key of uniqueKeys) {
      if (recoveryOperations.get(key) === current) recoveryOperations.delete(key);
    }
  };
  void current.then(cleanup, cleanup);
  return current;
}

function enqueueRecoveryOperation<T>(identity: DocumentIdentity, operation: () => Promise<T>): Promise<T> {
  // Recovery follows the durable path so separate runtime display sessions
  // still serialize access to the same draft.
  return enqueueRecoveryOperationForKeys(
    [documentLocatorKey(documentLocator(identity))],
    operation,
  );
}

export interface RecoveryDraft {
  schemaVersion: 4;
  identity: DocumentLocator;
  originalPath: string;
  revision: number;
  content: string;
  baseContent: string;
  createdAt: number;
  updatedAt: number;
  reason: 'autosave' | 'save-timeout' | 'save-error' | 'shutdown';
}

interface PreviousRecoveryDraft extends Omit<RecoveryDraft, 'schemaVersion' | 'identity'> {
  schemaVersion: 2 | 3;
  identity: { kind: 'md'; memoId?: string | null; path: string };
}

interface LegacyRecoveryDraft extends Omit<RecoveryDraft, 'schemaVersion' | 'identity'> {
  schemaVersion: 1;
  identity:
    | { kind: 'memo'; id: string }
    | { kind: 'external'; path: string };
}

type StoredRecoveryDraft = RecoveryDraft | PreviousRecoveryDraft | LegacyRecoveryDraft;

function normalizeRecoveryDraft(
  draft: StoredRecoveryDraft | null,
): RecoveryDraft | null {
  if (!draft) return null;
  if (draft.schemaVersion === 2 || draft.schemaVersion === 3 || draft.schemaVersion === 4) {
    return {
      ...draft,
      schemaVersion: 4,
      identity: {
        kind: 'md',
        path: canonicalPath(draft.identity.path),
      },
    };
  }
  return {
    ...draft,
    schemaVersion: 4,
    identity: draft.identity.kind === 'memo'
      ? { kind: 'md', path: canonicalPath(draft.originalPath) }
      : { kind: 'md', path: canonicalPath(draft.identity.path) },
  };
}

function legacyExternalRecoveryKey(path: string): string {
  return `external:${canonicalPath(path)}`;
}

function recoveryDraftKey(
  draft: StoredRecoveryDraft,
): string {
  if (draft.schemaVersion === 1) {
    return draft.identity.kind === 'memo'
      ? `memo:${draft.identity.id}`
      : legacyExternalRecoveryKey(draft.identity.path);
  }
  if (draft.schemaVersion === 2 && draft.identity.memoId) {
    return `memo:${draft.identity.memoId}`;
  }
  return fileLocatorKey(draft.identity.path);
}

async function readStoredDraft(key: string): Promise<RecoveryDraft | null> {
  return (await readStoredDraftEntry(key))?.draft ?? null;
}

async function readStoredDraftEntry(key: string): Promise<{
  draft: RecoveryDraft;
  needsMigration: boolean;
} | null> {
  const stored = await recoveryDrafts.read<StoredRecoveryDraft>(key);
  const draft = normalizeRecoveryDraft(stored);
  if (!stored || !draft) return null;
  const hasLegacyMemoIdentity = stored.schemaVersion !== 1
    && 'memoId' in stored.identity;
  return {
    draft,
    needsMigration: stored.schemaVersion !== 4 || hasLegacyMemoIdentity,
  };
}

function legacyRecoveryKeys(identity: DocumentIdentity): string[] {
  return [
    ...(identity.memoId ? [`memo:${identity.memoId}`] : []),
    legacyExternalRecoveryKey(identity.path),
  ];
}

async function migrateDraft(
  draft: RecoveryDraft,
  sourceKey: string,
  targetKey: string,
  targetIdentity: DocumentLocator,
): Promise<boolean> {
  const migrated: RecoveryDraft = {
    ...draft,
    identity: targetIdentity,
  };
  const written = await recoveryDrafts.write(targetKey, migrated);
  if (written && sourceKey !== targetKey) {
    await recoveryDrafts.clearThrough(sourceKey, draft.revision).catch(() => false);
  }
  return written;
}

function isDraftNewer(left: RecoveryDraft, right: RecoveryDraft): boolean {
  return left.updatedAt > right.updatedAt
    || (left.updatedAt === right.updatedAt && left.revision > right.revision);
}

async function findLegacyMemoDraft(
  memoId: string,
): Promise<{ draft: RecoveryDraft; key: string; needsMigration: boolean } | null> {
  const drafts = await recoveryDrafts.list<StoredRecoveryDraft>().catch(() => []);
  const candidate = drafts.flatMap((stored) => {
    const draft = normalizeRecoveryDraft(stored);
    const storedMemoId = stored.schemaVersion === 1
      ? (stored.identity.kind === 'memo' ? stored.identity.id : null)
      : stored.schemaVersion === 2 || stored.schemaVersion === 3
        ? stored.identity.memoId ?? null
        : null;
    if (!draft || storedMemoId !== memoId) return [];
    return [{ draft, key: recoveryDraftKey(stored), needsMigration: true }];
  }).sort((left, right) => (
    right.draft.updatedAt - left.draft.updatedAt
    || right.draft.revision - left.draft.revision
  ))[0];
  return candidate ?? null;
}

async function readDraftForIdentity(
  identity: DocumentIdentity,
): Promise<{ draft: RecoveryDraft; key: string; needsMigration: boolean } | null> {
  const locator = documentLocator(identity);
  const key = documentLocatorKey(locator);
  const current = await readStoredDraftEntry(key);
  if (current) return { ...current, key };

  for (const legacyKey of legacyRecoveryKeys(identity)) {
    const legacy = await readStoredDraftEntry(legacyKey);
    if (legacy) return { ...legacy, key: legacyKey, needsMigration: true };
  }

  // A memo rename changes the canonical path key. Use memoId only as a
  // one-time migration hint for drafts written before that rename.
  if (identity.memoId) return findLegacyMemoDraft(identity.memoId);
  return null;
}

export async function persistRecoveryDraft(
  input: Omit<RecoveryDraft, 'schemaVersion' | 'identity' | 'createdAt' | 'updatedAt'> & {
    identity: DocumentIdentity;
  },
): Promise<boolean> {
  return enqueueRecoveryOperation(input.identity, async () => {
    const now = Date.now();
    const identity = documentLocator(input.identity);
    const key = documentLocatorKey(identity);
    const previous = await readDraftForIdentity(input.identity);
    const written = await recoveryDrafts.write(key, {
      ...input,
      identity,
      schemaVersion: 4,
      createdAt: previous?.draft.createdAt ?? now,
      updatedAt: now,
    });
    if (written && previous && previous.key !== key) {
      await recoveryDrafts.clearThrough(previous.key, previous.draft.revision).catch(() => false);
    }
    return written;
  }).catch(() => false);
}

export function readRecoveryDraft(identity: DocumentIdentity): Promise<RecoveryDraft | null> {
  const recoveryIdentity = documentLocator(identity);
  return settleWithin(enqueueRecoveryOperation(identity, async () => {
    const key = documentLocatorKey(recoveryIdentity);
    const stored = await readDraftForIdentity(identity);
    if (!stored) return null;
    const migratedDraft = {
      ...stored.draft,
      identity: recoveryIdentity,
      originalPath: recoveryIdentity.path,
      schemaVersion: 4 as const,
    };
    if (stored.key !== key || stored.needsMigration) {
      await migrateDraft(migratedDraft, stored.key, key, recoveryIdentity);
    }
    return {
      ...migratedDraft,
    };
  }), RECOVERY_READ_TIMEOUT_MS, null);
}

export async function clearRecoveryDraftThrough(
  identity: DocumentIdentity,
  savedRevision: number,
): Promise<void> {
  await enqueueRecoveryOperation(identity, async () => {
    const locator = documentLocator(identity);
    const key = documentLocatorKey(locator);
    await recoveryDrafts.clearThrough(key, savedRevision);
    for (const legacyKey of legacyRecoveryKeys(identity)) {
      await recoveryDrafts.clearThrough(legacyKey, savedRevision);
    }
  }).catch(() => undefined);
}

/** Move a path-keyed draft with its live document during an in-place rename. */
export function rebaseRecoveryDraftPath(identity: DocumentIdentity, nextPath: string): void {
  const previous = documentLocator(identity);
  const next = { ...previous, path: canonicalPath(nextPath) };
  if (!previous.path || !next.path || previous.path === next.path) return;

  const previousKey = documentLocatorKey(previous);
  const nextKey = documentLocatorKey(next);
  void enqueueRecoveryOperationForKeys([previousKey, nextKey], async () => {
    let sourceKey = previousKey;
    let source = await readStoredDraft(previousKey);
    if (!source) {
      for (const legacyKey of legacyRecoveryKeys(identity)) {
        source = await readStoredDraft(legacyKey);
        if (source) {
          sourceKey = legacyKey;
          break;
        }
      }
    }
    if (!source) return;

    const target = await readStoredDraft(nextKey);
    if (target && !isDraftNewer(source, target)) {
      await recoveryDrafts.clearThrough(sourceKey, source.revision).catch(() => false);
      return;
    }

    const migrated: RecoveryDraft = {
      ...source,
      identity: next,
      originalPath: next.path,
      schemaVersion: 4,
      updatedAt: Date.now(),
    };
    if (await recoveryDrafts.write(nextKey, migrated)) {
      await recoveryDrafts.clearThrough(sourceKey, source.revision).catch(() => false);
    }
  }).catch(() => undefined);
}

export function listRecoveryDrafts(): Promise<RecoveryDraft[]> {
  return settleWithin(
    recoveryDrafts.list<StoredRecoveryDraft>()
      .then((drafts) => {
        const normalizedDrafts = drafts.flatMap((draft) => {
          const normalized = normalizeRecoveryDraft(draft);
          return normalized ? [normalized] : [];
        });
        const unique = new Map<string, RecoveryDraft>();
        for (const draft of normalizedDrafts) {
          const key = fileLocatorKey(canonicalPath(draft.identity.path));
          const previous = unique.get(key);
          if (!previous
            || draft.updatedAt > previous.updatedAt
            || (draft.updatedAt === previous.updatedAt && draft.revision > previous.revision)) {
            unique.set(key, draft);
          }
        }
        return [...unique.values()];
      }),
    RECOVERY_READ_TIMEOUT_MS,
    [],
  );
}
