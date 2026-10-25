/**
 * Agent 图标的公开入口。
 *
 * shell / preferences / memo 只需要画一枚图标，不应该因此获得整个 agent 的
 * 会话与运行时数据图。图标本身只依赖 `lib/agent-types`，从 public 走可以避免
 * 调用方去 import `components/agent-icon` 这种私有路径。
 */
export { AgentIcon, type AgentIconProps } from '@features/agent/components/agent-icon';
export {
  THEME_ADAPTIVE_AGENT_ICON_KEYS,
  isThemeAdaptiveAgentIcon,
} from '@features/agent/components/agent-icon';
