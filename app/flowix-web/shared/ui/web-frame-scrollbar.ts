const CONFIG_TYPE = 'flowix:web-frame-scrollbar';
const READY_TYPE = 'flowix:web-frame-scrollbar-ready';

/**
 * Remote pages cannot be reached through `contentDocument`, so the shell ships a
 * frame script that rebuilds their scrollbars from the inside. This only hands
 * that script the theme tokens it needs — it never touches the page document,
 * and it works for cross-origin frames because it goes through postMessage.
 */
export function connectWebFrameScrollbar(iframe: HTMLIFrameElement): () => void {
  const ownerDocument = iframe.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return () => {};

  const sync = () => {
    const root = ownerDocument.documentElement;
    const muted = ownerWindow.getComputedStyle(root).getPropertyValue('--muted-foreground').trim();
    const mac = root.dataset.platform === 'mac' || root.dataset.os === 'mac';
    const weight = mac ? 78 : 40;
    iframe.contentWindow?.postMessage({
      type: CONFIG_TYPE,
      mac,
      color: muted ? `color-mix(in oklch, ${muted} ${weight}%, transparent)` : '',
    }, '*'); // Remote documents are cross-origin; the frame script validates the payload.
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source === iframe.contentWindow && event.data?.type === READY_TYPE) {
      sync();
    }
  };

  ownerWindow.addEventListener('message', onMessage);
  iframe.addEventListener('load', sync);
  const themeObserver = new MutationObserver(sync);
  themeObserver.observe(ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  });
  sync();

  return () => {
    ownerWindow.removeEventListener('message', onMessage);
    iframe.removeEventListener('load', sync);
    themeObserver.disconnect();
  };
}
