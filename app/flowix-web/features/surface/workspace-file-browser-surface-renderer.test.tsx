import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FileBrowserRenderer } from './workspace-file-browser-surface-renderer';
import type { WorkspaceSurfaceRenderContext, WorkspaceSurfaceRendererData } from './workspace-surface-renderer-contract';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';

const observations = vi.hoisted(() => ({ reads: vi.fn(), mounts: vi.fn(), unmounts: vi.fn() }));
vi.mock('./workspace-surface-renderer-registry', () => ({
  getWorkspaceSurfaceRendererDefinition: () => ({ render: (surface: { fileIdentity: { path: string } }, context: WorkspaceSurfaceRenderContext) => <Content path={surface.fileIdentity.path} report={context.reportPresentation} /> }),
}));
vi.mock('@features/workspace/public/collection-navigation-api', () => ({ resetCurrentCollectionView: vi.fn() }));
function Content({ path, report }: { path: string; report: WorkspaceSurfaceRenderContext['reportPresentation'] }) {
  useEffect(() => { observations.mounts(); return () => { observations.unmounts(); }; }, []);
  useEffect(() => { observations.reads(path); }, [path]);
  useEffect(() => { report?.({ state: { status: 'ready' } }); }, [report]);
  return <textarea defaultValue="retained editor state" />;
}
const surface: Extract<WorkspaceSurfaceRendererData, { kind: 'file-browser' }> = { kind: 'file-browser', props: {
  kind: 'file-browser', activeFilePath: '/notes/browser.md', fileIdentity: { path: '/notes/browser.md', displayId: 'browser-file' },
  folderPath: '/notes', scopePath: '/notes', notebookId: 'notes', fileTreeVisible: false, fileTreeWidth: 220,
  documentProps: { isExternalDocument: true, externalScopePath: '/notes', documentSessionMode: 'isolated', workspaceHost: 'browser-column' },
  onSelectFile: () => {}, onOpenFileInNewTab: () => {}, onContextChange: () => {}, onSelectFolder: () => {}, onTreeVisibleChange: () => {}, onTreeWidthChange: () => {},
} };
let root: ReturnType<typeof createRoot>;
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.clearAllMocks(); });
it('does not restart loading or replace a ready editor when layout, focus or reporting callbacks change', async () => {
  const node = document.createElement('div');
  root = createRoot(node);
  const updates: SurfacePresentationUpdate[] = [];
  const render = async (focused: boolean) => act(async () => root.render(<FileBrowserRenderer
    surface={{ ...surface, props: { ...surface.props } }}
    context={{ host: 'browser-column', viewId: 'browser-view', focused, readOnly: false, reportPresentation: (update) => { updates.push(update); } }}
  />));
  await render(true);
  const editor = node.querySelector('textarea')!;
  editor.value = 'unsaved browser draft';
  editor.scrollTop = 27;
  updates.length = 0;
  await render(false);
  await render(true);
  expect(updates.filter((update) => update.state?.status === 'loading')).toEqual([]);
  expect(observations.reads).toHaveBeenCalledOnce();
  expect(observations.mounts).toHaveBeenCalledOnce();
  expect(observations.unmounts).not.toHaveBeenCalled();
  expect(node.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('unsaved browser draft');
  expect(editor.scrollTop).toBe(27);
});
