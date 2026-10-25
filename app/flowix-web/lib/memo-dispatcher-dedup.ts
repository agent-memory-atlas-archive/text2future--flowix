/**
 * Coalesce same-note updates within 50ms, keeping the latest payload and merging
 * derived-change flags. Keys are (notebookId, relativePath).
 *
 * Create/delete events cancel pending updates and dispatch immediately. Tag
 * operations flush affected updates before dispatch; derived-only and stale
 * revision events still forward their derived invalidations separately.
 *
 * Register this middleware last when it must run before other middleware.
 */

import type { DispatcherMiddleware } from '@/lib/event-dispatcher';
import type { MemoEvent, MemoDerivedRefresh } from '@/types/memo';

/**
 * 取 MemoEvent 的 dedup key。三种 kind 都按笔记相对路径定位:
 * - created → e.memo.relativePath
 * - updated → e.memo.relativePath
 * - deleted → e.relativePath
 * - tags_renamed → 返回 `undefined` (立即派发, 不 dedup) ── 它不是
 *   单条笔记事件, 没有笔记路径维度; 短时间内多次 rename 也应该
 *   各自生效, 不能合并。
 *
 * 返回 `undefined` 表示此事件不参与 dedup (立即 next)。
 */
function memoEventKey(event: MemoEvent): string | undefined {
  // Path-keyed dedup: (notebookId, relativePath) identifies a note.
  if (event.kind === 'created')
    return JSON.stringify([event.notebookId, event.memo.relativePath]);
  if (event.kind === 'updated')
    return JSON.stringify([event.notebookId, event.memo.relativePath]);
  if (event.kind === 'deleted') return JSON.stringify([event.notebookId, event.relativePath]);
  // Tag operations affect multiple paths and dispatch immediately.
  return undefined;
}

/**
 * 创建 update 合并中间件；create / delete 不延迟。
 *
 * 用法 (在应用启动早期调一次):
 *
 *   import { installMemoMiddleware } from '@/lib/memo-dispatcher';
 *   import { createMemoDedupMiddleware } from '@/lib/memo-dispatcher-dedup';
 *
 *   installMemoMiddleware(createMemoDedupMiddleware({ delay: 50 }));
 */
export interface CreateMemoDedupMiddlewareOptions {
  onDiscardedDerivedChange?: (event: MemoDerivedRefresh) => void;
  /** 合并窗口, 默认 50ms。 */
  delay?: number;
  /** 自定义 key 提取, 默认按笔记路径。 */
  getKey?: (event: MemoEvent) => string | undefined;
}

export function createMemoDedupMiddleware(
  options: CreateMemoDedupMiddlewareOptions = {},
): DispatcherMiddleware<MemoEvent> {
  const delay = options.delay ?? 50;
  const getKey = options.getKey ?? memoEventKey;
  // key → [最后事件, timer 句柄]
  const pending = new Map<string, [MemoEvent, ReturnType<typeof setTimeout>]>();
  const revisions = new Map<string, number>();

  return (next) => (event) => {
    if ('derivedOnly' in event && event.derivedOnly === true) {
      if ('derivedChanged' in event && Object.values(event.derivedChanged).some(Boolean)) {
        options.onDiscardedDerivedChange?.({ notebookId: event.notebookId, derivedChanged: { ...event.derivedChanged } });
      }
      return;
    }
    const key = getKey(event);
    if (!key) {
      if (event.kind === 'tags_renamed' || event.kind === 'tags_deleted') {
        const affected = new Set(event.affectedRelativePaths);
        for (const [pendingKey, [queued, timer]] of pending) {
          if (queued.kind === 'updated' && queued.notebookId === event.notebookId && affected.has(queued.memo.relativePath ?? queued.memo.filename)) {
            clearTimeout(timer);
            pending.delete(pendingKey);
            next(queued);
          }
        }
      }
      // 无 key (理论上不会发生, 但兜底) — 立即派发。
      next(event);
      return;
    }

    if ('revision' in event && Number.isSafeInteger(event.revision) && event.revision! > 0) {
      const previous = revisions.get(key);
      if (previous !== undefined && event.revision! < previous) {
        if ('derivedChanged' in event && Object.values(event.derivedChanged).some(Boolean)) {
          options.onDiscardedDerivedChange?.({
            notebookId: event.notebookId,
            derivedChanged: { ...event.derivedChanged },
          });
        }
        return;
      }
      revisions.delete(key);
      revisions.set(key, event.revision!);
      if (revisions.size > 10_000) revisions.delete(revisions.keys().next().value!);
    }

    if (event.kind !== 'updated') {
      const existing = pending.get(key);
      if (existing) {
        clearTimeout(existing[1]);
        pending.delete(key);
      }
      next(event);
      return;
    }

    const existing = pending.get(key);
    let merged = event;
    if (existing) {
      // 同 key 已 pending → 清旧 timer, 用新事件覆盖。
      clearTimeout(existing[1]);
      const previous = existing[0];
      if (previous.kind === 'updated') {
        merged = {
          ...event,
          derivedChanged: {
            tags: previous.derivedChanged.tags || event.derivedChanged.tags,
            todos: previous.derivedChanged.todos || event.derivedChanged.todos,
            agents: previous.derivedChanged.agents || event.derivedChanged.agents,
          },
        };
      }
    }

    const timer = setTimeout(() => {
      const slot = pending.get(key);
      if (!slot) return;
      pending.delete(key);
      next(slot[0]);
    }, delay);
    pending.set(key, [merged, timer]);
  };
}
