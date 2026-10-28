import type zhCN from './messages.pi-settings.zh-CN';

/**
 * English counterpart of the Pi settings message shard. The type annotation keeps
 * its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "preferences.pi.systemPrompt": "System prompt",
};

export default enUS;
