import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { files, type DocTreeItem } from '@platform/tauri/client';
import { renameWorkspaceFile } from '@features/workspace/public/shell-api';
import { toast } from '@/lib/toast';
import { useNotebookViewActions } from './use-notebook-view-actions';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@platform/tauri/client', () => ({ files: { delete: vi.fn(), setTableDocumentInViews: vi.fn(), setMediaLibraryInViews: vi.fn(), makeViewDocumentIdentityUnique: vi.fn() } }));
vi.mock('@features/workspace/public/shell-api', () => ({ renameWorkspaceFile: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let actions: ReturnType<typeof useNotebookViewActions>;
const refresh = vi.fn(async () => {});
const updateIdentity = vi.fn();
const path = '/notes/test.table.yml';
const item = { fullPath: path, name: 'test.table.yml' } as DocTreeItem;
const entry = { collectionId: 'collection', relativePath: 'test.table.yml', inViews: false };
type Options = Parameters<typeof useNotebookViewActions>[0];
let harnessOptions: Partial<Options> = {};
function Harness() {
  actions = useNotebookViewActions({ kind: 'table', notebookId: 'nb', notebookPath: '/notes', itemsByPath: new Map([[path, entry]]), refresh, updateIdentity, ...harnessOptions });
  return null;
}
async function render(overrides: Partial<Options> = {}) {
  harnessOptions = overrides;
  await act(async () => root.render(<Harness />));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(files.delete).mockResolvedValue(true);
  vi.mocked(files.makeViewDocumentIdentityUnique).mockResolvedValue('unique');
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('notebook view actions', () => {
  it.each(['table', 'media-library'] as const)('updates %s membership and refreshes its catalog', async (kind) => {
    await render({ kind });
    await act(async () => actions.visibilityByPath.get(path)!.onChange(true));
    const called = kind === 'table' ? files.setTableDocumentInViews : files.setMediaLibraryInViews;
    const other = kind === 'table' ? files.setMediaLibraryInViews : files.setTableDocumentInViews;
    expect(called).toHaveBeenCalledWith('nb', 'collection', true);
    expect(other).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not refresh or report success when deletion fails', async () => {
    vi.mocked(files.delete).mockResolvedValue(false);
    await render();
    await act(async () => actions.deleteItem(item));
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('memo.fileTree.deleteFailed');
  });

  it('does not refresh the catalog when the supplied deletion transaction returns false', async () => {
    const onDeleteFile = vi.fn(async () => false);
    await render({ onDeleteFile });
    await act(async () => actions.deleteItem(item));
    expect(onDeleteFile).toHaveBeenCalledWith(item);
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('delegates deletion to the supplied transaction before refreshing', async () => {
    const onDeleteFile = vi.fn(async () => {});
    await render({ onDeleteFile });
    await act(async () => actions.deleteItem(item));
    expect(onDeleteFile).toHaveBeenCalledWith(item);
    expect(files.delete).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps successful identity repair when the following catalog refresh fails', async () => {
    refresh.mockRejectedValueOnce(new Error('refresh failed'));
    await render({ kind: 'media-library' });
    await act(async () => actions.visibilityByPath.get(path)!.onMakeIdentityUnique());
    expect(updateIdentity).toHaveBeenCalledWith('test.table.yml', 'unique');
    expect(toast.success).toHaveBeenCalledWith('mediaLibrary.identityRegenerated');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('renames using the current catalog identity after a catalog update', async () => {
    await render();
    await render({ itemsByPath: new Map([[path, { ...entry, collectionId: 'reloaded-identity' }]]) });
    await act(async () => actions.renameTable(item, 'Renamed'));
    expect(renameWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ collectionId: 'reloaded-identity', name: 'Renamed.table.yml' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
