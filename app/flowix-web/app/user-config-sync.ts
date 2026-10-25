import { usePropertyPresetStore } from '@features/properties/property-preset-store';

import { fireAndForget } from '@/lib/fire-and-forget';

export type UserConfigChangeKind = 'preference' | 'property_presets' | 'ai_config' | 'dsh_config' | 'pi_config';

interface UserConfigSyncActions {
  reloadPreferences: () => void | Promise<void>;
  refreshAgentRuntime: () => void | Promise<void>;
}

/**
 * Route a persisted user-config change to the in-memory state it invalidates.
 *
 * Tauri windows run separate JavaScript contexts, so each window must update
 * its own stores after receiving the backend broadcast.
 */
export function syncUserConfigChange(
  kind: UserConfigChangeKind,
  actions: UserConfigSyncActions,
): void {
  if (kind === 'property_presets') {
    fireAndForget(
      usePropertyPresetStore.getState().load(),
      'user-config:property-presets',
    );
    return;
  }
  if (kind === 'preference') {
    fireAndForget(Promise.resolve(actions.reloadPreferences()), 'user-config:reload-preferences');
    return;
  }
  if (kind === 'pi_config') {
    fireAndForget(
      import('@features/agent/services/agent-catalog-service')
        .then(({ refreshAgentModelCatalog }) => refreshAgentModelCatalog('pi')),
      'user-config:refresh-pi-catalog',
    );
    return;
  }

  // Runtime freshness currently has one timestamp for the complete status
  // snapshot. Refresh the complete snapshot so unrelated agent statuses are
  // not marked fresh after only Flowix was updated.
  fireAndForget(Promise.resolve(actions.refreshAgentRuntime()), 'user-config:refresh-agent-runtime');
}
