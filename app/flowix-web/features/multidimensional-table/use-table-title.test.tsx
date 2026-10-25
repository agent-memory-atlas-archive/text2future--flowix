import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createTableDocument } from './model';
import { useTableTitle } from './use-table-title';
import { mutateCollectionFile } from '@features/collection/mutations';

vi.mock('@features/collection/mutations', () => ({ mutateCollectionFile: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  localStorage.clear(); vi.resetAllMocks();
});
function options() {
  return { session: {
    document: createTableDocument(), saving: false, setSaving: vi.fn(), reportSaveFailure: vi.fn(), setNotes: vi.fn(),
    resolvedNotebookId: 'nb', acceptContent: vi.fn(() => true), loadSequenceRef: { current: 1 }, isCurrentSession: vi.fn(() => true),
  }, filePath: '/notes/old.yaml', setFilePath: vi.fn(), notebookPath: '/notes', editable: true, onFilePathChange: vi.fn() };
}
it('synchronizes title visibility across mounted tables without saving files', async () => {
  const config = options();
  const controllers: ReturnType<typeof useTableTitle>[] = [];
  function Probe({ index }: { index: number }) { controllers[index] = useTableTitle(config); return null; }
  for (const index of [0, 1]) {
    const root = createRoot(document.createElement('div')); roots.push(root);
    await act(async () => root.render(<Probe index={index} />));
  }
  await act(async () => controllers[0].toggleTableTitleVisibility());
  expect(controllers.map(item => item.showTableTitle)).toEqual([false, false]);
  expect(mutateCollectionFile).not.toHaveBeenCalled();
});
it('applies a successful rename and rebases notes moved with the collection folder', async () => {
  const config = options();
  vi.mocked(mutateCollectionFile).mockResolvedValueOnce({
    content: 'renamed', filePath: '/notes/new/table.yaml',
    directoryMove: { previousRelativePath: 'old', relativePath: 'new' },
  } as Awaited<ReturnType<typeof mutateCollectionFile>>);
  let controller!: ReturnType<typeof useTableTitle>;
  function Probe() { controller = useTableTitle(config); return null; }
  const root = createRoot(document.createElement('div')); roots.push(root);
  await act(async () => root.render(<Probe />));
  await act(async () => controller.commitTableTitle('new'));
  expect(config.setFilePath).toHaveBeenCalledWith('/notes/new/table.yaml');
  expect(config.onFilePathChange).toHaveBeenCalledWith('/notes/new/table.yaml');
  expect(config.session.acceptContent).toHaveBeenCalledWith('renamed');
  expect(config.session.setSaving).toHaveBeenLastCalledWith(false);
  const rebase = config.session.setNotes.mock.calls[0][0];
  expect(rebase([{ relativePath: 'old/a.md' }, { relativePath: 'outside.md' }]))
    .toEqual([{ relativePath: 'new/a.md' }, { relativePath: 'outside.md' }]);
});
it('does not apply a rename reply to a superseded table session', async () => {
  const config = options();
  let controller!: ReturnType<typeof useTableTitle>;
  let finish!: (result: Awaited<ReturnType<typeof mutateCollectionFile>>) => void;
  vi.mocked(mutateCollectionFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  function Probe() { controller = useTableTitle(config); return null; }
  const root = createRoot(document.createElement('div')); roots.push(root);
  await act(async () => root.render(<Probe />));
  let pending!: Promise<void>;
  await act(async () => { pending = controller.commitTableTitle('new'); });
  config.session.isCurrentSession.mockReturnValue(false);
  await act(async () => {
    finish({ content: 'new content', filePath: '/notes/new.yaml' } as Awaited<ReturnType<typeof mutateCollectionFile>>);
    await pending;
  });
  expect(config.setFilePath).not.toHaveBeenCalled();
  expect(config.onFilePathChange).not.toHaveBeenCalled();
  expect(config.session.acceptContent).not.toHaveBeenCalled();
});
