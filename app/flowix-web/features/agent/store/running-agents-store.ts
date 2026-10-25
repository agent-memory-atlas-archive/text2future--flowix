/**
 * 运行中 Agent 的**轻量**投影 store。
 *
 * 存在的理由：笔记列表要给每张卡片画"正在运行"的角标，而真正的运行状态住在
 * agent-session-store 里（约 220 文件 / 3.3 万行）。如果 MemoList 直接订阅那个
 * store，整个会话数据图会被绑进启动 chunk。
 *
 * 所以拆成两半：
 *   - 本文件只有一个扁平字符串表，没有 store 依赖，可以被首屏安全订阅；
 *   - `running-agent-selector.ts` 在 Agent 侧计算，算完把结果发布到这里。
 *
 * 首帧的初始值是空表，这在语义上是**正确**的而不是降级：应用刚启动时不可能
 * 已有正在跑的会话；恢复出来的运行中会话会在 stage3（工作台首帧之后）补上。
 */
import { create } from 'zustand';

import {
  EMPTY_RUNNING_AGENT_TYPE_INDEX,
  type RunningAgentTypeIndex,
} from '@features/agent/store/running-agent-projection';

interface RunningAgentsStoreState {
  index: RunningAgentTypeIndex;
}

export const useRunningAgentsStore = create<RunningAgentsStoreState>(() => ({
  index: EMPTY_RUNNING_AGENT_TYPE_INDEX,
}));

/** 由 Agent 侧的选择器调用；传回上一次的对象引用可避免无意义的重渲染。 */
export function publishRunningAgentTypeIndex(index: RunningAgentTypeIndex): void {
  if (useRunningAgentsStore.getState().index === index) return;
  useRunningAgentsStore.setState({ index });
}
