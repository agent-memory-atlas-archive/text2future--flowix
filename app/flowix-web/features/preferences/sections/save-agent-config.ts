import type { AgentConfig } from '@platform/tauri/client';

export interface AgentConfigStore {
  get: () => Promise<{ model: AgentConfig }>;
  list?: () => Promise<{ model: AgentConfig }[]>;
  set: (config: AgentConfig) => Promise<void>;
  add?: (config: AgentConfig) => Promise<void>;
}

/** A failed read after a successful write must never invite a second append. */
export async function saveAgentConfig(
  store: AgentConfigStore,
  config: AgentConfig,
  options: { append: boolean; refreshDirectory: boolean },
): Promise<{ config: AgentConfig; listed: AgentConfig[] | null; refreshFailed: boolean }> {
  const append = options.append && Boolean(store.add);
  if (append) await store.add!(config);
  else await store.set(config);

  try {
    const listed = options.refreshDirectory && store.list ? await store.list() : null;
    const route = config.providerId?.trim() || config.provider;
    const persisted = listed?.find((entry) => (entry.model.providerId?.trim() || entry.model.provider) === route)?.model
      ?? (append ? (await store.get()).model : config);
    if ((persisted.providerId?.trim() || persisted.provider) !== route) {
      throw new Error('Read-back returned a different model route');
    }
    return { config: persisted, listed: listed?.map((entry) => entry.model) ?? null, refreshFailed: false };
  } catch (error) {
    console.warn('[saveAgentConfig] Configuration saved but refresh failed', error);
    return { config, listed: null, refreshFailed: true };
  }
}

export function upsertAgentConfig(configs: AgentConfig[], config: AgentConfig): AgentConfig[] {
  const route = config.providerId?.trim() || config.provider;
  const index = configs.findIndex((entry) => (entry.providerId?.trim() || entry.provider) === route);
  return index < 0 ? [...configs, config] : configs.map((entry, i) => i === index ? config : entry);
}
