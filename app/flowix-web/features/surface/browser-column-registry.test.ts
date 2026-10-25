import { describe, expect, it } from 'vitest';
import { getBrowserColumnSurfaceDefinition, browserColumnSurfaceSupports, type BrowserColumnSurface } from './browser-column-registry';
import { workspaceSurfaceRendererRegistry } from './workspace-surface-renderer-registry';

const base = { surfaceId: 'tab-1', instanceKey: 'tab:tab-1' };

describe('Browser surface adapter', () => {
  it('uses common appearance and capabilities for conversation, media and web', () => {
    const surfaces: BrowserColumnSurface[] = [
      { ...base, kind: 'agent-conversation', instanceId: 'agent-1' },
      { ...base, kind: 'media', fileIdentity: { path: '/book/a.png', displayId: 'a' }, notebookId: 'book', notebookPath: '/book', resourceKind: 'image' },
      { ...base, kind: 'web', url: 'https://example.com', title: 'example', runtime: null },
    ];
    for (const surface of surfaces) {
      const definition = getBrowserColumnSurfaceDefinition(surface);
      expect(definition.appearance).toBe(workspaceSurfaceRendererRegistry[surface.kind].appearance);
      expect(definition.capabilities).toBe(workspaceSurfaceRendererRegistry[surface.kind].capabilities);
    }
  });

  it.each([
    ['/book/a.md', 'edit', true], ['/book/a.png', 'zoom', true], ['/book/a.png', 'edit', false],
    ['/book/a.docx', 'edit', false],
  ] as const)('derives %s capabilities from its active content', (path, capability, enabled) => {
    const surface: BrowserColumnSurface = {
      ...base, kind: 'file-browser', activeFilePath: path, fileIdentity: { path, displayId: path },
      scopePath: '/book', notebookId: 'book', folderPath: null, fileTreeVisible: false, fileTreeWidth: 220,
      documentProps: { isExternalDocument: true }, onSelectFile: () => {}, onOpenFileInNewTab: () => {},
      onContextChange: () => {}, onTreeVisibleChange: () => {}, onTreeWidthChange: () => {},
    };
    expect(browserColumnSurfaceSupports(surface, capability)).toBe(enabled);
  });
});
