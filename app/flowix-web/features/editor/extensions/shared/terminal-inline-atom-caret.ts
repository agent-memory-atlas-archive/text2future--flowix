import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { forEachTextblock, type DocumentRange } from './textblock-ranges';

const anchorPositions = new WeakMap<HTMLElement, () => number | undefined>();

/** Widget DOM can survive a position mapping. Read its live ProseMirror position. */
export function terminalInlineAtomCaretPosition(anchor: HTMLElement): number | undefined {
  const getPos = anchorPositions.get(anchor);
  if (getPos) return getPos();
  const position = anchor.getAttribute('data-terminal-inline-atom-caret-position');
  return position === null ? undefined : Number(position);
}

/** Adds a view-only caret after inline atoms that end a textblock. */
export function createTerminalInlineAtomCaretDecorations(
  doc: ProseMirrorNode,
  nodeTypeNames: string | readonly string[],
  ranges: readonly DocumentRange[] = [{ from: 0, to: doc.content.size }],
): DecorationSet {
  const names = new Set(Array.isArray(nodeTypeNames) ? nodeTypeNames : [nodeTypeNames]);
  const decorations: Decoration[] = [];
  forEachTextblock(doc, ranges, (block, pos) => {
    const last = block.lastChild;
    if (!last || !names.has(last.type.name)) return;
    const afterPos = pos + 1 + block.content.size;
    decorations.push(Decoration.widget(afterPos, (_view, getPos) => {
      const anchor = document.createElement('span');
      anchor.className = 'terminal-inline-atom-caret-anchor';
      anchorPositions.set(anchor, getPos);
      anchor.setAttribute('aria-hidden', 'true');
      anchor.appendChild(document.createTextNode('\u200B'));
      return anchor;
    }, {
      key: `terminal-inline-atom-caret-${last.type.name}-${afterPos}`,
      side: 1,
    }));
  });
  return DecorationSet.create(doc, decorations);
}
