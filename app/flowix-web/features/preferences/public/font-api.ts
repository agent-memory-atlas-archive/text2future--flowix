import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { FONT_FAMILY_OPTIONS } from '@/lib/constants';
import { fontCache } from '@platform/tauri/client';
export { ensureDownloadedFontRegistered } from '@features/preferences/font-cache';

export function useTypographyFontId(): string | undefined {
  return useUserSettingsStore((state) => {
    const { fontFamily } = state.settings.format;
    return FONT_FAMILY_OPTIONS.find((font) => font.value === fontFamily)?.id;
  });
}

export function beginTypographyFontSelection(): Promise<number> {
  return fontCache.beginSelection();
}

export async function commitTypographyFontSelection(selectionId: number, fontId: string): Promise<boolean> {
  const font = FONT_FAMILY_OPTIONS.find((option) => option.id === fontId);
  if (!font) throw new Error(`Unsupported font id: ${fontId}`);
  const committed = await fontCache.commitSelection(selectionId, font.id, font.value);
  if (!committed) return false;
  useUserSettingsStore.getState().applyTypographyFont(font.id, font.value);
  return true;
}
