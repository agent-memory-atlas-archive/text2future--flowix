import { vi } from 'vitest';

/**
 * jsdom 没有布局引擎：`getBoundingClientRect()` 恒返回全 0，`clientHeight`
 * 恒为 0。于是所有依赖“元素在上半还是下半”“滚动容器可视高度”的断言都失去
 * 意义，测试只能各自打补丁，补得不全。
 *
 * 这个桩把两件事做成可配置的：
 *  - 元素在视口中的位置与尺寸（影响命中/插入位置计算）
 *  - 滚动容器的 clientWidth / clientHeight（影响“是否已滚到底”判断）
 *
 * 用法：
 *   const layout = installLayoutStub();
 *   layout.setBox(card, { top: 20, height: 40 });
 *   layout.setClientSize(scroller, { height: 204 });
 *   afterEach(() => layout.restore());
 */
export interface LayoutBox {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface LayoutStub {
  setBox(element: Element, box: LayoutBox): void;
  setClientSize(element: Element, size: { width?: number; height?: number }): void;
  /** 内容总高度/宽度；不设置时 scrollHeight 会退回 clientHeight（等于不可滚动）。 */
  setScrollSize(element: Element, size: { width?: number; height?: number }): void;
  restore(): void;
}

export interface LayoutStubOptions {
  /**
   * 未注册元素使用的默认尺寸。给一个非 0 值可以让“高度为 0 就不渲染/不滚动”
   * 这类逻辑正常走完；不给则保持 jsdom 的全 0 语义。
   */
  defaultBox?: LayoutBox;
  /**
   * 替换 ResizeObserver 为“observe 时按当前尺寸回调一次”。组件的分区高度
   * 依赖这次回调，jsdom 原生桩不回调 → 高度恒 0 → 展开后不会滚动。
   */
  observeResize?: boolean;
}

const ZERO_BOX = { left: 0, top: 0, width: 0, height: 0 };

export function installLayoutStub(options: LayoutStubOptions = {}): LayoutStub {
  const fallbackBox = { ...ZERO_BOX, ...options.defaultBox };
  const boxes = new WeakMap<Element, Required<LayoutBox>>();
  const sizes = new WeakMap<Element, {
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
  }>();

  const resolveBox = (element: Element): Required<LayoutBox> => boxes.get(element) ?? fallbackBox;

  const rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element): DOMRect {
      const box = resolveBox(this);
      return new DOMRect(box.left, box.top, box.width, box.height);
    });

  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  const clientWidthDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  const scrollWidthDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');

  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      const size = sizes.get(this);
      if (size) return size.height;
      return clientHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      const size = sizes.get(this);
      if (size) return size.width;
      return clientWidthDescriptor?.get?.call(this) ?? 0;
    },
  });

  const originalResizeObserver = globalThis.ResizeObserver;
  if (options.observeResize) {
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        const box = resolveBox(target);
        const entry = {
          target,
          contentRect: new DOMRect(0, 0, box.width, box.height),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry;
        queueMicrotask(() => {
          this.callback([entry], this as unknown as ResizeObserver);
        });
      }
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  // jsdom 的 scrollHeight 恒为 0；虚拟列表用 scrollHeight - clientHeight 钳制
  // 滚动位置，不补这个值会把任何滚动位置判成越界并归零。
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      const size = sizes.get(this);
      if (size?.scrollHeight) return size.scrollHeight;
      return scrollHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      const size = sizes.get(this);
      if (size?.scrollWidth) return size.scrollWidth;
      return scrollWidthDescriptor?.get?.call(this) ?? 0;
    },
  });

  return {
    setBox(element, box) {
      const current = resolveBox(element);
      boxes.set(element, { ...current, ...box });
    },
    setClientSize(element, size) {
      const current = sizes.get(element) ?? { width: 0, height: 0, scrollWidth: 0, scrollHeight: 0 };
      sizes.set(element, {
        ...current,
        width: size.width ?? current.width,
        height: size.height ?? current.height,
      });
    },
    setScrollSize(element, size) {
      const current = sizes.get(element) ?? { width: 0, height: 0, scrollWidth: 0, scrollHeight: 0 };
      sizes.set(element, {
        ...current,
        scrollWidth: size.width ?? current.scrollWidth,
        scrollHeight: size.height ?? current.scrollHeight,
      });
    },
    restore() {
      rectSpy.mockRestore();
      if (clientHeightDescriptor) {
        Object.defineProperty(Element.prototype, 'clientHeight', clientHeightDescriptor);
      }
      if (clientWidthDescriptor) {
        Object.defineProperty(Element.prototype, 'clientWidth', clientWidthDescriptor);
      }
      if (scrollHeightDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDescriptor);
      }
      if (scrollWidthDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollWidth', scrollWidthDescriptor);
      }
      if (options.observeResize) {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    },
  };
}
