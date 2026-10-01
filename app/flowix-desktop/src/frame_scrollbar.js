// WebView2 runs this in each document, including sandboxed frames. It exposes
// no native bridge and starts only in a local asset frame configured by its parent.
(() => {
  if (window === window.parent || new URL(location.href).hostname !== 'asset.localhost') return;

  let configure = null;
  let pendingConfig = null;

  function mount(config) {
    const host = document.createElement('flowix-frame-scrollbar');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;right:0!important;top:0!important;width:16px!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const frame = document.createElement('div');
    frame.className = 'overlay-scrollbar-frame';
    const track = document.createElement('div');
    track.className = 'overlay-scrollbar-track';
    const thumb = document.createElement('div');
    thumb.className = 'overlay-scrollbar-thumb';
    frame.append(track, thumb);

    // Constructed sheets also work when the local page disallows inline styles.
    function addStyle(root, css) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return sheet;
    }
    addStyle(shadow, config.css);
    shadow.append(frame);
    const nativeStyle = addStyle(document, `
      [data-flowix-frame-scroller] { scrollbar-width: auto !important; scrollbar-gutter: auto !important; }
      [data-flowix-frame-scroller]::-webkit-scrollbar { width: 0 !important; height: 6px !important; }
    `);
    document.documentElement.append(host);

    let scroller = null;
    let hideTimer = null;
    let animationFrame = null;
    let revealPending = false;
    let drag = null;
    let thumbHeight = 24;
    let viewportHeight = 0;
    const viewport = () => document.documentElement.clientHeight || window.innerHeight;
    const isRoot = (element) => element === document.scrollingElement;
    const height = (element) => isRoot(element) ? viewport() : element.clientHeight;
    const hasScroll = (element) => element && element.scrollHeight - height(element) > 1;

    function mainScroller() {
      const root = document.scrollingElement;
      const rootOverflow = root && getComputedStyle(root).overflowY;
      // body overflow can propagate to the viewport when html uses visible.
      const bodyOverflow = document.body && getComputedStyle(document.body).overflowY;
      if (hasScroll(root) && !/hidden|clip/.test(rootOverflow)
          && !(rootOverflow === 'visible' && /hidden|clip/.test(bodyOverflow))) return root;

      // Full-height HTML apps often scroll a main panel, rather than the page.
      // Probe its right edge instead of scanning the entire document on scroll.
      const width = document.documentElement.clientWidth || window.innerWidth;
      let best = null;
      for (const fraction of [0.5, 0.25, 0.75]) {
        for (const hit of document.elementsFromPoint(Math.max(0, width - 2), viewport() * fraction)) {
          for (let element = hit; element && element !== document.documentElement; element = element.parentElement) {
            if (element === host || !hasScroll(element)) continue;
            const rect = element.getBoundingClientRect();
            if (rect.right >= width - 20 && rect.height >= viewport() / 2
                && /auto|scroll|overlay/.test(getComputedStyle(element).overflowY)
                && (!best || element.clientHeight > best.clientHeight)) best = element;
          }
        }
      }
      return best;
    }

    function scheduleHide() {
      clearTimeout(hideTimer);
      if (!drag) hideTimer = setTimeout(() => { delete frame.dataset.scrolling; }, 700);
    }

    function update(reveal) {
      const next = drag ? scroller : mainScroller();
      if (next !== scroller) {
        scroller?.removeAttribute('data-flowix-frame-scroller');
        if (scroller) resizeObserver.unobserve(scroller);
        scroller = next;
        if (scroller) {
          scroller.setAttribute('data-flowix-frame-scroller', '');
          resizeObserver.observe(scroller);
        }
      }
      host.style.setProperty('display', scroller ? 'block' : 'none', 'important');
      frame.dataset.scrollable = String(Boolean(scroller));
      if (!scroller) return;
      const root = isRoot(scroller);
      const rect = scroller.getBoundingClientRect();
      viewportHeight = height(scroller);
      host.style.setProperty('top', `${root ? 0 : rect.top + scroller.clientTop}px`, 'important');
      host.style.setProperty('height', `${viewportHeight}px`, 'important');
      thumbHeight = Math.min(viewportHeight, Math.max(24,
        Math.round(viewportHeight * viewportHeight / scroller.scrollHeight)));
      const travel = Math.max(0, viewportHeight - thumbHeight);
      const maxScroll = Math.max(1, scroller.scrollHeight - viewportHeight);
      const top = Math.round(Math.max(0, Math.min(1, scroller.scrollTop / maxScroll)) * travel);
      frame.style.setProperty('--overlay-scrollbar-thumb-height', `${thumbHeight}px`);
      frame.style.setProperty('--overlay-scrollbar-thumb-top', `${top}px`);
      if (reveal) {
        frame.dataset.scrolling = 'true';
        scheduleHide();
      }
    }

    function scheduleUpdate(reveal = false) {
      revealPending ||= reveal;
      if (animationFrame !== null) return;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        const shouldReveal = revealPending;
        revealPending = false;
        update(shouldReveal);
      });
    }

    thumb.addEventListener('pointerdown', (event) => {
      if (!scroller || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      clearTimeout(hideTimer);
      drag = {
        pointerId: event.pointerId,
        y: event.clientY,
        top: scroller.scrollTop,
        max: scroller.scrollHeight - viewportHeight,
        travel: Math.max(1, viewportHeight - thumbHeight),
      };
      frame.dataset.dragging = 'true';
      frame.dataset.scrolling = 'true';
    });
    thumb.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      scroller.scrollTop = Math.max(0, Math.min(drag.max,
        drag.top + (event.clientY - drag.y) / drag.travel * drag.max));
      scheduleUpdate(true);
    });
    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      delete frame.dataset.dragging;
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
      scheduleHide();
    }
    thumb.addEventListener('pointerup', finishDrag);
    thumb.addEventListener('pointercancel', finishDrag);
    thumb.addEventListener('lostpointercapture', finishDrag);
    host.addEventListener('wheel', (event) => {
      if (!scroller || event.ctrlKey) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
      scroller.scrollTop += event.deltaY * scale;
      scroller.scrollLeft += event.deltaX * scale;
      scheduleUpdate(true);
    }, { passive: false });

    const onScroll = () => scheduleUpdate(true);
    const onResize = () => scheduleUpdate();
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(document.documentElement);
    if (document.body) resizeObserver.observe(document.body);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => record.target !== host && !host.contains(record.target))) scheduleUpdate();
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden'],
    });
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      clearTimeout(hideTimer);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      scroller?.removeAttribute('data-flowix-frame-scroller');
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== nativeStyle);
      host.remove();
    }, { once: true });

    configure = (nextConfig) => {
      host.style.setProperty('--muted-foreground', nextConfig.color);
      scheduleUpdate();
    };
    configure(config);
  }

  function onMessage(event) {
    if (event.source !== window.parent || event.data?.type !== 'flowix:local-html-scrollbar') return;
    const config = event.data;
    if (typeof config.css !== 'string' || typeof config.color !== 'string'
        || !CSS.supports('color', config.color)) return;
    if (configure) configure(config);
    else if (document.readyState === 'loading') pendingConfig = config;
    else mount(config);
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', function onPageHide(event) {
    if (event.persisted) return;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', onPageHide);
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (pendingConfig && !configure) mount(pendingConfig);
    pendingConfig = null;
  }, { once: true });
  window.parent.postMessage({ type: 'flowix:local-html-scrollbar-ready' }, '*');
})();
