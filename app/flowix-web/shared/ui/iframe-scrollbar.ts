/** Match the editor's narrow scrollbar in documents that Flowix can style. */
export function iframeScrollbarCss(color: string): string {
  return `
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${color}; border-radius: 3px; }
    * { scrollbar-width: thin; scrollbar-color: ${color} transparent; }
  `;
}

export function styleAccessibleIframeScrollbar(iframe: HTMLIFrameElement | null): void {
  if (!iframe || document.documentElement.dataset.platform !== 'non-mac') return;
  try {
    const doc = iframe.contentDocument;
    if (!doc?.head || doc.getElementById('flowix-iframe-scrollbar')) return;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim();
    if (!color) return;
    const style = doc.createElement('style');
    style.id = 'flowix-iframe-scrollbar';
    style.textContent = iframeScrollbarCss(`color-mix(in oklch, ${color} 30%, transparent)`);
    doc.head.append(style);
  } catch {
    // Cross-origin documents cannot be styled from the host page.
  }
}
