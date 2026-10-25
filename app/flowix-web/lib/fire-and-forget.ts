import { createLogger } from '@/lib/logger';

const logger = createLogger('fire-and-forget');

/**
 * 显式表达"不等待这个 promise"的意图，同时保证异常不会变成 unhandled rejection。
 *
 * 用法：
 *   fireAndForget(actions.reloadPreferences(), 'user-config:reloadPreferences');
 *
 * 为什么不用裸 `void promise`：`void` 只是消掉 lint 的 no-floating-promises，
 * 失败时既不记录也没有任何用户可见反馈。这里把"忽略结果"和"记录失败"分开表达。
 */
export function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((error) => {
    logger.warn(`unhandled async failure: ${context}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
