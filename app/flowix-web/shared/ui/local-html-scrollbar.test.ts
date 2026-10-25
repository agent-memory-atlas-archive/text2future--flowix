import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLocalHtmlScrollbar } from './local-html-scrollbar';
import { localHtmlScrollbarCss } from './iframe-scrollbar';
import runtime from '../../../flowix-desktop/src/frame_scrollbar.js?raw';

const scrollingAttribute = 'data-flowix-html-scrolling';

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

  it('configures native scrollbar styling on load, theme change and authenticated readiness', async () => {
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectLocalHtmlScrollbar(iframe);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'flowix:local-html-scrollbar', color: 'rgb(100, 100, 100)',
      css: expect.stringContaining(scrollingAttribute),
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

  it('configures native WebKit scrollbar styling on macOS', () => {
    document.documentElement.dataset.os = 'mac';
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    disconnect = connectLocalHtmlScrollbar(iframe);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
      mac: true, css: expect.stringContaining('::-webkit-scrollbar-thumb'),
    }), '*');
  });
});

describe('local HTML native scrollbar lifecycle', () => {
  const parent = { postMessage: vi.fn() };
  let originalParent: PropertyDescriptor | undefined;
  let originalReady: PropertyDescriptor | undefined;
  let originalScroller: PropertyDescriptor | undefined;
  let originalSheets: PropertyDescriptor | undefined;
  let content: HTMLDivElement;
  const config = {
    type: 'flowix:local-html-scrollbar', color: 'rgb(100, 100, 100)',
    css: localHtmlScrollbarCss('rgb(100, 100, 100)', true),
  };
  const send = (source: unknown = parent, update = config) => window.dispatchEvent(new MessageEvent('message', {
    source: source as Window, data: update,
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
    originalReady = Object.getOwnPropertyDescriptor(document, 'readyState');
    originalScroller = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    originalSheets = Object.getOwnPropertyDescriptor(document, 'adoptedStyleSheets');
    Object.defineProperty(window, 'parent', { configurable: true, value: parent });
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
    Object.defineProperty(document, 'adoptedStyleSheets', { configurable: true, writable: true, value: [] });
    vi.stubGlobal('location', { href: 'asset://localhost/%2Fbook%2Fdemo.html' });
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('CSSStyleSheet', class { text = ''; replaceSync(text: string) { this.text = text; } });
    content = document.createElement('div');
    content.style.cssText = 'height:200px;overflow:auto;';
    document.body.append(content);
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    content.remove();
    for (const [target, key, descriptor] of [
      [window, 'parent', originalParent], [document, 'readyState', originalReady],
      [document, 'scrollingElement', originalScroller], [document, 'adoptedStyleSheets', originalSheets],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    document.documentElement.removeAttribute(scrollingAttribute);
    document.body.removeAttribute(scrollingAttribute);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['http://asset.localhost/D%3A/notes/demo.html', 'asset://localhost/%2Fbook%2Fdemo.html'])('styles %s without adding a second scrollbar or changing layout', (href) => {
    vi.stubGlobal('location', { href });
    const children = [...document.body.children];
    const originalStyle = content.getAttribute('style');
    window.eval(runtime);
    send(window);
    expect(document.adoptedStyleSheets).toHaveLength(0);
    send();
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect([...document.body.children]).toEqual(children);
    expect(document.querySelector('flowix-frame-scrollbar')).toBeNull();
    expect(content.getAttribute('style')).toBe(originalStyle);
    expect(document.documentElement.hasAttribute(scrollingAttribute)).toBe(false);
    const wheel = new WheelEvent('wheel', { deltaX: 20, deltaY: 30, bubbles: true, cancelable: true });
    content.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('reveals viewport scrollbars, extends the timer on scroll, and hides after 700 ms', async () => {
    window.eval(runtime);
    send();
    document.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.getAttribute(scrollingAttribute)).toBe('true');
    expect(document.body.getAttribute(scrollingAttribute)).toBe('true');
    await vi.advanceTimersByTimeAsync(600);
    document.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(600);
    expect(document.documentElement.getAttribute(scrollingAttribute)).toBe('true');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.documentElement.hasAttribute(scrollingAttribute)).toBe(false);
    expect(document.body.hasAttribute(scrollingAttribute)).toBe(false);
  });

  it('handles nested and dynamically added scrolling containers independently', async () => {
    window.eval(runtime);
    send();
    content.dispatchEvent(new Event('scroll'));
    expect(content.getAttribute(scrollingAttribute)).toBe('true');
    expect(document.documentElement.hasAttribute(scrollingAttribute)).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    const nested = document.createElement('div');
    content.append(nested);
    nested.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(300);
    expect(content.hasAttribute(scrollingAttribute)).toBe(false);
    expect(nested.getAttribute(scrollingAttribute)).toBe('true');
    await vi.advanceTimersByTimeAsync(400);
    expect(nested.hasAttribute(scrollingAttribute)).toBe(false);
  });

  it('styles a quirks-mode body viewport without introducing a wrapper', () => {
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.body });
    window.eval(runtime);
    send();
    document.body.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.getAttribute(scrollingAttribute)).toBe('true');
    expect(document.body.getAttribute(scrollingAttribute)).toBe('true');
    expect(content.parentElement).toBe(document.body);
  });

  it('installs styling before deferred dependencies finish and updates one stylesheet on theme changes', () => {
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
    window.eval(runtime);
    send();
    expect(document.adoptedStyleSheets).toHaveLength(1);
    const sheet = document.adoptedStyleSheets[0];
    send(parent, { ...config, css: localHtmlScrollbarCss('rgb(180, 180, 180)', true) });
    expect(document.adoptedStyleSheets).toEqual([sheet]);
    expect((sheet as CSSStyleSheet & { text: string }).text).toContain('rgb(180, 180, 180)');
  });

  it('restores page state and removes listeners and styles on unload', async () => {
    content.setAttribute(scrollingAttribute, 'page-value');
    window.eval(runtime);
    send();
    content.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pagehide'));
    expect(document.adoptedStyleSheets).toHaveLength(0);
    expect(content.getAttribute(scrollingAttribute)).toBe('page-value');
    content.removeAttribute(scrollingAttribute);
    content.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(content.hasAttribute(scrollingAttribute)).toBe(false);
  });

  it('supports WebKit without constructed stylesheets and removes the fallback on unload', () => {
    vi.stubGlobal('CSSStyleSheet', class {});
    const styles = document.head.querySelectorAll('style').length;
    window.eval(runtime);
    send();
    expect(document.head.querySelectorAll('style')).toHaveLength(styles + 1);
    window.dispatchEvent(new Event('pagehide'));
    expect(document.head.querySelectorAll('style')).toHaveLength(styles);
  });

  it('does not initialize on external websites', () => {
    vi.stubGlobal('location', { href: 'https://example.com/' });
    window.eval(runtime);
    send();
    expect(document.adoptedStyleSheets).toHaveLength(0);
    content.dispatchEvent(new Event('scroll'));
    expect(content.hasAttribute(scrollingAttribute)).toBe(false);
  });
});
