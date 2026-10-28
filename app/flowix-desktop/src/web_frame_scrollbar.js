// Remote pages own their scrollbars, and cross-origin documents cannot be
// reached through `contentDocument`. The shell injects this script into every
// frame, so the page restyles itself from the inside: the native bar is hidden
// (zero width, so content reclaims its space) and replaced by an overlay thumb
// that appears while scrolling. Native wheel, keyboard and touch scrolling are
// untouched — only the bar's geometry changes.
//
// Only the top-level page frame is handled. Nested frames keep their own
// scrollbars so embedded widgets and ad slots are not silently restyled.
(() => {
  if (window === window.top) return;
  if (window.parent !== window.top) return;
  const protocol = location.protocol;
  // Remote pages and local HTML previews are both cross-origin to the host, so
  // both can only be restyled from inside the frame.
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'asset:') return;

  const ATTR = 'data-flowix-overlay-scroll';
  const LAYER_ID = 'flowix-overlay-scroll-layer';
  const THUMB_CLASS = 'flowix-overlay-thumb';
  const CONFIG_TYPE = 'flowix:web-frame-scrollbar';
  const READY_TYPE = 'flowix:web-frame-scrollbar-ready';
  const HIDE_DELAY = 700;
  const MIN_THUMB = 24;
  const EDGE = 2;

  let mac = true;
  let enabled = true;
  let color = 'rgba(0, 0, 0, 0.3)';
  let layer = null;
  let styleNode = null;
  let styleSheet = null;
  let scheduled = 0;
  let started = false;
  let suppressed = false;
  const entries = new Map();

  function requestFrame(callback) {
    if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(callback);
    return window.setTimeout(callback, 16);
  }

  /** The document scroller is the only place WebKit can refuse to collapse the
   * native bar, so success is measured rather than assumed. */
  function nativeBarConsumesWidth() {
    return window.innerWidth - document.documentElement.clientWidth > 1;
  }

  function rootElement() {
    return document.scrollingElement || document.documentElement;
  }

  function isRoot(element) {
    return element === document.scrollingElement || element === document.documentElement;
  }

  function barSize() {
    return mac ? 6 : 9;
  }

  function overlayCss() {
    return `
      /* The document scroller is covered unconditionally: WebKit decides whether
       * the viewport bar belongs to html or body from how overflow propagates,
       * and getting that wrong is what leaves a gutter beside the content. */
      :root, body { scrollbar-width: none !important; -ms-overflow-style: none !important; }
      :root::-webkit-scrollbar, body::-webkit-scrollbar {
        display: none !important; width: 0 !important; height: 0 !important;
      }
      /* WebKit paints scrollbars with native NSScroller; display:none is the only
       * declaration that reliably removes the bar there, so both are emitted. */
      [${ATTR}] { scrollbar-width: none !important; -ms-overflow-style: none !important; }
      [${ATTR}]::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      #${LAYER_ID} { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      #${LAYER_ID} > .${THUMB_CLASS} {
        position: fixed; top: 0; left: 0; margin: 0; padding: 0; border: 0;
        border-radius: 999px; background: currentColor; opacity: 0;
        transition: opacity 120ms ease-out; pointer-events: auto; touch-action: none;
      }
    `;
  }

  /** Constructed stylesheets first: they are unaffected by however the document
   * handles inline `<style>`, which is why the local-preview script preferred
   * them too. Fall back to a <style> tag where they are unsupported. */
  function ensureStyle() {
    if (styleNode || styleSheet) return;
    const css = overlayCss();
    if (typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.replaceSync === 'function'
        && 'adoptedStyleSheets' in document) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        styleSheet = sheet;
        return;
      } catch {
        styleSheet = null;
      }
    }
    styleNode = document.createElement('style');
    styleNode.id = 'flowix-overlay-scroll-style';
    styleNode.textContent = css;
    (document.head || document.documentElement).appendChild(styleNode);
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.style.color = color;
    (document.body || document.documentElement).appendChild(layer);
    return layer;
  }

  function measure(element) {
    if (isRoot(element)) {
      const doc = document.documentElement;
      const body = document.body;
      const width = doc.clientWidth || window.innerWidth;
      const height = doc.clientHeight || window.innerHeight;
      return {
        root: true,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        scrollTop: window.pageYOffset || doc.scrollTop || 0,
        scrollLeft: window.pageXOffset || doc.scrollLeft || 0,
        scrollHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
        scrollWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
        clientHeight: height,
        clientWidth: width,
      };
    }
    const rect = element.getBoundingClientRect();
    return {
      root: false,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
    };
  }

  function bounds(metrics, vertical) {
    const track = vertical ? metrics.bottom - metrics.top : metrics.right - metrics.left;
    const visible = vertical ? metrics.clientHeight : metrics.clientWidth;
    const total = vertical ? metrics.scrollHeight : metrics.scrollWidth;
    const offset = vertical ? metrics.scrollTop : metrics.scrollLeft;
    const max = total - visible;
    if (!(max > 1) || !(track > 0) || !(total > 0)) return null;
    const size = Math.min(track, Math.max(MIN_THUMB, Math.round((visible / total) * track)));
    const travel = Math.max(0, track - size);
    return { size, travel, offset: max > 0 ? (offset / max) * travel : 0, max };
  }

  function setBox(element, width, height, x, y) {
    const size = `${width}x${height}`;
    if (element.dataset.size !== size) {
      element.style.width = width;
      element.style.height = height;
      element.dataset.size = size;
    }
    const transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (element.dataset.pos !== transform) {
      element.style.transform = transform;
      element.dataset.pos = transform;
    }
  }

  function paint(entry) {
    const metrics = entry.metrics;
    if (!metrics) return;
    const bar = barSize();

    const vertical = bounds(metrics, true);
    if (vertical && entry.vThumb) {
      setBox(entry.vThumb, `${bar}px`, `${vertical.size}px`, metrics.right - bar - EDGE, metrics.top + vertical.offset);
      entry.vThumb.style.display = '';
    } else if (entry.vThumb) {
      entry.vThumb.style.display = 'none';
    }

    const horizontal = bounds(metrics, false);
    if (horizontal && entry.hThumb) {
      setBox(entry.hThumb, `${horizontal.size}px`, `${bar}px`, metrics.left + horizontal.offset, metrics.bottom - bar - EDGE);
      entry.hThumb.style.display = '';
    } else if (entry.hThumb) {
      entry.hThumb.style.display = 'none';
    }

    return Boolean(vertical || horizontal);
  }

  function sync(entry, reveal) {
    if (!entry.el.isConnected) {
      forget(entry);
      return;
    }
    entry.metrics = measure(entry.el);
    if (paint(entry) && reveal) revealThumb(entry);
  }

  function revealThumb(entry) {
    if (!entry.vThumb && !entry.hThumb) return;
    clearTimeout(entry.hideTimer);
    if (entry.vThumb) entry.vThumb.style.opacity = '1';
    if (entry.hThumb) entry.hThumb.style.opacity = '1';
    entry.hideTimer = setTimeout(() => {
      if (entry.dragging) return;
      if (entry.vThumb) entry.vThumb.style.opacity = '0';
      if (entry.hThumb) entry.hThumb.style.opacity = '0';
    }, HIDE_DELAY);
  }

  function forget(entry) {
    clearTimeout(entry.hideTimer);
    if (entry.vThumb) entry.vThumb.remove();
    if (entry.hThumb) entry.hThumb.remove();
    if (isRoot(entry.el)) {
      document.documentElement.removeAttribute(ATTR);
      if (document.body) document.body.removeAttribute(ATTR);
    } else {
      entry.el.removeAttribute(ATTR);
    }
    entries.delete(entry.el);
  }

  function beginDrag(event, entry, axis) {
    const metrics = entry.metrics;
    if (!metrics || event.button !== 0) return;
    const vertical = axis === 'v';
    const area = bounds(metrics, vertical);
    if (!area) return;

    event.preventDefault();
    entry.dragging = true;
    const start = vertical ? event.clientY : event.clientX;
    const startScroll = vertical ? metrics.scrollTop : metrics.scrollLeft;

    const onMove = (moveEvent) => {
      const delta = (vertical ? moveEvent.clientY : moveEvent.clientX) - start;
      const next = area.travel > 0 ? startScroll + (delta / area.travel) * area.max : startScroll;
      if (metrics.root) {
        window.scrollTo(vertical ? window.pageXOffset : next, vertical ? next : window.pageYOffset);
      } else if (vertical) {
        entry.el.scrollTop = next;
      } else {
        entry.el.scrollLeft = next;
      }
    };
    const onEnd = () => {
      entry.dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      revealThumb(entry);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
  }

  function createThumb(entry, axis) {
    const thumb = document.createElement('div');
    thumb.className = THUMB_CLASS;
    thumb.dataset.axis = axis;
    thumb.addEventListener('pointerdown', (event) => beginDrag(event, entry, axis));
    ensureLayer().appendChild(thumb);
    return thumb;
  }

  function ensureEntry(element) {
    const existing = entries.get(element);
    if (existing) return existing;
    if (isRoot(element)) {
      // WebKit paints the viewport bar from html or body depending on how
      // overflow propagates, so root coverage has to claim both.
      document.documentElement.setAttribute(ATTR, '');
      if (document.body) document.body.setAttribute(ATTR, '');
    } else {
      element.setAttribute(ATTR, '');
    }
    const entry = { el: element, vThumb: null, hThumb: null, metrics: null, hideTimer: 0, dragging: false };
    entry.vThumb = createThumb(entry, 'v');
    entry.hThumb = createThumb(entry, 'h');
    entries.set(element, entry);
    return entry;
  }

  function flush() {
    for (const entry of [...entries.values()]) {
      if (!entry.el.isConnected) forget(entry);
      else sync(entry, false);
    }
  }

  function scheduleFlush() {
    if (scheduled) return;
    scheduled = requestFrame(() => {
      scheduled = 0;
      flush();
    });
  }

  function onScroll(event) {
    if (!enabled) return;
    const target = event.target;
    let element = null;
    if (target === document || target === window || target === document.scrollingElement) {
      element = rootElement();
    } else if (target instanceof Element) {
      element = target;
    }
    if (!element) return;
    revealThumb(ensureEntry(element));
    scheduleFlush();
  }

  function start() {
    if (started || !enabled || suppressed) return;
    started = true;
    ensureStyle();
    ensureLayer();

    const root = rootElement();
    sync(ensureEntry(root), false);
    // Take over containers that are already scrollable so the first wheel tick
    // does not visibly reflow the page when the native bar disappears. Huge
    // documents bail out early; later containers are adopted on first scroll.
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deadline = now() + 12;
    let checked = 0;
    for (const element of document.querySelectorAll('*')) {
      if ((++checked & 127) === 0 && now() > deadline) break;
      if (element === root || element === layer || element === document.body) continue;
      if (element.classList && element.classList.contains(THUMB_CLASS)) continue;
      if (element.scrollHeight - element.clientHeight > 1 || element.scrollWidth - element.clientWidth > 1) {
        sync(ensureEntry(element), false);
      }
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', scheduleFlush);

    // Measure instead of assuming: a bar that would not collapse means the
    // engine ignored the styling, and drawing an overlay beside it would be the
    // double-scrollbar bug. Fall back to the native bar alone.
    requestFrame(() => {
      if (!started) return;
      const scrolling = document.documentElement.scrollHeight > window.innerHeight + 1;
      if (scrolling && nativeBarConsumesWidth()) {
        suppressed = true;
        teardown();
      }
    });
  }

  function teardown() {
    for (const entry of [...entries.values()]) forget(entry);
    entries.clear();
    if (layer) layer.remove();
    if (styleNode) styleNode.remove();
    if (styleSheet) {
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== styleSheet);
      } catch {
        // Detached documents reject stylesheet updates; the sheet dies with them.
      }
    }
    layer = null;
    styleNode = null;
    styleSheet = null;
    started = false;
    document.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('readystatechange', scheduleFlush);
    window.removeEventListener('resize', scheduleFlush);
  }

  function onMessage(event) {
    if (event.source !== window.parent) return;
    const config = event.data;
    if (!config || config.type !== CONFIG_TYPE) return;
    if (typeof config.mac === 'boolean') mac = config.mac;
    if (typeof config.enabled === 'boolean' && config.enabled !== enabled) {
      enabled = config.enabled;
      if (!enabled) {
        teardown();
        return;
      }
    }
    if (!enabled) return;
    if (typeof config.color === 'string' && config.color
        && (!window.CSS || typeof CSS.supports !== 'function' || CSS.supports('color', config.color))) {
      color = config.color;
      if (layer) layer.style.color = color;
    }
    if (suppressed) return;
    if (started) scheduleFlush();
    else start();
  }

  document.addEventListener('readystatechange', scheduleFlush);
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) teardown();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
  try {
    window.parent.postMessage({ type: READY_TYPE }, '*');
  } catch {
    // Detached frames cannot reach the host; nothing to configure.
  }
})();
