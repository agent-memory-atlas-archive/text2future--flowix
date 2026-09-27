import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EditorFontSwitcher, useEditorFontSwitch } from './editor-font-switcher';
import type { FontDownloadProgress } from '@platform/tauri/client/general';

const fontMocks = vi.hoisted(() => ({
  ensure: vi.fn<(fontId: string) => Promise<boolean>>(),
  progress: null as ((progress: FontDownloadProgress) => void) | null,
  fontId: 'inter',
  sequence: 0,
  begin: vi.fn<() => Promise<number>>(),
  commit: vi.fn<(selectionId: number, fontId: string) => Promise<boolean>>(),
}));

vi.mock('@features/preferences/public/font-api', () => ({
  ensureDownloadedFontRegistered: fontMocks.ensure,
  useTypographyFontId: () => fontMocks.fontId,
  beginTypographyFontSelection: fontMocks.begin,
  commitTypographyFontSelection: fontMocks.commit,
}));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: (_event: string, handler: (progress: FontDownloadProgress) => void) => {
    fontMocks.progress = handler;
    return () => { fontMocks.progress = null; };
  },
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

it.each([
  ['serif', 1, 'noto-serif-sc'],
  ['wenkai', 2, 'lxgw-wenkai'],
] as const)('shows download progress and applies %s only after registration completes', async (_mode, index, fontId) => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let finishDownload: ((downloaded: boolean) => void) | undefined;
  fontMocks.ensure.mockReturnValue(new Promise<boolean>((resolve) => { finishDownload = resolve; }));
  fontMocks.begin.mockImplementation(async () => ++fontMocks.sequence);
  fontMocks.commit.mockImplementation(async (selectionId, selectedFontId) => {
    if (selectionId !== fontMocks.sequence) return false;
    fontMocks.fontId = selectedFontId;
    return true;
  });

  function Harness() {
    const fontSwitch = useEditorFontSwitch();
    return <EditorFontSwitcher fontMode={fontSwitch.fontMode} downloadingMode={fontSwitch.downloadingMode} percent={fontSwitch.percent} onSelect={fontSwitch.selectFontMode} />;
  }

  try {
    await act(async () => root.render(<Harness />));
    const buttons = element.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull();
    const target = buttons[index];
    await act(async () => target.click());
    expect(fontMocks.ensure).toHaveBeenCalledWith(fontId);
    expect(target.textContent).toContain('…');
    expect(target.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(fontMocks.commit).not.toHaveBeenCalled();

    await act(async () => fontMocks.progress?.({ fontId, downloadedBytes: 42, totalBytes: 100, percent: 42 }));
    expect(target.textContent).toContain('42%');
    expect(fontMocks.commit).not.toHaveBeenCalled();

    await act(async () => finishDownload?.(true));
    expect(target.textContent).not.toContain('%');
    expect(target.getAttribute('aria-pressed')).toBe('true');
    expect(fontMocks.fontId).toBe(fontId);
    expect(fontMocks.commit).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    element.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    fontMocks.ensure.mockReset();
    fontMocks.begin.mockReset();
    fontMocks.commit.mockReset();
    fontMocks.fontId = 'inter';
    fontMocks.sequence = 0;
  }
});
