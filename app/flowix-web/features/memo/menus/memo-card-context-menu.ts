import type { NoteColor, NoteListItem } from '@/types/note-item';
import { NOTE_COLORS } from '@features/memo/store/note-store';
import type { NativeContextMenuItems } from '@platform/tauri/native-context-menu';
import type { NativeMenuIconImage } from '@platform/tauri/native-menu-icons';

export interface MemoCardContextMenuLabels {
  openInSplit: string;
  pin: string;
  unpin: string;
  properties: string;
  copyLink: string;
  copyFullText: string;
  reveal: string;
  colorGroup: string;
  clearColor: string;
  delete: string;
  colors: Record<NoteColor, string>;
}

export function buildMemoCardContextMenuItems({
  memo,
  labels,
  icons,
  onOpenInSplit,
  onFavoriteToggle,
  onOpenProperties,
  onCopyLink,
  onCopyFullText,
  onReveal,
  onColorsChange,
  onDelete,
}: {
  memo: NoteListItem;
  labels: MemoCardContextMenuLabels;
  icons: {
    split: NativeMenuIconImage;
    pin: NativeMenuIconImage;
    unpin: NativeMenuIconImage;
    info: NativeMenuIconImage;
    link: NativeMenuIconImage;
    copy: NativeMenuIconImage;
    folderOpen: NativeMenuIconImage;
    palette: NativeMenuIconImage;
    delete: NativeMenuIconImage;
  };
  onOpenInSplit?: () => void;
  onFavoriteToggle: () => void;
  onOpenProperties: () => void;
  onCopyLink: () => void;
  onCopyFullText: () => void;
  onReveal: () => void;
  onColorsChange?: (colors: NoteColor[]) => void;
  onDelete: () => void;
}): NativeContextMenuItems {
  const selected = new Set(memo.colors);
  const canChangeColors = Boolean(onColorsChange);
  const colorItems = [
    {
      text: labels.clearColor,
      checked: memo.colors.length === 0,
      enabled: canChangeColors,
      action: () => onColorsChange?.([]),
    },
    { item: 'Separator' as const },
    ...NOTE_COLORS.map((color) => ({
      text: labels.colors[color],
      checked: selected.has(color),
      enabled: canChangeColors,
      action: () => {
        if (!onColorsChange) return;
        const next = new Set(selected);
        if (next.has(color)) next.delete(color);
        else next.add(color);
        onColorsChange(NOTE_COLORS.filter((value) => next.has(value)));
      },
    })),
  ];

  return [
    ...(onOpenInSplit ? [{ text: labels.openInSplit, icon: icons.split, action: onOpenInSplit }] : []),
    { text: memo.favorited ? labels.unpin : labels.pin, icon: memo.favorited ? icons.unpin : icons.pin, action: onFavoriteToggle },
    { text: labels.properties, icon: icons.info, action: onOpenProperties },
    { item: 'Separator' },
    { text: labels.copyLink, icon: icons.link, action: onCopyLink },
    { text: labels.copyFullText, icon: icons.copy, action: onCopyFullText },
    { text: labels.reveal, icon: icons.folderOpen, action: onReveal },
    { item: 'Separator' },
    // Keep the submenu itself enabled so macOS can always expand it. If the
    // caller cannot persist colors, disable only its child actions instead of
    // making the whole submenu appear to be missing.
    { text: labels.colorGroup, icon: icons.palette, items: colorItems },
    { item: 'Separator' },
    { text: labels.delete, icon: icons.delete, action: onDelete },
  ];
}
