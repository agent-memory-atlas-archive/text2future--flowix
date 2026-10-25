// Style native scrollbars in local sandboxed HTML without adding a second
// scrollbar or changing the page's scrolling containers.
(() => {
  if (window === window.parent) return;
  const url = new URL(location.href);
  if (!((url.protocol === 'asset:' && url.hostname === 'localhost')
      || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost'))) return;

  const attribute = 'data-flowix-html-scrolling';
  const scrolling = new Map();
  let nativeStyle = null;
  let fallbackStyle = null;
  let pendingCss = null;

  function installStyle(css) {
    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      if (!nativeStyle) {
        nativeStyle = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, nativeStyle];
      }
      nativeStyle.replaceSync(css);
      return;
    }
    // Older WebKit versions do not support constructed stylesheets.
    if (!fallbackStyle) {
      const container = document.head || document.documentElement;
      if (!container) { pendingCss = css; return; }
      fallbackStyle = document.createElement('style');
      container.append(fallbackStyle);
    }
    fallbackStyle.textContent = css;
  }

  function onDocumentReady() {
    if (pendingCss !== null && document.documentElement) {
      const css = pendingCss;
      pendingCss = null;
      installStyle(css);
    }
  }

  function reveal(element) {
    if (!element) return;
    const previous = scrolling.get(element);
    if (previous) clearTimeout(previous.timer);
    const original = previous ? previous.original : element.getAttribute(attribute);
    element.setAttribute(attribute, 'true');
    const timer = setTimeout(() => {
      if (original === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, original);
      scrolling.delete(element);
    }, 700);
    scrolling.set(element, { timer, original });
  }

  function onScroll(event) {
    if (!nativeStyle && !fallbackStyle) return;
    const target = event.target;
    if (target === document || target === window || target === document.scrollingElement) {
      // Viewport scrollbar styling may come from html or body, depending on
      // standards/quirks mode and CSS overflow propagation.
      reveal(document.documentElement);
      reveal(document.body);
      reveal(document.scrollingElement);
    } else if (target instanceof Element) {
      reveal(target);
    }
  }

  function onMessage(event) {
    if (event.source !== window.parent || event.data?.type !== 'flowix:local-html-scrollbar') return;
    const config = event.data;
    if (typeof config.css !== 'string' || typeof config.color !== 'string'
        || !CSS.supports('color', config.color)) return;
    installStyle(config.css);
  }

  function cleanup(event) {
    if (event.persisted) return;
    for (const [element, { timer, original }] of scrolling) {
      clearTimeout(timer);
      if (original === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, original);
    }
    scrolling.clear();
    if (nativeStyle) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== nativeStyle);
    }
    fallbackStyle?.remove();
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('readystatechange', onDocumentReady);
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', cleanup);
  }

  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('readystatechange', onDocumentReady);
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', cleanup);
  window.parent.postMessage({ type: 'flowix:local-html-scrollbar-ready' }, '*');
})();
