import { localHtmlScrollbarCss } from './iframe-scrollbar';

/** Connect only the local preview, without granting it same-origin access. */
export function connectLocalHtmlScrollbar(iframe: HTMLIFrameElement): () => void {
  const ownerDocument = iframe.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return () => {};

  const syncTheme = () => {
    const color = ownerWindow.getComputedStyle(ownerDocument.documentElement)
      .getPropertyValue('--muted-foreground').trim();
    const mac = ownerDocument.documentElement.dataset.platform === 'mac' || ownerDocument.documentElement.dataset.os === 'mac';
    iframe.contentWindow?.postMessage({
      type: 'flowix:local-html-scrollbar',
      color,
      mac,
      css: localHtmlScrollbarCss(color, mac),
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
