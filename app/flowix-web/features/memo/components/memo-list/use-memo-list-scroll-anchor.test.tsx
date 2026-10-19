import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoListScrollAnchor } from './use-memo-list-scroll-anchor';

describe('memo list viewport anchoring', () => {
  let root: Root;
  let scroller: HTMLDivElement;
  let content: HTMLDivElement;
  let rows: { key: string; height: number }[];
  let capture: () => void;
  let resize: () => void;
  const ref = { current: null as HTMLDivElement | null };
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height } as DOMRect);
  function Harness({ query = 'query' }) {
    capture = useMemoListScrollAnchor(ref, query, rows);
    return null;
  }
  function syncRows() {
    content.replaceChildren(...rows.map(({ key }) => {
      const row = document.createElement('div');
      row.setAttribute('data-note-path', key);
      row.getBoundingClientRect = () => {
        const index = rows.findIndex(item => item.key === key);
        const top = 100 + rows.slice(0, index).reduce((sum, item) => sum + item.height, 0) - scroller.scrollTop;
        return rect(top, rows[index].height);
      };
      return row;
    }));
  }
  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    scroller = document.createElement('div');
    ref.current = scroller;
    Object.defineProperty(scroller, 'clientHeight', { value: 100 });
    scroller.getBoundingClientRect = () => rect(100, 100);
    scroller.scrollTop = 150;
    content = document.createElement('div');
    content.setAttribute('data-note-list-content', '');
    scroller.appendChild(content);
    rows = Array.from({ length: 20 }, (_, index) => ({ key: String(index), height: 30 }));
    syncRows();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('preserves the first visible card when a card above it grows', async () => {
    await act(async () => root.render(createElement(Harness)));
    rows = rows.map((row, index) => index === 0 ? { ...row, height: 80 } : row);
    await act(async () => root.render(createElement(Harness)));
    expect(scroller.scrollTop).toBe(200);
  });

  it('falls back to a visible neighbor when the anchor card is deleted', async () => {
    await act(async () => root.render(createElement(Harness)));
    rows = rows.filter(row => row.key !== '5');
    syncRows();
    await act(async () => root.render(createElement(Harness)));
    expect(scroller.scrollTop).toBe(120);
  });

  it('uses the latest user scroll rather than returning to an older position', async () => {
    await act(async () => root.render(createElement(Harness)));
    scroller.scrollTop = 300;
    capture();
    rows[0].height += 40;
    resize();
    expect(scroller.scrollTop).toBe(340);
  });

  it('does not restore anchors belonging to a different query', async () => {
    await act(async () => root.render(createElement(Harness)));
    scroller.scrollTop = 0;
    await act(async () => root.render(createElement(Harness, { query: 'different' })));
    expect(scroller.scrollTop).toBe(0);
  });
});
