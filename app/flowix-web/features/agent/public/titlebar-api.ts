/**
 * 工作区顶部的 Agent 会话标题栏。
 *
 * 单独成入口，是为了让 `main-layout` 能对它 `lazy()`：标题栏只在工作区当前
 * 目标是某个 Agent 会话时渲染，冷启动打开文档时根本用不到。它背后是
 * agent-session-store（约 220 文件 / 3.3 万行），静态 import 会把这套数据图
 * 绑进启动 chunk。不要再把它合回 `shell-api`。
 */
export { AgentConversationTitlebar } from '@features/agent/components/agent-conversation-titlebar';
