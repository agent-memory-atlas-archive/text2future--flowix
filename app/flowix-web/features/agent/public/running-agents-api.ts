/**
 * 笔记列表需要的"运行中 Agent"投影。
 *
 * 首屏安全：这里只读一个扁平字符串表（`running-agents-store`），不碰
 * agent-session-store。真正的计算在 Agent 侧的 `running-agent-selector.ts`，
 * 它会读 session store，所以只能在按需 chunk 里运行。
 */
export {
  findRunningAgentTypeForMemo,
  type RunningAgentTypeIndex,
} from '@features/agent/store/running-agent-projection';

export { useRunningAgentsStore } from '@features/agent/store/running-agents-store';

import { useRunningAgentsStore } from '@features/agent/store/running-agents-store';
import type { RunningAgentTypeIndex } from '@features/agent/store/running-agent-projection';

/** 订阅派生的运行中投影；结果对象只在真的变化时换引用。 */
export function useRunningAgentTypeIndex(): RunningAgentTypeIndex {
  return useRunningAgentsStore((state) => state.index);
}
