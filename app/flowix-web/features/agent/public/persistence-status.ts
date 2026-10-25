/**
 * Agent 持久化状态的最小公开契约。
 *
 * 刻意不 import 任何 store：应用根只需要"缓存写失败"这一个信号，
 * 不应该为了它把 agent-data-store（近千行 + 平台客户端）拖进启动图。
 * store 侧派发同一个事件，两侧共用这一个常量，避免字符串漂移。
 */

export const AGENT_PERSISTENCE_STATUS_EVENT = 'flowix-agent-data-persistence-status';

export interface AgentPersistenceStatusDetail {
  error: string | null;
}

/** 订阅 Agent 缓存写失败信号；返回取消订阅函数。 */
export function subscribeAgentPersistenceError(
  onChange: (message: string | null) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AgentPersistenceStatusDetail>).detail;
    onChange(detail?.error ?? null);
  };
  window.addEventListener(AGENT_PERSISTENCE_STATUS_EVENT, handler);
  return () => window.removeEventListener(AGENT_PERSISTENCE_STATUS_EVENT, handler);
}
