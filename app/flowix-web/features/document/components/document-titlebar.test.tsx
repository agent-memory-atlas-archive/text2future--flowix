import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentTitlebarMac } from './document-titlebar-mac';
import { DocumentTitlebarWin } from './document-titlebar-win';
import type { DocumentTitlebarProps } from './document-titlebar-model';

const mocks = vi.hoisted(() => ({ hideBrowser: vi.fn(), transfer: vi.fn() }));
vi.mock('@features/workspace/public/shell-api', () => ({
  useWorkColumnTransferViewModel: () => ({ canOpenInBrowserColumn: true, openInBrowserColumn: mocks.transfer }),
}));
vi.mock('@features/workspace/public/browser-column-api', () => ({ hideBrowserColumn: mocks.hideBrowser, toggleBrowserColumn: mocks.hideBrowser, useBrowserColumnVisible: () => true }));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
  translate: (_language: string, key: string) => key,
}));
vi.mock('./use-document-titlebar-actions', () => ({
  useDocumentTitlebarActions: () => ({
    colors: [], changeColors: vi.fn(), fontSwitch: {}, selectedFontSizeMode: null,
    setEditorFontSizeMode: vi.fn(), confirmVersion: null, setConfirmVersion: vi.fn(),
    restoringVersionId: null, versionRefreshKey: 0, archiveVersion: vi.fn(),
    restorePathVersion: vi.fn(), copyFolderPath: vi.fn(), revealFile: vi.fn(),
  }),
}));
vi.mock('@features/collection/public/folder-api', () => ({ FolderCollectionSwitchConfirmDialog: () => null }));
// Agent identity/menu rendering is covered separately; retain the real host-scoped fullscreen hooks here.
vi.mock('@features/agent/components/agent-conversation-identity', () => ({ AgentConversationIdentity: () => <span>agent identity</span> }));
vi.mock('@features/agent/components/agent-conversation-more-menu', () => ({ AgentConversationMoreMenu: () => <button>agent menu</button> }));

let host: HTMLDivElement;
let container: HTMLDivElement;
let root: Root;
let props: DocumentTitlebarProps;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  host.dataset.workspaceHost = 'main-third';
  container = document.createElement('div');
  host.append(container);
  document.body.append(host);
  root = createRoot(container);
  props = {
    document: { target: {
      fileIdentity: { path: '/book/a.md', displayId: 'a' }, scopePath: '/book',
      notebookId: 'book', relativePath: 'a.md', indexable: true, isOutsideCurrentNotebook: false,
    } },
    sidebar: { hidden: true, noteNavigationVisible: false, onToggle: vi.fn() },
    navigation: { title: 'note A', canNavigateBack: true, canNavigateForward: false, onNavigateBack: vi.fn(), onNavigateForward: vi.fn() },
    contentCapabilities: { memoColors: true, copyFullText: true, exportContent: true, saveAsTemplate: true, versionHistory: false },
    actions: { onCopyLink: vi.fn(), onCopyFullText: vi.fn(), onExportMarkdown: vi.fn(), onExportWord: vi.fn(), onExportPdf: vi.fn(), onSaveAsTemplate: vi.fn(), onDeleteExternalFile: vi.fn() },
  };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

for (const [platform, Titlebar] of [['mac', DocumentTitlebarMac], ['windows', DocumentTitlebarWin]] as const) {
  describe(`${platform} document titlebar`, () => {
    it('keeps a web icon visible when the favicon fails to load', async () => {
      props.document.target = null;
      props.navigation.title = '技能市场';
      props.navigation.icon = 'https://skills.flowix.cc/favicon.ico';
      props.onToggleWebAddressBar = vi.fn();
      await act(async () => root.render(<Titlebar {...props} />));
      const image = container.querySelector<HTMLImageElement>('img[src="https://skills.flowix.cc/favicon.ico"]')!;
      expect(image).not.toBeNull();
      expect(image.parentElement!.querySelector('svg')).not.toBeNull();
      await act(async () => image.dispatchEvent(new Event('error')));
      expect(image.style.display).toBe('none');
      expect(image.parentElement!.querySelector('svg')).not.toBeNull();
    });

    it.each(['table', 'media_library'] as const)('renders the selected %s folder preference without crashing', async (current) => {
      props.folderCollectionViewType = {
        current, onSelect: vi.fn(), isDefaultFolder: false, onToggleDefaultFolder: vi.fn(),
      };
      await act(async () => root.render(<Titlebar {...props} />));
      expect(container.querySelector('[aria-label="document.titlebar.moreTooltip"]')).not.toBeNull();
    });

    it.each([
      ['a.md', 'document.action.richTextMode'],
      ['index.html', 'htmlResource.previewMode'],
    ])('switches %s modes through the existing More menu', async (filename, richLabel) => {
      props.document.target!.fileIdentity = { path: `/book/${filename}`, displayId: filename };
      props.showEditorModeToggle = true;
      props.editorMode = 'source';
      props.onSetEditorMode = vi.fn();
      await act(async () => root.render(<Titlebar {...props} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.moreTooltip"]')!.click());
      const toggle = [...document.querySelectorAll<HTMLElement>('button')]
        .find((item) => item.textContent?.includes(richLabel));
      expect(toggle).toBeDefined();
      await act(async () => toggle!.click());
      expect(props.onSetEditorMode).toHaveBeenCalledWith('rich');
      props.editorMode = 'rich';
      await act(async () => root.render(<Titlebar {...props} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.moreTooltip"]')!.click());
      expect([...document.querySelectorAll<HTMLElement>('button')]
        .some((item) => item.textContent?.includes('document.action.sourceMode'))).toBe(true);
    });

    it('hides document controls during Agent fullscreen and restores them on exit', async () => {
      await act(async () => root.render(<Titlebar {...props} />));
      const color = () => container.querySelector('[aria-label="document.color.button"]');
      expect(color()).not.toBeNull();
      const card = document.createElement('div');
      card.className = 'agent-thread-card--fullscreen';
      card.dataset.agentType = 'codex';
      card.dataset.instanceId = 'agent-instance';
      host.append(card);
      await act(async () => window.dispatchEvent(new Event('flowix:agent-thread-card-fullscreen-change')));
      expect(color()).toBeNull();
      expect(container.querySelector('[aria-label="document.titlebar.moreTooltip"]')).toBeNull();
      expect(container.textContent).not.toContain('note A');
      card.remove();
      await act(async () => window.dispatchEvent(new Event('flowix:agent-thread-card-fullscreen-change')));
      expect(color()).not.toBeNull();
      expect(container.textContent).toContain('note A');
    });

    it('preserves navigation callbacks and the host context menu through the shared frame', async () => {
      await act(async () => root.render(<Titlebar {...props} />));
      const back = container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.back"]')!;
      const forward = container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.forward"]')!;
      expect(forward.disabled).toBe(true);
      await act(async () => back.click());
      expect(props.navigation.onNavigateBack).toHaveBeenCalledOnce();
      const frame = container.querySelector('[data-tauri-drag-region]')!;
      await act(async () => frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      const closeBrowser = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('tabWindow.closeColumn'))!;
      expect(closeBrowser).toBeDefined();
      await act(async () => closeBrowser.click());
      expect(mocks.hideBrowser).toHaveBeenCalledOnce();
    });
  });
}
