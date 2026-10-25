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

/** Keep one native scrollbar per HTML scrolling region. Only its thumb color
 * changes while scrolling; overflow, geometry and native interactions stay owned
 * by the page/browser. Match the editor's platform-specific thumb colors.
 */
export function localHtmlScrollbarCss(color: string, mac: boolean): string {
  const thumb = `color-mix(in oklch, ${color} ${mac ? 78 : 34}%, transparent)`;
  return `
    * { scrollbar-width: ${mac ? 'auto' : 'thin'} !important; scrollbar-color: ${mac ? 'auto' : 'transparent transparent'} !important; }
    ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
    ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent !important; }
    ::-webkit-scrollbar-thumb { background: transparent !important; border-radius: 999px !important; }
    [data-flowix-html-scrolling="true"] { scrollbar-color: ${mac ? 'auto' : `${thumb} transparent`} !important; }
    [data-flowix-html-scrolling="true"]::-webkit-scrollbar-thumb { background: ${thumb} !important; }
    [data-flowix-html-scrolling="true"]::-webkit-scrollbar-thumb:hover { background: ${color} !important; }
  `;
}
