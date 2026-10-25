/**
 * 运行中 Agent 的纯计算部分（无 store 依赖）。
 *
 * 值用编码字符串表达，让 Zustand 的浅比较能按值比较整个扁平结果：
 * 实例标题、消息投影等无关元数据变化时，MemoList 不会重新渲染。
 */
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import type { MemoItem } from '@/types/memo-item';

export type RankedAgent = {
  instance: AgentConversationInstance;
  order: number;
};

export type RunningAgentIndex = {
  byThreadId: Map<string, RankedAgent>;
};

export type RunningAgentTypeMatch = {
  agentType: AgentConversationInstance['agentType'];
  order: number;
};

export type RunningAgentTypeIndex = Readonly<Record<string, string>>;

export const EMPTY_RUNNING_AGENT_TYPE_INDEX: RunningAgentTypeIndex = {};

const TYPE_INDEX_SEPARATOR = '\u001f';

function threadIndexKey(threadId: string): string {
  return `thread:${threadId}`;
}

function encodeTypeMatch(match: RunningAgentTypeMatch): string {
  return `${match.order}${TYPE_INDEX_SEPARATOR}${match.agentType}`;
}

function decodeTypeMatch(value: string | undefined): RunningAgentTypeMatch | null {
  if (!value) return null;
  const separator = value.indexOf(TYPE_INDEX_SEPARATOR);
  if (separator < 0) return null;
  const order = Number(value.slice(0, separator));
  const agentType = value.slice(separator + TYPE_INDEX_SEPARATOR.length);
  if (!Number.isFinite(order) || !agentType) return null;
  return { agentType: agentType as AgentConversationInstance['agentType'], order };
}

/** Index running agents once, keeping the existing list-order priority. */
export function buildRunningAgentIndex(
  instances: readonly AgentConversationInstance[],
): RunningAgentIndex {
  const byThreadId = new Map<string, RankedAgent>();

  instances.forEach((instance, order) => {
    const ranked = { instance, order };
    const threadId = instance.threadId;
    if (threadId && !byThreadId.has(threadId)) byThreadId.set(threadId, ranked);
  });

  return { byThreadId };
}

/** Build the minimal lookup consumed by MemoCard from already-running agents. */
export function buildRunningAgentTypeIndex(
  instances: readonly AgentConversationInstance[],
): RunningAgentTypeIndex {
  const index: Record<string, string> = {};

  instances.forEach((instance, order) => {
    const match = encodeTypeMatch({ agentType: instance.agentType, order });
    const threadId = instance.threadId;
    if (threadId && !index[threadIndexKey(threadId)]) {
      index[threadIndexKey(threadId)] = match;
    }
  });

  return index;
}

export function uniqueThreadIds(
  instances: Record<string, AgentConversationInstance>,
): string[] {
  const ids = new Set<string>();
  for (const instance of Object.values(instances)) {
    if (instance.threadId) ids.add(instance.threadId);
  }
  return [...ids].sort();
}

export function findRunningAgentForMemo(
  index: RunningAgentIndex,
  memo: Pick<MemoItem, 'agents'>,
): AgentConversationInstance | null {
  let match: RankedAgent | undefined;

  for (const agent of memo.agents) {
    const candidate = index.byThreadId.get(agent.threadId);
    if (candidate && (!match || candidate.order < match.order)) {
      match = candidate;
    }
  }

  return match?.instance ?? null;
}

export function findRunningAgentTypeForMemo(
  index: RunningAgentTypeIndex,
  memo: Pick<MemoItem, 'agents'>,
): AgentConversationInstance['agentType'] | null {
  let match: RunningAgentTypeMatch | null = null;

  for (const agent of memo.agents) {
    const candidate = decodeTypeMatch(index[threadIndexKey(agent.threadId)]);
    if (candidate && (!match || candidate.order < match.order)) {
      match = candidate;
    }
  }

  return match?.agentType ?? null;
}
