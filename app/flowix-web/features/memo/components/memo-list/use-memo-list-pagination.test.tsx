import { act, createElement, type UIEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoListPagination } from './use-memo-list-pagination';

describe('memo list preloading', () => {
  let root: Root;
  let container: HTMLDivElement;
  let scroller: HTMLDivElement;
  let resize: () => void;
  let onScroll: (event: UIEvent<HTMLDivElement>) => void;
  const load = vi.fn();
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

  function Harness({ loadingMore = false }) {
    ({ onScroll } = useMemoListPagination({
      itemCount: 150, loading: false, loadingMorePages: loadingMore, hasMorePages: true,
      loadMorePages: load, scrollerRef: { current: scroller }, isActive: true,
    }));
    return null;
  }

  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    load.mockReset();
    scroller = document.createElement('div');
    scroller.appendChild(document.createElement('div'));
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 5000 },
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('requests the next page while more than a viewport of loaded content remains', async () => {
    await act(async () => root.render(createElement(Harness)));
    expect(load).not.toHaveBeenCalled();
    scroller.scrollTop = 3300; // 1100px remain; the user has not reached the end.
    onScroll({ currentTarget: scroller } as UIEvent<HTMLDivElement>);
    expect(load).toHaveBeenCalledOnce();
    await act(async () => root.render(createElement(Harness, { loadingMore: true })));
    onScroll({ currentTarget: scroller } as UIEvent<HTMLDivElement>);
    expect(load).toHaveBeenCalledOnce();
  });

  it('preloads after the viewport grows even without another scroll event', async () => {
    await act(async () => root.render(createElement(Harness)));
    scroller.scrollTop = 2800;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1000 });
    resize();
    expect(load).toHaveBeenCalledOnce();
  });
});
