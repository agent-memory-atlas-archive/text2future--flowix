// Installed by the native host at document start, including sandboxed frames.
(() => {
  if (window === window.parent) return;
  const url = new URL(location.href);
  const local = (url.protocol === 'asset:' && url.hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
  if (!local) return;

  const documentUrl = (value) => {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href;
  };
  const click = (event) => {
    if (event.button !== 0 && !(event.type === 'auxclick' && event.button === 1)) return;
    const anchor = event.target?.closest?.('a[href], area[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href?.trim()) return;
    try {
      const destination = new URL(href, document.baseURI || location.href);
      if (destination.href.includes('#') && documentUrl(destination.href) === documentUrl(location.href)) return;
    } catch {
      // Invalid links are handled by the host along with unsupported protocols.
    }
    // All cross-document links, including _blank/download, follow Browser's
    // normal surface navigation. The preview never launches another window.
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage({
      type: 'flowix:local-html-link', url: location.href, href,
      baseHref: document.querySelector?.('base[href]')?.getAttribute('href') ?? null,
    }, '*');
  };
  document.addEventListener('click', click, true);
  document.addEventListener('auxclick', click, true);

  function ready() {
    if (document.readyState === 'loading') return;
    document.removeEventListener('readystatechange', ready);
    // Interactive means the document was parsed, before deferred scripts and
    // images finish. External dependencies must not hold the Work host open.
    window.parent.postMessage({
      type: 'flowix:local-html-document-ready', url: location.href,
    }, '*');
  }
  const probe = (event) => {
    if (event.source === window.parent && event.data?.type === 'flowix:local-html-document-probe') ready();
  };
  window.addEventListener('message', probe);
  window.addEventListener('pagehide', () => {
    document.removeEventListener('readystatechange', ready);
    window.removeEventListener('message', probe);
    document.removeEventListener('click', click, true);
    document.removeEventListener('auxclick', click, true);
  }, { once: true });
  document.addEventListener('readystatechange', ready);
  ready();
})();
