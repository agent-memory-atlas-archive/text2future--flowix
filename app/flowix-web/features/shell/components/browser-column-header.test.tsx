import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserColumnHeader } from './browser-column-header';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
vi.mock('@/lib/i18n', async (original) => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./work-column-titlebar-shell', () => ({ WORK_COLUMN_TITLEBAR_GRADIENT: 'none' }));
vi.mock('@features/document/public/shell-api', () => ({
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC: 'mac-button',
  DOCUMENT_TITLEBAR_ICON_BUTTON_WIN: 'win-button',
  AgentThreadCardFullscreenExitButton: () => null,
  useFullscreenAgentThreadCardInfo: () => null,
}));
vi.mock('@features/agent/public/shell-api', () => ({ AgentIcon: () => null, useBrowserColumnAgentHeaderModel: () => ({ conversationInstances: {} }), useNewConversationAgentSelection: () => ({ options: [] }) }));
it.each([true, false])('shows the current title, preserves hide and applies the context-menu drag policy (Windows: %s)', async (windows) => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(windows ? 'Windows' : 'Macintosh');
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(windows ? 'Win32' : 'MacIntel');
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  useBrowserColumnStore.getState().reset();
  useBrowserColumnStore.getState().openContent({ id: 'a', title: 'Current page', icon: null, target: { kind: 'web', url: 'https://a.example/' } });
  const state = useBrowserColumnStore.getState();
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  const hide = vi.fn();
  try {
    await act(async () => root.render(<BrowserColumnHeader current={state.current} activeSurfaceChrome="document" onToggleMemoEditorMode={vi.fn()} onOpenInWorkColumn={vi.fn()} onCloseColumn={hide} isFocused={false} canCreate={false} onCreateNote={vi.fn()} onCreateAgentConversation={vi.fn()} />));
    expect(node.querySelector('[role="tablist"]')).toBeNull();
    const header = node.querySelector('[data-browser-column-header]')!;
    expect(header.getAttribute('data-workspace-column-context-menu')).toBe(windows ? 'windows' : null);
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(node.textContent).toContain('Current page');
    expect(node.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.back"]')?.disabled).toBe(true);
    expect(node.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.forward"]')?.disabled).toBe(true);
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="tabWindow.closeColumn"]')?.click());
    expect(hide).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); node.remove(); environment.IS_REACT_ACT_ENVIRONMENT = false; userAgent.mockRestore(); platform.mockRestore(); }
});
