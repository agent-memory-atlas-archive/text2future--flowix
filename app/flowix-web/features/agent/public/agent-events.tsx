'use client';

import { useAgentEvents } from '@features/agent/hooks/use-agent-events';
import { useRunningAgentTypeIndexPublisher } from '@features/agent/store/running-agent-selector';

export interface AgentEventSubscriptionProps {
  /**
   * 由宿主注入：等待工作区恢复完成后再做首次 reconcile。
   * 用 prop 而不是直接 import app 层模块，避免 public 入口反向依赖组合根。
   */
  waitForWorkspaceRestore?: () => Promise<void>;
}

/**
 * Agent 实时事件订阅。
 *
 * 单独成模块的原因只有一个：它的依赖闭包是 agent-session-store 那条链
 * （约 220 文件 / 3.3 万行），而这份数据在首屏没有任何消费者。宿主通过
 * `lazy()` + stage3 闸门把它推到工作台首帧之后挂载，启动 chunk 因此不再
 * 包含整个会话数据图。
 *
 * 迟到不会丢状态：`useAgentEvents` 挂载时会 reconcile 活跃 run，并按
 * gateway 的历史接口补齐断连期间的增量（Tauri events 本身是瞬时的）。
 */
export function AgentEventSubscription({ waitForWorkspaceRestore }: AgentEventSubscriptionProps) {
  useAgentEvents(waitForWorkspaceRestore);
  // 运行中投影也要在这里发布：它同样要读 session store，笔记列表的角标读的是
  // 发布出去的轻量表（见 running-agents-store）。
  useRunningAgentTypeIndexPublisher();
  return null;
}
