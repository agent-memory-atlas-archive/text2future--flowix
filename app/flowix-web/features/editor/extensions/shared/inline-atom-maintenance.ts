import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import { createTerminalInlineAtomCaretDecorations } from './terminal-inline-atom-caret';
import {
  changedTextblockRanges, forEachTextblock, updateTextblockDecorations, type DocumentRange,
} from './textblock-ranges';

/** Shared normalization for standalone note-reference and file-attachment nodes. */
export function removeHardBreaksAroundInlineAtoms(
  state: EditorState,
  nodeTypeNames: readonly string[],
  ranges: readonly DocumentRange[] = [{ from: 0, to: state.doc.content.size }],
) {
  const names = new Set(nodeTypeNames);
  const deletions = new Set<number>();
  forEachTextblock(state.doc, ranges, (block, pos) => {
    block.descendants((node, offset) => {
      if (!names.has(node.type.name)) return;
      const from = pos + 1 + offset;
      const before = state.doc.resolve(from).nodeBefore;
      const after = state.doc.resolve(from + node.nodeSize).nodeAfter;
      if (before?.type.name === 'hardBreak') deletions.add(from - before.nodeSize);
      if (after?.type.name === 'hardBreak') deletions.add(from + node.nodeSize);
    });
  });
  if (!deletions.size) return null;
  const transaction = state.tr;
  for (const pos of [...deletions].sort((left, right) => right - left)) transaction.delete(pos, pos + 1);
  return transaction;
}

export function createInlineAtomMaintenancePlugin(nodeTypeNames: readonly string[]) {
  const key = new PluginKey<DecorationSet>(`inlineAtomMaintenance:${nodeTypeNames.join(',')}`);
  return new Plugin({
    key,
    state: {
      init: (_, state) => createTerminalInlineAtomCaretDecorations(state.doc, nodeTypeNames),
      apply: (transaction, previous) => updateTextblockDecorations(
        transaction, previous,
        (doc, ranges) => createTerminalInlineAtomCaretDecorations(doc, nodeTypeNames, ranges),
      ),
    },
    props: { decorations: (state) => key.getState(state) ?? DecorationSet.empty },
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      return removeHardBreaksAroundInlineAtoms(
        newState, nodeTypeNames, changedTextblockRanges(transactions, newState.doc),
      );
    },
  });
}
