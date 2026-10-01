import { describe, expect, it, vi } from 'vitest';
import type { NoteListItem } from '@/types/note-item';
import { NOTE_COLORS } from '@features/memo/store/note-store';
import type { NativeMenuIconImage } from '@platform/tauri/native-menu-icons';
import { buildMemoCardContextMenuItems } from './memo-card-context-menu';

const memo = {
  kind: 'path-note',
  notebookId: 'notebook-1',
  relativePath: 'note.md',
  title: 'Note',
  favorited: true,
  colors: ['blue'],
} as NoteListItem;

const labels = {
  openInSplit: 'Open in split',
  pin: 'Pin',
  unpin: 'Unpin',
  properties: 'Properties',
  copyLink: 'Copy link',
  copyFullText: 'Copy full text',
  reveal: 'Reveal',
  colorGroup: 'Color',
  clearColor: 'Clear color',
  delete: 'Delete',
  colors: Object.fromEntries(NOTE_COLORS.map((color) => [color, color])) as Record<typeof NOTE_COLORS[number], string>,
};

describe('memo card context menu builder', () => {
  it('keeps the memo action order and toggles colors from the native submenu', () => {
    const onColorsChange = vi.fn();
    const items = buildMemoCardContextMenuItems({
      memo,
      labels,
      icons: {
        split: {} as NativeMenuIconImage,
        pin: {} as NativeMenuIconImage,
        unpin: {} as NativeMenuIconImage,
        info: {} as NativeMenuIconImage,
        link: {} as NativeMenuIconImage,
        copy: {} as NativeMenuIconImage,
        folderOpen: {} as NativeMenuIconImage,
        palette: {} as NativeMenuIconImage,
        delete: {} as NativeMenuIconImage,
      },
      onOpenInSplit: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onOpenProperties: vi.fn(),
      onCopyLink: vi.fn(),
      onCopyFullText: vi.fn(),
      onReveal: vi.fn(),
      onColorsChange,
      onDelete: vi.fn(),
    });

    expect(items.map((item) => 'text' in item ? item.text : item.item)).toEqual([
      'Open in split',
      'Unpin',
      'Properties',
      'Separator',
      'Copy link',
      'Copy full text',
      'Reveal',
      'Separator',
      'Color',
      'Separator',
      'Delete',
    ]);

    const colorMenu = items[8];
    if (!('items' in colorMenu) || !Array.isArray(colorMenu.items)) throw new Error('color submenu missing');
    const red = colorMenu.items.find((item) => 'text' in item && item.text === 'red');
    if (!red || !('action' in red) || !red.action) throw new Error('red color action missing');
    red.action('test');
    expect(onColorsChange).toHaveBeenCalledWith(['red', 'blue']);
  });

  it('keeps the color submenu expandable when color updates are unavailable', () => {
    const items = buildMemoCardContextMenuItems({
      memo,
      labels,
      icons: {
        split: {} as NativeMenuIconImage,
        pin: {} as NativeMenuIconImage,
        unpin: {} as NativeMenuIconImage,
        info: {} as NativeMenuIconImage,
        link: {} as NativeMenuIconImage,
        copy: {} as NativeMenuIconImage,
        folderOpen: {} as NativeMenuIconImage,
        palette: {} as NativeMenuIconImage,
        delete: {} as NativeMenuIconImage,
      },
      onOpenInSplit: vi.fn(),
      onFavoriteToggle: vi.fn(),
      onOpenProperties: vi.fn(),
      onCopyLink: vi.fn(),
      onCopyFullText: vi.fn(),
      onReveal: vi.fn(),
      onDelete: vi.fn(),
    });

    const colorMenu = items[8];
    if (!('items' in colorMenu) || !Array.isArray(colorMenu.items)) throw new Error('color submenu missing');
    expect('enabled' in colorMenu ? colorMenu.enabled : undefined).not.toBe(false);
    expect(colorMenu.items.filter((item) => 'text' in item).every((item) => 'enabled' in item && item.enabled === false)).toBe(true);
  });
});
