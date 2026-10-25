/**
 * Workspace 侧需要的 Agent 会话级操作。
 *
 * 这两个动作必须读 agent-session-store（约 220 个文件 / 3.3 万行）。它曾经和
 * 目录查询一起放在 `workspace-api.ts` 里静态导入，结果整个会话数据图被拖进了
 * 启动 chunk —— 而这两个函数在首屏根本不会被调用：它们只在"恢复某个 Agent
 * 会话"时发生，那是用户主动导航触发的。
 *
 * 因此 store 只能出现在函数体内部的动态 import 里。`hasWorkspaceAgentConversation`
 * 也因此变成异步：调用点本来就在 async 流程中（恢复会话）。
 */

/** Restore a persisted conversation through the Agent-owned session lifecycle. */
export async function hydrateWorkspaceAgentConversation(instanceId: string) {
  const { useAgentSessionStore } = await import('@features/agent/store/agent-session-store');
  return useAgentSessionStore.getState().hydrateInstance(instanceId);
}

/** Whether the current process already has this conversation instance in memory. */
export async function hasWorkspaceAgentConversation(instanceId: string): Promise<boolean> {
  const { useAgentSessionStore } = await import('@features/agent/store/agent-session-store');
  return useAgentSessionStore.getState().getInstance(instanceId) !== null;
}
