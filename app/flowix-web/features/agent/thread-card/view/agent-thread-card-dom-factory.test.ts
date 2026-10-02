import { afterEach, describe, expect, it } from 'vitest';
import { createAgentThreadCardDom } from './agent-thread-card-dom-factory';

describe('agent thread card message scrollbar', () => {
  afterEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it('uses the shared overlay scrollbar for the macOS message scroller', () => {
    document.documentElement.dataset.platform = 'mac';
    const parts = createAgentThreadCardDom({
      inputDraft: '',
      t: (key) => key,
      onCardMouseDown: () => {},
      onTitleDoubleClick: () => {},
      onDeleteClick: () => {},
      onFullscreenClick: () => {},
      onCollapseClick: () => {},
      onBodyClick: () => {},
      onBodyScroll: () => {},
      onBodyWheel: () => {},
    });

    const frame = parts.body.parentElement;
    expect(frame?.classList.contains('overlay-scrollbar-frame--custom-mac')).toBe(true);
    expect(frame?.parentElement).toBe(parts.container);
    expect(parts.body.classList.contains('overlay-scrollbar')).toBe(true);
    expect(frame?.querySelector('.overlay-scrollbar-thumb')).not.toBeNull();
    parts.disposeBodyScrollbar();
  });
});
