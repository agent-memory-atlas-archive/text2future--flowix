import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLocalHtmlScrollbar } from './local-html-scrollbar';
import runtime from '../../../flowix-desktop/src/frame_scrollbar.js?raw';

describe('local HTML scrollbar host', () => {
  let iframe: HTMLIFrameElement;
  let disconnect: (() => void) | undefined;

  beforeEach(() => {
    document.documentElement.dataset.os = 'windows';
    document.documentElement.style.setProperty('--muted-foreground', 'rgb(100, 100, 100)');
    iframe = document.createElement('iframe');
    document.body.append(iframe);
  });
  afterEach(() => {
    disconnect?.();
    disconnect = undefined;
    iframe.remove();
    delete document.documentElement.dataset.os;
    document.documentElement.removeAttribute('style');
    vi.restoreAllMocks();
  });

  it('configures the isolated document on load, theme change and authenticated readiness', async () => {
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectLocalHtmlScrollbar(iframe);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'flowix:local-html-scrollbar', color: 'rgb(100, 100, 100)',
      css: expect.stringContaining('.overlay-scrollbar-thumb'),
    }), '*');
    post.mockClear();
    window.dispatchEvent(new MessageEvent('message', {
      source: window, data: { type: 'flowix:local-html-scrollbar-ready' },
    }));
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'flowix:local-html-scrollbar-ready' },
    }));
    expect(post).toHaveBeenCalledOnce();
    iframe.dispatchEvent(new Event('load'));
    expect(post).toHaveBeenCalledTimes(2);
    document.documentElement.style.setProperty('--muted-foreground', 'rgb(180, 180, 180)');
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'rgb(180, 180, 180)' }), '*');
    post.mockClear();
    disconnect();
    iframe.dispatchEvent(new Event('load'));
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves native behavior on macOS', () => {
    document.documentElement.dataset.os = 'mac';
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectLocalHtmlScrollbar(iframe);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('local HTML scrollbar inside the native sandbox', () => {
  const parent = { postMessage: vi.fn() };
  let originalParent: PropertyDescriptor | undefined;
  let originalReady: PropertyDescriptor | undefined;
  let originalScroller: PropertyDescriptor | undefined;
  let originalSheets: PropertyDescriptor | undefined;
  let originalShadowSheets: PropertyDescriptor | undefined;
  let scrollHeight = 2400;
  let resize: (() => void) | undefined;
  const config = { type: 'flowix:local-html-scrollbar', color: 'rgb(100, 100, 100)', css: '' };
  const send = (source: unknown = parent) => window.dispatchEvent(new MessageEvent('message', {
    source: source as Window, data: config,
  }));
  const flush = () => vi.advanceTimersByTimeAsync(20);
  const host = () => document.querySelector('flowix-frame-scrollbar') as HTMLElement;
  const frame = () => host().shadowRoot!.querySelector('.overlay-scrollbar-frame') as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
    originalReady = Object.getOwnPropertyDescriptor(document, 'readyState');
    originalScroller = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    originalSheets = Object.getOwnPropertyDescriptor(document, 'adoptedStyleSheets');
    originalShadowSheets = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
    Object.defineProperty(window, 'parent', { configurable: true, value: parent });
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
    Object.defineProperty(document, 'adoptedStyleSheets', { configurable: true, writable: true, value: [] });
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', { configurable: true, writable: true, value: [] });
    vi.stubGlobal('location', { href: 'http://asset.localhost/D%3A/notes/demo.html' });
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('CSSStyleSheet', class { replaceSync() {} });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} unobserve() {} disconnect() {}
    });
    scrollHeight = 2400;
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    document.documentElement.scrollTop = 0;
    // jsdom has no layout; the root has real mocked scroll metrics above.
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] });
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    for (const [target, key, descriptor] of [
      [window, 'parent', originalParent], [document, 'readyState', originalReady],
      [document, 'scrollingElement', originalScroller], [document, 'adoptedStyleSheets', originalSheets],
      [ShadowRoot.prototype, 'adoptedStyleSheets', originalShadowSheets],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    Reflect.deleteProperty(document, 'elementsFromPoint');
    document.documentElement.scrollTop = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('replaces the document scrollbar, follows scrolling, hides after 700 ms and restores on unload', async () => {
    window.eval(runtime);
    send(window);
    expect(host()).toBeNull();
    send();
    await flush();
    expect(document.documentElement.hasAttribute('data-flowix-frame-scroller')).toBe(true);
    expect(frame().style.getPropertyValue('--overlay-scrollbar-thumb-height')).toBe('150px');
    expect(frame().dataset.scrolling).toBeUndefined();
    document.documentElement.scrollTop = 900;
    document.dispatchEvent(new Event('scroll'));
    await flush();
    expect(frame().style.getPropertyValue('--overlay-scrollbar-thumb-top')).toBe('225px');
    expect(frame().dataset.scrolling).toBe('true');
    await vi.advanceTimersByTimeAsync(710);
    expect(frame().dataset.scrolling).toBeUndefined();
    scrollHeight = 600;
    resize?.();
    await flush();
    expect(host().style.display).toBe('none');
    expect(document.documentElement.hasAttribute('data-flowix-frame-scroller')).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(host()).toBeNull();
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it('drags and forwards wheel events over the overlay without wrapping page content', async () => {
    const body = document.body;
    window.eval(runtime);
    send();
    await flush();
    const thumb = host().shadowRoot!.querySelector('.overlay-scrollbar-thumb') as HTMLElement;
    thumb.setPointerCapture = vi.fn();
    thumb.hasPointerCapture = () => true;
    thumb.releasePointerCapture = vi.fn();
    const pointer = (type: string, y: number) => {
      const event = new MouseEvent(type, { clientY: y, button: 0, cancelable: true });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      thumb.dispatchEvent(event);
    };
    pointer('pointerdown', 10);
    pointer('pointermove', 235);
    await flush();
    expect(document.documentElement.scrollTop).toBe(900);
    expect(frame().dataset.dragging).toBe('true');
    pointer('pointerup', 235);
    expect(frame().dataset.dragging).toBeUndefined();
    host().dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(document.documentElement.scrollTop).toBe(948);
    expect(document.body).toBe(body);
    expect(body.parentElement).toBe(document.documentElement);
  });

  it('does not initialize on external websites', () => {
    vi.stubGlobal('location', { href: 'https://example.com/' });
    window.eval(runtime);
    send();
    expect(host()).toBeNull();
  });
});
