/**
 * Application-level event routing with optional filters and middleware.
 * Tauri transport subscriptions live in `platform/tauri/event-bus`; this class
 * handles typed events after they enter the application layer.
 */

import { createLogger } from '@/lib/logger';

const logger = createLogger('event-dispatcher');

export type DispatcherMiddleware<T> = (next: DispatchFn<T>) => DispatchFn<T>;
export type DispatchFn<T> = (event: T) => void;
export type EventFilter<T> = (event: T) => boolean;
export type EventHandler<T> = (event: T) => void;
export type Unsubscribe = () => void;

interface Subscription<T> {
  readonly filter?: EventFilter<T>;
  readonly handler: EventHandler<T>;
}

/**
 * 应用层事件分发器。 单例 (通常模块级 export), 同步派发, handler
 * 抛错被捕获不中断其他 handler。
 */
export class EventDispatcher<T> {
  private readonly subs = new Set<Subscription<T>>();
  private dispatchFn: DispatchFn<T>;

  constructor() {
    // 初始 dispatch 直接走到 _rawDispatch; middleware 在 .use() 里包装。
    this.dispatchFn = (event: T) => this.rawDispatch(event);
  }

  /** Each middleware wraps the existing chain; the last registered runs first. */
  use(middleware: DispatcherMiddleware<T>): void {
    this.dispatchFn = middleware(this.dispatchFn);
  }

  /**
   * 同步派发事件。 先经过 middleware 链, 最终走到所有 filter 匹配的
   * handler。 filter / handler 抛错被记录, 不影响其他 handler。
   */
  dispatch(event: T): void {
    this.dispatchFn(event);
  }

  /**
   * 订阅事件。 `filter` 可选 — 不传则 handler 接收所有事件。
   *
   * 返回的 `unsubscribe()` 调用后立即生效; 内部拷贝迭代, handler 内
   * 主动 unsub 不会影响本次 dispatch。
   */
  subscribe(handler: EventHandler<T>, filter?: EventFilter<T>): Unsubscribe {
    const sub: Subscription<T> = filter ? { handler, filter } : { handler };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /**
   * 调试 / 测试用: 当前订阅数 (含 filter)。
   */
  size(): number {
    return this.subs.size;
  }

  private rawDispatch(event: T): void {
    // 拷贝避免 handler 内部 unsub 干扰本次迭代
    for (const sub of [...this.subs]) {
      try {
        if (sub.filter && !sub.filter(event)) continue;
        sub.handler(event);
      } catch (err) {
        logger.warn('subscriber failed', { error: err });
      }
    }
  }
}
