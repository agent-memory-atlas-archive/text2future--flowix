import { act, createElement, useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useDynamicVirtualList } from './use-dynamic-virtual-list';
import { installLayoutStub, type LayoutStub } from '../../../test-support/layout-stub';

const items = Array.from({ length: 13 }, (_, index) => ({
  id: `memo-${index}`,
}));

function Harness() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { virtualItems } = useDynamicVirtualList({
    items,
    getKey: (item) => item.id,
    estimateSize: () => 100,
    scrollerRef,
    enabled: true,
  });

  return createElement('div', {
    ref: scrollerRef,
    'data-rendered-count': String(virtualItems.length),
  });
}

type TestMemo = { relativePath: string };

function SelectionAfterPagingHarness({ items }: { items: TestMemo[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowRefsRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const getKey = useCallback((item: TestMemo) => item.relativePath, []);
  const estimateSize = useCallback(() => 100, []);
  const {
    totalSize,
    virtualItems,
    getMeasureRef,
    isVirtualizationReady,
  } = useDynamicVirtualList({
    items,
    getKey,
    estimateSize,
    scrollerRef,
    enabled: true,
    resetKey: 'memo-query',
    overscan: 2,
    scrollMargin: 8,
  });
  const setScrollerRef = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element;
    if (!element) return;
    Object.defineProperties(element, {
      clientWidth: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 300 },
      getBoundingClientRect: {
        configurable: true,
        value: () => new DOMRect(0, 0, 320, 300),
      },
    });
  }, []);
  const getRowRef = useCallback((key: string) => {
    const cached = rowRefsRef.current.get(key);
    if (cached) return cached;
    const measureRef = getMeasureRef(key);
    const ref = (element: HTMLDivElement | null) => {
      if (element) {
        Object.defineProperty(element, 'getBoundingClientRect', {
          configurable: true,
          value: () => new DOMRect(0, 0, 320, 100),
        });
      }
      measureRef(element);
      if (!element) rowRefsRef.current.delete(key);
    };
    rowRefsRef.current.set(key, ref);
    return ref;
  }, [getMeasureRef]);

  return createElement(
    'div',
    {
      ref: setScrollerRef,
      'data-virtualization-ready': String(isVirtualizationReady),
    },
    createElement(
      'div',
      { style: { height: totalSize, position: 'relative' } },
      virtualItems.map(({ key, index, item, start }) => createElement(
        'button',
        {
          key,
          ref: getRowRef(key),
          'data-index': index,
          'data-memo-path': item.relativePath,
          'data-selected': String(selectedPath === item.relativePath),
          style: { position: 'absolute', top: start, height: 100 },
          onClick: () => setSelectedPath(item.relativePath),
        },
        item.relativePath,
      )),
    ),
  );
}

let root: Root | null = null;
let layout: LayoutStub | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  layout?.restore();
  layout = null;
  document.body.replaceChildren();
});

describe('useDynamicVirtualList', () => {
  it('renders every loaded item until the scroller viewport is measurable', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(Harness));
    });

    // jsdom reports clientHeight === 0, matching the first layout pass that
    // can occur while a Tauri column is still being attached.  A zero-height
    // viewport must not collapse the list to overscan + 1 rows.
    expect(container.firstElementChild?.getAttribute('data-rendered-count')).toBe('13');
  });

  it('keeps the scroll position when selecting a card after another page is appended', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      relativePath: `memo-${index}`,
    }));
    const secondPage = Array.from({ length: 50 }, (_, index) => ({
      relativePath: `memo-${index + 50}`,
    }));

    await act(async () => {
      root?.render(createElement(SelectionAfterPagingHarness, { items: firstPage }));
    });

    const scroller = container.firstElementChild as HTMLDivElement;
    // 虚拟列表靠元素尺寸换算 offset；jsdom 全 0 会让 scrollToOffset 归零，
    // 必须给出行高与可视高度，滚动位置才可能被保持。
    layout = installLayoutStub({ defaultBox: { width: 320, height: 100 } });
    layout.setClientSize(scroller, { width: 320, height: 640 });
    layout.setScrollSize(scroller, { height: 5_000 });
    scroller.scrollTop = 4_200;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      root?.render(createElement(SelectionAfterPagingHarness, {
        items: [...firstPage, ...secondPage],
      }));
    });

    const visibleMemo = container.querySelector<HTMLButtonElement>('[data-memo-path="memo-43"]');
    expect(visibleMemo).not.toBeNull();
    await act(async () => visibleMemo?.click());

    expect(visibleMemo?.dataset.selected).toBe('true');
    expect(scroller.scrollTop).toBe(4_200);
  });
});
