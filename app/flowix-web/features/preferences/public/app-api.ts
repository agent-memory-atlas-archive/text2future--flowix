import { useCallback } from 'react';
import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
export { useApplyFontSettings } from '@features/preferences/hooks/use-apply-font-settings';

export function useAppPreferencesViewModel() {
  const language = useUserSettings((settings) => settings.language);
  const format = useUserSettings((settings) => settings.format);
  const shortcutOverrides = useUserSettings((settings) => settings.shortcuts);
  const loadPreferences = useUserSettingsStore((state) => state.loadInitial);
  const loadPresets = usePropertyPresetStore((state) => state.load);
  const loadInitial = useCallback(async () => { await Promise.all([loadPreferences(), loadPresets()]); }, [loadPreferences, loadPresets]);
  const flushPending = useUserSettingsStore((state) => state.flushPending);
  return { language, format, shortcutOverrides, loadInitial, flushPending };
}

export function useAppUpdatePreferences() {
  const enabled = useUserSettings((settings) => settings.productUpdates.enabled);
  const loading = useUserSettingsStore((state) => state.isLoading);
  return { enabled, loading };
}
