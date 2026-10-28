import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeItem } from '@platform/tauri/client';

const setDocumentPropertiesMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@features/document/public/path-properties', () => ({
  setDocumentProperties: setDocumentPropertiesMock,
}));

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
}));

vi.mock('@shared/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useContextMenuContext: () => ({ openAt: vi.fn() }),
}));
vi.mock('@features/memo/components/memo-card-actions', () => ({ MemoCardActions: () => null }));
vi.mock('@features/memo/components/notebook-create-context-menu', () => ({ NotebookCreateContextMenuItems: () => null }));
vi.mock('@features/memo/components/notebook-copy-context-menu', () => ({ NotebookCopyContextMenu: () => null }));

import { NotebookTreeRow } from './notebook-tree-row';
import { PROPERTY_ICON_OPTIONS } from '@features/document/properties/property-icons';

function noteItem(fullPath: string): DocTreeItem {
  return {
    id: fullPath,
    fullPath,
    name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: 0,
    modifiedMs: null,
    createdMs: null,
    memoCreatedMs: null,
    memoMeta: { icon: null, colors: [], favorited: false },
  } as unknown as DocTreeItem;
}

describe('NotebookTreeRow note icon picker', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setDocumentPropertiesMock.mockClear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  async function mountNote(path = '/notes/a.md') {
    const noop = vi.fn();
    await act(async () => root.render(
      <NotebookTreeRow
        item={noteItem(path)}
        notebookPath="/notes"
        parentPath="/notes"
        depth={0}
        expanded={false}
        active={false}
        selected={false}
        onToggle={noop}
        onOpen={noop}
        onCreateNote={noop}
        onCreateFolder={noop}
        onCreateView={noop}
        onCreateMediaLibrary={noop}
        onRename={noop}
        onPointerDown={noop}
      />,
    ));
    return path;
  }

  it('writes flowix_icon when an icon is picked from the note icon popover', async () => {
    const path = await mountNote();
    const trigger = host.querySelector<HTMLElement>('button[aria-label="document.properties.icon.placeholder"]');
    expect(trigger).not.toBeNull();

    await act(async () => { trigger!.click(); });

    const option = PROPERTY_ICON_OPTIONS[0];
    const optionButton = Array.from(document.body.querySelectorAll<HTMLElement>('button[aria-label]'))
      .find((el) => el.getAttribute('aria-label') === option.label && el !== trigger);
    expect(optionButton).toBeTruthy();

    await act(async () => { optionButton!.click(); });

    expect(setDocumentPropertiesMock).toHaveBeenCalledTimes(1);
    expect(setDocumentPropertiesMock).toHaveBeenCalledWith(path, { flowix_icon: option.value });
  });
});
