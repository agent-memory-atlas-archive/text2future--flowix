/**
 * 状态栏里的 Agent 片段与运行时状态判定的窄入口。
 *
 * 状态栏是主窗口常驻 UI，必须保持轻。会话片段（`AgentConversationStatusBar`）
 * 会读 agent-session-store，调用方要用 `lazy()`；这里的运行时判定是纯函数，
 * 可以静态引用。
 */
export { AgentConversationStatusBar } from '@features/agent/components/agent-conversation-status-bar';
export { normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
