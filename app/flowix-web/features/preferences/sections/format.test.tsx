import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS, type FormatConfig } from '@/lib/constants';
import { I18nProvider } from '@/lib/i18n';
import { FormatSection } from './format';

vi.mock('@platform/tauri/event-bus', () => ({ subscribe: () => () => {} }));
vi.mock('@features/preferences/font-cache', async (importOriginal) => ({
  ...await importOriginal<typeof import('@features/preferences/font-cache')>(),
  getDownloadedFontStatus: vi.fn(async () => ({})),
}));

let container: HTMLDivElement;
let root: Root;
const updateSettings = vi.fn();

function FormatPreferences() {
  const [format, setFormat] = useState(DEFAULT_USER_SETTINGS.format);
  return (
    <I18nProvider language="zh-CN">
      <FormatSection
        settings={format}
        updateSettings={async (updates: { format?: Partial<FormatConfig> }) => {
          updateSettings(updates);
          setFormat((current) => ({ ...current, ...updates.format }));
        }}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  updateSettings.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('previews the chosen indent and clears it when resetting format preferences', async () => {
  await act(async () => root.render(<FormatPreferences />));
  const trigger = container.querySelector<HTMLButtonElement>('#preferences-format-first-line-indent');
  expect(trigger?.textContent).toBe('不缩进');

  await act(async () => trigger!.click());
  const indentOption = [...document.querySelectorAll<HTMLButtonElement>('[data-flowix-surface="select"] button')]
    .find((button) => button.textContent === '2 字符');
  expect(indentOption).toBeDefined();
  await act(async () => indentOption!.click());

  expect(updateSettings).toHaveBeenCalledWith({ format: { firstLineIndent: 2 } });
  expect(trigger?.textContent).toBe('2 字符');
  expect([...container.querySelectorAll<HTMLParagraphElement>('p[style]')].map((paragraph) => paragraph.style.textIndent))
    .toEqual(['2em', '2em']);

  const reset = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === '恢复默认');
  expect(reset).toBeDefined();
  await act(async () => reset!.click());

  expect(updateSettings).toHaveBeenLastCalledWith({ format: DEFAULT_USER_SETTINGS.format });
  expect(trigger?.textContent).toBe('不缩进');
  expect([...container.querySelectorAll<HTMLParagraphElement>('p[style]')].map((paragraph) => paragraph.style.textIndent))
    .toEqual(['0em', '0em']);
});
