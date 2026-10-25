import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { getCurrentWindow } from '@platform/tauri/window';
import { windows, type ExternalDocumentChangedEvent } from '@platform/tauri/client';
import { subscribe, type UnlistenFn } from '@platform/tauri/event-bus';
import { consumeExpectedExternalDocumentEvent } from './external-document-operation';

export interface ExternalDocumentChangeContext {
  runOnce<T>(key: string, operation: () => T | Promise<T>): Promise<T>;
}

// Listener recovery is an invalidation, not a fabricated native revision.
export type ExternalDocumentChange = ExternalDocumentChangedEvent | { kind: 'invalidated'; path: string };

type ExternalDocumentChangeHandler = (
  event: ExternalDocumentChange,
  context: ExternalDocumentChangeContext,
) => void | Promise<void>;

interface WatchGroup {
  key: string;
  path: string;
  scopePath: string | null;
  subscribers: Map<symbol, ExternalDocumentChangeHandler>;
  active: boolean;
  leaseId: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempts: number;
}

const logger = createLogger('external-document-watch');
const watchGroups = new Map<string, WatchGroup>();
const recentEvents = new Map<string, number>();
const EVENT_DEDUP_WINDOW_MS = 2_000;
const MAX_RECENT_EVENTS = 512;
const WATCH_RETRY_BASE_MS = 1000;
const WATCH_RETRY_MAX_MS = 30_000;
let eventUnlisten: UnlistenFn | null = null;

function watchGroupKey(path: string, scopePath: string | null): string {
  return JSON.stringify([path, scopePath]);
}

function eventKey(path: string, event: ExternalDocumentChangedEvent): string {
  return JSON.stringify([
    path,
    event.kind,
    event.revision,
    event.source ?? null,
    event.originWindowLabel ?? null,
  ]);
}

function isDuplicateEvent(key: string): boolean {
  const now = Date.now();
  for (const [recentKey, receivedAt] of recentEvents) {
    if (now - receivedAt > EVENT_DEDUP_WINDOW_MS) recentEvents.delete(recentKey);
  }
  const previous = recentEvents.get(key);
  if (previous !== undefined && now - previous <= EVENT_DEDUP_WINDOW_MS) return true;

  recentEvents.delete(key);
  recentEvents.set(key, now);
  while (recentEvents.size > MAX_RECENT_EVENTS) {
    const oldest = recentEvents.keys().next().value;
    if (oldest === undefined) break;
    recentEvents.delete(oldest);
  }
  return false;
}

function dispatchExternalDocumentChange(event: ExternalDocumentChange): void {
  const path = canonicalPath(event.path);
  const groups = [...watchGroups.values()].filter((group) => group.path === path && group.active);
  if (groups.length === 0) return;
  if (event.kind !== 'invalidated') {
    if (isDuplicateEvent(eventKey(path, event))) return;
    if (event.source === 'user_edit' && event.originWindowLabel === getCurrentWindow().label) return;
    if (consumeExpectedExternalDocumentEvent(path, event.kind, event.revision)) return;
  }

  // Several path/scope leases can target the same file in one window. Route a
  // matching revision once, while each mounted view updates its own local state.
  const subscribers = groups.flatMap((group) => [...group.subscribers.values()]);
  const sharedOperations = new Map<string, Promise<unknown>>();
  const context: ExternalDocumentChangeContext = {
    runOnce<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
      const existing = sharedOperations.get(key);
      if (existing) return existing as Promise<T>;
      const pending = Promise.resolve().then(operation);
      sharedOperations.set(key, pending);
      return pending;
    },
  };
  for (const handler of subscribers) {
    try {
      const result = handler(event, context);
      if (result && typeof result.then === 'function') {
        void result.catch((error: unknown) => logger.warn('change handler failed', { error }));
      }
    } catch (error) {
      logger.warn('change handler failed', { error });
    }
  }
}

function ensureEventSubscription(): void {
  if (eventUnlisten) return;
  eventUnlisten = subscribe<ExternalDocumentChangedEvent>(
    'external-document-changed',
    dispatchExternalDocumentChange,
    { onListenerReady: () => {
      recentEvents.clear();
      const paths = new Set([...watchGroups.values()].filter((group) => group.active).map((group) => group.path));
      for (const path of paths) dispatchExternalDocumentChange({ kind: 'invalidated', path });
    } },
  );
}

function registerWatch(group: WatchGroup): void {
  void windows.watchExternalDocument(group.path, group.scopePath).then((leaseId) => {
    if (!group.active || watchGroups.get(group.key) !== group) {
      void windows.unwatchExternalDocument(leaseId).catch((error: unknown) => {
        logger.warn('stale watcher lease cleanup failed', { error });
      });
      return;
    }
    group.leaseId = leaseId;
    if (group.retryAttempts > 0) {
      group.retryAttempts = 0;
      dispatchExternalDocumentChange({ kind: 'invalidated', path: group.path });
    }
  }).catch((error: unknown) => {
    if (group.active && watchGroups.get(group.key) === group) {
      const delay = Math.min(WATCH_RETRY_BASE_MS * 2 ** group.retryAttempts, WATCH_RETRY_MAX_MS);
      group.retryAttempts += 1;
      group.retryTimer = setTimeout(() => {
        group.retryTimer = null;
        registerWatch(group);
      }, delay);
      logger.warn('registration failed; retry scheduled', { error, delay });
    }
  });
}

function releaseWatchGroup(group: WatchGroup): void {
  group.active = false;
  if (group.retryTimer) clearTimeout(group.retryTimer);
  watchGroups.delete(group.key);
  if (group.leaseId) {
    void windows.unwatchExternalDocument(group.leaseId).catch((error: unknown) => {
      logger.warn('watcher lease cleanup failed', { path: group.path, error });
    });
  }
  if (watchGroups.size !== 0) return;
  eventUnlisten?.();
  eventUnlisten = null;
  recentEvents.clear();
}

/** Share native watch leases and event routing between views of the same file. */
export function subscribeExternalDocumentChanges(
  filePath: string,
  scopePath: string | null,
  handler: ExternalDocumentChangeHandler,
): () => void {
  const path = canonicalPath(filePath);
  const normalizedScopePath = scopePath ? canonicalPath(scopePath) : null;
  const key = watchGroupKey(path, normalizedScopePath);
  let group = watchGroups.get(key);
  if (!group) {
    group = {
      key,
      path,
      scopePath: normalizedScopePath,
      subscribers: new Map(),
      active: true,
      leaseId: null,
      retryTimer: null,
      retryAttempts: 0,
    };
    watchGroups.set(key, group);
    ensureEventSubscription();
    registerWatch(group);
  }

  const subscriptionId = Symbol('external-document-change-subscriber');
  group.subscribers.set(subscriptionId, handler);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    group?.subscribers.delete(subscriptionId);
    if (group && group.subscribers.size === 0 && watchGroups.get(key) === group) {
      releaseWatchGroup(group);
    }
  };
}
