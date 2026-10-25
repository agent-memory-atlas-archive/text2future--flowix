// Installed by the native host at document start, including sandboxed frames.
(() => {
  if (window === window.parent) return;
  const url = new URL(location.href);
  const local = (url.protocol === 'asset:' && url.hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
  if (!local) return;

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
  }, { once: true });
  document.addEventListener('readystatechange', ready);
  ready();
})();
