import overlayScrollbarCss from '@/styles/overlay-scrollbar.css?raw';

// Reuse the editor's styles inside the preview's shadow root. Platform gating
// belongs to the host; the sandboxed HTML does not inherit its data attributes.
const frameCss = overlayScrollbarCss.split('html[data-platform="non-mac"] ').join('') + `
  * { box-sizing: border-box; }
  .overlay-scrollbar-frame { width: 16px; height: 100%; }
  @media (prefers-reduced-motion: reduce) {
    .overlay-scrollbar-thumb { transition: none; }
  }
`;

/** Connect only the local preview, without granting it same-origin access. */
export function connectLocalHtmlScrollbar(iframe: HTMLIFrameElement): () => void {
  const ownerDocument = iframe.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow || ownerDocument.documentElement.dataset.os !== 'windows') return () => {};

  const syncTheme = () => {
    const color = ownerWindow.getComputedStyle(ownerDocument.documentElement)
      .getPropertyValue('--muted-foreground').trim();
    iframe.contentWindow?.postMessage({
      type: 'flowix:local-html-scrollbar',
      color,
      css: frameCss,
    }, '*'); // Sandboxed asset documents have opaque origins.
  };
  const onReady = (event: MessageEvent) => {
    if (event.source === iframe.contentWindow && event.data?.type === 'flowix:local-html-scrollbar-ready') {
      syncTheme();
    }
  };
  ownerWindow.addEventListener('message', onReady);
  iframe.addEventListener('load', syncTheme);
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  });
  syncTheme();
  return () => {
    ownerWindow.removeEventListener('message', onReady);
    iframe.removeEventListener('load', syncTheme);
    themeObserver.disconnect();
  };
}
