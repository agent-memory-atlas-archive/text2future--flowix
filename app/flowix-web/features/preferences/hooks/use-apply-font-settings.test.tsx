import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type FormatConfig } from '@/lib/constants';
import { useApplyFontSettings } from './use-apply-font-settings';

let container: HTMLDivElement;
let root: Root;
let originalStyle: string | null;

function ApplyFormat({ format }: { format: FormatConfig | undefined }) {
  useApplyFontSettings(format);
  return null;
}

beforeEach(() => {
  originalStyle = document.documentElement.getAttribute('style');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalStyle === null) document.documentElement.removeAttribute('style');
  else document.documentElement.setAttribute('style', originalStyle);
});

describe('document paragraph indentation', () => {
  it('applies and removes the indentation when the preference changes', async () => {
    await act(async () => root.render(<ApplyFormat format={undefined} />));
    await act(async () => root.render(<ApplyFormat format={{ ...DEFAULT_USER_SETTINGS.format, firstLineIndent: 2 }} />));

    expect(document.documentElement.style.getPropertyValue('--editor-first-line-indent')).toBe('2em');

    await act(async () => root.render(<ApplyFormat format={DEFAULT_USER_SETTINGS.format} />));

    expect(document.documentElement.style.getPropertyValue('--editor-first-line-indent')).toBe('0em');
  });
});
