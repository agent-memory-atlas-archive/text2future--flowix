import { useLayoutEffect, useState, type RefObject } from 'react';
import { normalizeTagInput } from '@features/document/properties/frontmatter-model';
import { autoContentColumnWidth, autoTagColumnWidth } from './tag-column-width';

export interface AutoColumnContent {
  id: string;
  label: string;
  type: 'tags' | 'chips' | 'text' | 'primary';
  isNoteTags?: boolean;
  extraWidth?: number;
  itemGapWidth?: number;
  values?: string[][];
  textValues?: { text: string; extraWidth?: number }[];
}

/** Measure natural content widths independently from mounted rows and their current column widths. */
export function useAutoContentColumnWidths(tableRef: RefObject<HTMLTableElement | null>, columns: readonly AutoColumnContent[]) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || !columns.length) {
      setWidths((current) => Object.keys(current).length ? {} : current);
      return;
    }
    const probe = document.createElement('span');
    probe.className = 'multidimensional-table multidimensional-table__content-width-probe text-sm';
    probe.setAttribute('aria-hidden', 'true');
    const cardCache = new Map<string, HTMLElement>();
    const textCanvas = document.createElement('canvas');
    const context = textCanvas.getContext('2d');
    const measurements = columns.map((column) => {
      const label = document.createElement('span');
      label.textContent = column.label;
      probe.append(label);
      const cardRows = (column.values ?? []).map((value) => {
        const rowCards: HTMLElement[] = [];
        for (const rawTag of value) {
          const tag = column.isNoteTags ? normalizeTagInput(rawTag) : rawTag.trim();
          if (!tag) continue;
          const key = JSON.stringify([column.type, column.isNoteTags, tag]);
          let card = cardCache.get(key);
          if (!card) {
            card = document.createElement('span');
            card.className = column.type === 'chips'
              ? 'multidimensional-table__option-chip'
              : `frontmatter-property__edit-tag-chip${column.isNoteTags ? '' : ' frontmatter-property__edit-tag-chip--plain multidimensional-table__plain-tag-chip'}`;
            if (column.type === 'chips') {
              card.textContent = tag;
            } else if (column.isNoteTags) {
              const prefix = document.createElement('span');
              prefix.className = 'tag-node-prefix';
              prefix.textContent = '#';
              const content = document.createElement('span');
              content.className = 'tag-node-content';
              content.textContent = tag;
              card.append(prefix, content);
            } else {
              const content = document.createElement('span');
              content.className = 'tag-node-content';
              content.textContent = tag;
              card.append(content);
            }
            probe.append(card);
            cardCache.set(key, card);
          }
          rowCards.push(card);
        }
        return rowCards;
      });
      return { ...column, label, cardRows };
    });
    table.parentElement?.append(probe);

    const measure = () => {
      const style = getComputedStyle(probe);
      const inset = parseFloat(style.getPropertyValue('--multidimensional-table-content-inset')) || 8;
      const chromeWidth = inset * 2;
      if (context) {
        // WebKit can return an empty computed `font` shorthand. Build a valid
        // Canvas font from its longhands so text is not measured at 10px sans-serif.
        context.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      }
      const cardWidths = new Map([...cardCache.values()].map((card) => [card, card.getBoundingClientRect().width]));
      const next = Object.fromEntries(measurements.map((column) => {
        const headerWidth = labelWidth(column.label) + 80;
        const width = column.type === 'tags' || column.type === 'chips'
          ? autoTagColumnWidth(
            column.cardRows.map((row) => row.reduce((total, card) => total + (cardWidths.get(card) ?? 0), 0)
              + Math.max(0, row.length - 1) * (column.itemGapWidth ?? 0)),
            chromeWidth + (column.type === 'chips' ? column.extraWidth ?? 0 : 0),
            headerWidth,
          )
          : autoContentColumnWidth((column.textValues ?? []).map(({ text, extraWidth = 0 }) => {
            const lines = text.split(/\r\n|\r|\n/);
            const textWidth = lines.reduce((widest, line) => Math.max(widest, context?.measureText(line).width ?? line.length * 8), 0);
            return textWidth + extraWidth;
          }), chromeWidth, headerWidth);
        return [column.id, width];
      }));
      setWidths((current) => Object.keys(current).length === Object.keys(next).length
        && Object.entries(next).every(([id, width]) => current[id] === width) ? current : next);
    };
    const labelWidth = (label: HTMLElement) => label.getBoundingClientRect().width;
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const element of probe.children) observer?.observe(element);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
      probe.remove();
    };
  }, [tableRef, columns]);
  return widths;
}
