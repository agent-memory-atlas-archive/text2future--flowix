import { beforeAll, beforeEach } from 'vitest';
import { loadLanguage } from '@/lib/i18n';

// i18n 按语言分包后, en-US 走动态 import (独立 chunk); 单测不挂 I18nProvider,
// 直接调 translate('en-US', ...) 的测试需预先加载 en-US 消息表, 否则
// getMessages('en-US') 回退到 zh-CN。loadLanguage 内部缓存 promise, 首个文件
// 触发实际加载, 后续文件立即 resolve。
beforeAll(async () => {
  await loadLanguage('en-US');
});

// Individual suites may reset this flag on teardown; restore it for every case.
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// jsdom 未实现 window.matchMedia；组件（如 featured-notes-controller）在渲染期
// 直接调用它做视口分页判断，缺 stub 会产生 unhandled rejection。这里给一个
// 永不匹配的静态实现，监听器仅注册不触发（单测不需要真实视口变化）。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom has no ResizeObserver; layout tests only need construction and
// observation to succeed unless they provide their own callback behavior.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe(_target: Element) {}
    unobserve(_target: Element) {}
    disconnect() {}
  };
}

// jsdom 缺少滚动 API。`scrollTo` 必须真的写入 scrollTop/scrollLeft：虚拟列表
// 通过 scrollToOffset → scrollTo 驱动滚动，做成空函数会让所有“滚动到某处”的
// 断言永远停在初始值（测试绿/红都不可信）。依赖滚动的测试需要用
// test-support/layout-stub 提供元素尺寸，否则 virtualizer 会算成 0 并归零。
if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.scrollTo !== 'function') {
    const scrollTo = function (this: Element, ...args: unknown[]): void {
      const [first, second] = args;
      const options = (typeof first === 'object' && first !== null)
        ? first as { top?: number; left?: number }
        : null;
      this.scrollTop = options ? options.top ?? 0 : Number(first ?? 0);
      this.scrollLeft = options ? options.left ?? 0 : Number(second ?? 0);
    };
    (Element.prototype as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

// jsdom 未实现 Pointer Capture。拖拽组件在 pointerdown 时调用 setPointerCapture，
// 缺失会抛 TypeError 并中断整个拖拽会话，表现为“指针事件完全没反应”。
if (typeof Element !== 'undefined' && typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
}
