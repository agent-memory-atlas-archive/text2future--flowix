/**
 * 运行中 Agent 的选择器与发布器。
 *
 * 这个模块会读 agent-session-store，因此**只能**出现在按需加载的路径上
 * （目前由 `AgentEventSubscription` 在 stage3 之后挂载）。笔记列表不 import 它，
 * 而是读 `running-agents-store` 里的轻量投影。
 */
import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  buildConversationRunIndex,
  type ConversationRunIndex,
  selectRunningAgentConversations,
} from '@features/agent/store/conversation-run-index';
import {
  buildRunningAgentTypeIndex,
  uniqueThreadIds,
  type RunningAgentTypeIndex,
} from '@features/agent/store/running-agent-projection';
import { publishRunningAgentTypeIndex } from '@features/agent/store/running-agents-store';

import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

type RunningAgentTypeIndexCache = {
  instances: Record<string, AgentConversationInstance> | null;
  runStateVersion: number | null;
  runIndex: ConversationRunIndex | null;
  typeIndex: RunningAgentTypeIndex | null;
};

const runningAgentTypeIndexCache: RunningAgentTypeIndexCache = {
  instances: null,
  runStateVersion: null,
  runIndex: null,
  typeIndex: null,
};

function hasSameRunIndex(
  previous: ConversationRunIndex | null,
  next: ConversationRunIndex,
): boolean {
  if (!previous) return false;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => previous[key] === next[key]);
}

function selectRunningAgentTypeIndex(
  state: ReturnType<typeof useAgentSessionStore.getState>,
): RunningAgentTypeIndex {
  const instances = state.conversationRegistry.instances;
  const previousInstances = runningAgentTypeIndexCache.instances;
  const previousRunIndex = runningAgentTypeIndexCache.runIndex;
  let runIndex: ConversationRunIndex;

  if (
    runningAgentTypeIndexCache.instances === instances
    && runningAgentTypeIndexCache.runStateVersion === state.runStateVersion
    && runningAgentTypeIndexCache.runIndex
  ) {
    runIndex = runningAgentTypeIndexCache.runIndex;
  } else {
    const nextRunIndex = buildConversationRunIndex(
      state.threadProjections,
      uniqueThreadIds(instances),
    );
    runIndex = hasSameRunIndex(runningAgentTypeIndexCache.runIndex, nextRunIndex)
      ? runningAgentTypeIndexCache.runIndex!
      : nextRunIndex;
    runningAgentTypeIndexCache.instances = instances;
    runningAgentTypeIndexCache.runStateVersion = state.runStateVersion;
    runningAgentTypeIndexCache.runIndex = runIndex;
  }

  // 只有消息变化时不递增 runStateVersion。此时直接返回缓存，O(1)，不扫投影。
  if (
    runningAgentTypeIndexCache.typeIndex
    && previousInstances === instances
    && previousRunIndex === runIndex
  ) {
    return runningAgentTypeIndexCache.typeIndex;
  }

  const runningInstances = selectRunningAgentConversations({ instances }, runIndex);
  const typeIndex = buildRunningAgentTypeIndex(runningInstances);
  runningAgentTypeIndexCache.typeIndex = typeIndex;
  return typeIndex;
}

/**
 * 把运行中投影发布到轻量 store。
 *
 * 挂载点必须是 stage3 之后（`AgentEventSubscription`），否则 session store 会
 * 重新回到启动图里，这个拆分就白做了。
 */
export function useRunningAgentTypeIndexPublisher(): void {
  const selector = useCallback(selectRunningAgentTypeIndex, []);
  const index = useAgentSessionStore(useShallow(selector));

  useEffect(() => {
    publishRunningAgentTypeIndex(index);
  }, [index]);
}
