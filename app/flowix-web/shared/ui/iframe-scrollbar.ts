/** Narrow native scrollbar for same-origin documents Flowix can style directly. */
export function iframeScrollbarCss(color: string): string {
  return `
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${color}; border-radius: 3px; }
    * { scrollbar-width: thin; scrollbar-color: ${color} transparent; }
  `;
}
