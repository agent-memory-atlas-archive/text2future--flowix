import { describe, expect, it } from 'vitest';

import { resolveActiveFilePath } from './active-file-path-api';

describe('active file path resolution', () => {
  it('follows the focused host when both columns show a different file', () => {
    expect(resolveActiveFilePath({
      focusedHostId: 'browser-column',
      workPath: '/notes/work.md',
      browserPath: '/repo/browser.md',
    })).toBe('/repo/browser.md');

    expect(resolveActiveFilePath({
      focusedHostId: 'main-third',
      workPath: '/notes/work.md',
      browserPath: '/repo/browser.md',
    })).toBe('/notes/work.md');
  });

  it('falls back to the other column when the focused one shows no file', () => {
    expect(resolveActiveFilePath({
      focusedHostId: 'browser-column',
      workPath: '/notes/work.md',
      browserPath: null,
    })).toBe('/notes/work.md');

    expect(resolveActiveFilePath({
      focusedHostId: 'main-third',
      workPath: null,
      browserPath: '/repo/browser.md',
    })).toBe('/repo/browser.md');
  });

  it('reports nothing when neither column shows a file', () => {
    expect(resolveActiveFilePath({
      focusedHostId: 'main-third',
      workPath: null,
      browserPath: null,
    })).toBeNull();
  });
});
