import { createLogger } from '@/lib/logger';

const logger = createLogger('global-error');

export type UncaughtErrorKind = 'error' | 'rejection' | 'boundary';

/**
 * 一次未捕获错误的可序列化快照。
 * 只保留定位所需字段：不记录文档正文、文件路径等用户内容。
 */
export interface UncaughtErrorReport {
  kind: UncaughtErrorKind;
  message: string;
  stack?: string;
  /** 触发源，例如 window error 的 filename 或 'react-boundary'。 */
  source?: string;
  timestamp: number;
}

const MAX_RECENT = 50;
const recent: UncaughtErrorReport[] = [];
const listeners = new Set<(report: UncaughtErrorReport) => void>();
let installed = false;

function describe(input: unknown): { message: string; stack?: string } {
  if (input instanceof Error) {
    return { message: input.message || input.name, stack: input.stack };
  }
  if (typeof input === 'string') return { message: input };
  try {
    return { message: JSON.stringify(input) };
  } catch {
    return { message: String(input) };
  }
}

export function createErrorReport(
  kind: UncaughtErrorKind,
  input: unknown,
  source?: string,
): UncaughtErrorReport {
  const { message, stack } = describe(input);
  return { kind, message, stack, source, timestamp: Date.now() };
}

/**
 * 记录一次未捕获错误。
 *
 * `notify: false` 用于已经有 fallback UI 的场景（React 错误边界），
 * 避免同一个错误既显示错误页又弹 toast。
 */
export function reportUncaughtError(
  report: UncaughtErrorReport,
  options: { notify?: boolean } = {},
): void {
  recent.push(report);
  if (recent.length > MAX_RECENT) recent.shift();

  logger.error(report.kind === 'error' ? 'uncaught error' : 'unhandled rejection', {
    message: report.message,
    stack: report.stack ?? '<no stack>',
    source: report.source ?? 'unknown',
  });

  if (options.notify === false) return;
  for (const listener of listeners) {
    try {
      listener(report);
    } catch (listenerError) {
      logger.warn('uncaught error listener failed', {
        message: describe(listenerError).message,
      });
    }
  }
}

/** 订阅“需要提示给用户”的未捕获错误。返回取消订阅函数。 */
export function subscribeUncaughtErrors(
  listener: (report: UncaughtErrorReport) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 最近的未捕获错误，供诊断面板或 bug 反馈附带。 */
export function getRecentUncaughtErrors(): readonly UncaughtErrorReport[] {
  return recent;
}

/**
 * 安装全局兜底。必须在 React 渲染前调用一次（入口处），重复调用无副作用。
 *
 * 覆盖 window.onerror 与 unhandledrejection 两条路径——这两条都不会经过
 * React 错误边界，此前是完全不可观测的黑洞。
 */
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script/link）也会触发 error 事件，但没有错误对象；
    // 这类错误已有各自的降级路径，不进入全局兜底以免淹没真实崩溃。
    if (!(event instanceof ErrorEvent)) return;
    const input = event.error ?? event.message;
    if (!input) return;
    reportUncaughtError(createErrorReport('error', input, event.filename));
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportUncaughtError(createErrorReport('rejection', event.reason));
  });
}
