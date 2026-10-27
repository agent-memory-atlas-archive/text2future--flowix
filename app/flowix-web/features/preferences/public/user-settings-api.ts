import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

/**
 * User settings the agent task panel needs. Exposed as narrow functions rather
 * than the store itself so consuming features cannot reach into unrelated
 * preference groups.
 */
export function useRecentAgentConversationsLimit(): number {
  return useUserSettingsStore((state) => state.settings.recentAgentConversationsLimit);
}

export function getRecentAgentConversationsLimit(): number {
  return useUserSettingsStore.getState().settings.recentAgentConversationsLimit;
}

export function setRecentAgentConversationsLimit(limit: number): Promise<void> {
  return useUserSettingsStore.getState().updateSettings({ recentAgentConversationsLimit: limit });
}
