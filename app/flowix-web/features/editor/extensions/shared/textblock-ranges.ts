import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { DecorationSet } from '@tiptap/pm/view';

export interface DocumentRange { from: number; to: number }

function mergeRanges(ranges: DocumentRange[]): DocumentRange[] {
  const merged: DocumentRange[] = [];
  for (const range of ranges.sort((left, right) => left.from - right.from)) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

export function forEachTextblock(
  doc: ProseMirrorNode,
  ranges: readonly DocumentRange[],
  visit: (node: ProseMirrorNode, pos: number) => void,
): void {
  for (const { from, to } of ranges) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      visit(node, pos);
      return false;
    });
  }
}

/** Map every changed step to the final document, then expand to whole textblocks.
 * Boundary neighbors cover splits/joins and deletions that leave an empty range.
 * Mark/attribute steps can have empty StepMaps; use their authored range instead.
 */
export function changedTextblockRanges(
  transactions: readonly Transaction[],
  doc: ProseMirrorNode,
): DocumentRange[] {
  const mapping = new Mapping();
  for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
  const changed: DocumentRange[] = [];
  let stepIndex = 0;
  for (const transaction of transactions) {
    for (const step of transaction.steps) {
      const remaining = mapping.slice(++stepIndex);
      const add = (from: number, to: number) => changed.push({
        from: remaining.map(from, -1), to: remaining.map(to, 1),
      });
      let hasRange = false;
      step.getMap().forEach((_oldFrom, _oldTo, from, to) => {
        hasRange = true;
        add(from, to);
      });
      if (hasRange) continue;
      if ('from' in step && 'to' in step && typeof step.from === 'number' && typeof step.to === 'number') {
        add(step.from, step.to);
      } else if ('pos' in step && typeof step.pos === 'number') {
        add(step.pos, step.pos + 1);
      } else {
        // Custom steps without an addressable range retain the safe full path.
        return [{ from: 0, to: doc.content.size }];
      }
    }
  }
  const blocks: DocumentRange[] = [];
  const bounds = mergeRanges(changed.map(({ from, to }) => ({
    from: Math.max(0, Math.min(from, doc.content.size) - 1),
    to: Math.min(doc.content.size, Math.max(0, to) + 1),
  })));
  forEachTextblock(doc, bounds, (node, pos) => blocks.push({ from: pos, to: pos + node.nodeSize }));
  return mergeRanges(blocks);
}

export function updateTextblockDecorations(
  transaction: Transaction,
  previous: DecorationSet,
  build: (doc: ProseMirrorNode, ranges: readonly DocumentRange[]) => DecorationSet,
): DecorationSet {
  if (!transaction.docChanged) return previous;
  const doc = transaction.doc;
  const mapped = previous.map(transaction.mapping, doc);
  const ranges = changedTextblockRanges([transaction], doc);
  const stale = ranges.flatMap(({ from, to }) => mapped.find(from, to));
  return mapped.remove(stale).add(doc, build(doc, ranges).find());
}
