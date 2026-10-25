/**
 * 应用根的 Agent 能力入口。
 *
 * 这里的每个导出都必须是"薄"的：应用根在首屏同步执行它们，任何静态 store
 * import 都会把整条 agent 数据图拖进启动 chunk。需要 store 的动作一律用
 * 动态 import 包在函数体里。
 */

import { fireAndForget } from '@/lib/fire-and-forget';

export {
  AGENT_PERSISTENCE_STATUS_EVENT,
  subscribeAgentPersistenceError,
  type AgentPersistenceStatusDetail,
} from '@features/agent/public/persistence-status';

/**
 * 让 DSH 模型配置缓存失效。
 *
 * 同样走动态 import：dsh-model-config-store 会带出 agent-data-store，
 * 而后者连带模型目录与会话投影。配置变更本身是低频路径，不值得为首屏解析它。
 */
export function invalidateDshModelConfigs(): void {
  fireAndForget(
    import('@features/agent/store/dsh-model-config-store')
      .then((module) => module.invalidateDshModelConfigs()),
    'agent:invalidate-dsh-model-configs',
  );
}

/**
 * 强制刷新 Agent 运行时状态。
 *
 * 只在配置变更等低频路径调用，因此把 store 放在动态 import 里：
 * 首屏不为它付解析成本，第一次真正需要时再加载。
 */
export function refreshAgentRuntime(options?: { force?: boolean }): void {
  fireAndForget(
    import('@features/agent/store/agent-runtime-store').then(({ useAgentRuntimeStore }) =>
      useAgentRuntimeStore.getState().refresh(options)),
    'agent:refresh-runtime',
  );
}
