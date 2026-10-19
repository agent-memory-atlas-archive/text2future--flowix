import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { history, redo, undo } from '@tiptap/pm/history';
import { afterEach, describe, expect, it } from 'vitest';
import { createInlineAtomMaintenancePlugin, removeHardBreaksAroundInlineAtoms } from './inline-atom-maintenance';
import { createTerminalInlineAtomCaretDecorations, terminalInlineAtomCaretPosition } from './terminal-inline-atom-caret';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
  blockquote: { content: 'block+', group: 'block', toDOM: () => ['blockquote', 0] },
  text: { group: 'inline' },
  inlineContainer: { inline: true, group: 'inline', content: 'inline*', toDOM: () => ['span', 0] },
  hardBreak: { inline: true, group: 'inline', toDOM: () => ['br'] },
  noteReference: { inline: true, atom: true, group: 'inline', toDOM: () => ['span', { 'data-note': '' }, 'note'] },
  fileAttachment: { inline: true, atom: true, group: 'inline', toDOM: () => ['span', { 'data-file': '' }, 'file'] },
} });
const text = (value: string) => schema.text(value);
const atom = (name: 'noteReference' | 'fileAttachment') => schema.node(name);
const br = () => schema.node('hardBreak');
const paragraph = (...content: ReturnType<typeof text>[]) => schema.node('paragraph', null, content);
const names = ['noteReference', 'fileAttachment'] as const;

function fixture() {
  const plugins = names.map((name) => createInlineAtomMaintenancePlugin([name]));
  const state = EditorState.create({ doc: schema.node('doc', null, [
    paragraph(text('first')), paragraph(text('prefix '), atom('noteReference')),
    schema.node('blockquote', null, paragraph(atom('fileAttachment'))),
  ]), plugins: [...plugins, history()] });
  return { state, plugins };
}
function assertCarets(state: EditorState, plugins: ReturnType<typeof fixture>['plugins']) {
  plugins.forEach((plugin, index) => {
    expect(plugin.getState(state)!.find().map(({ from, to }) => [from, to]))
      .toEqual(createTerminalInlineAtomCaretDecorations(state.doc, names[index]).find().map(({ from, to }) => [from, to]));
  });
}
let view: EditorView | undefined;
afterEach(() => { view?.destroy(); view = undefined; document.body.replaceChildren(); });

describe('inline atom maintenance', () => {
  it('maps untouched caret widgets after edits before them and invalidates changed block endings', () => {
    let { state, plugins } = fixture();
    for (const tr of [state.tr.insertText('longer ', 1)]) {
      state = state.applyTransaction(tr).state;
      assertCarets(state, plugins);
    }
    const secondEnd = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize - 1;
    state = state.applyTransaction(state.tr.insertText('after', secondEnd)).state;
    assertCarets(state, plugins);
    expect(plugins[0].getState(state)!.find()).toHaveLength(0);
  });

  it('normalizes imported breaks once, including a shared break between two atoms', () => {
    let state = EditorState.create({ doc: schema.node('doc', null,
      paragraph(br(), atom('noteReference'), br(), atom('fileAttachment'), br())) });
    const tr = removeHardBreaksAroundInlineAtoms(state, names);
    expect(tr).not.toBeNull();
    state = state.apply(tr!);
    expect(state.doc.firstChild!.childCount).toBe(2);
    expect(removeHardBreaksAroundInlineAtoms(state, names)).toBeNull();
  });

  it('preserves normalization inside nested inline content', () => {
    let state = EditorState.create({ doc: schema.node('doc', null, paragraph(
      schema.node('inlineContainer', null, [br(), atom('noteReference'), br()]),
    )) });
    state = state.apply(removeHardBreaksAroundInlineAtoms(state, names)!);
    expect(state.doc.firstChild!.firstChild!.childCount).toBe(1);
    expect(state.doc.firstChild!.firstChild!.firstChild!.type.name).toBe('noteReference');
  });

  it('cleans pasted neighboring breaks through both standalone plugins and handles history', () => {
    let { state, plugins } = fixture();
    state = state.applyTransaction(state.tr.replaceWith(1, 6, [br(), atom('noteReference'), br(), atom('fileAttachment'), br()])).state;
    expect(state.doc.firstChild!.childCount).toBe(2);
    assertCarets(state, plugins);
    expect(undo(state, (tr) => { state = state.applyTransaction(tr).state; })).toBe(true);
    expect(state.doc.firstChild!.textContent).toBe('first');
    assertCarets(state, plugins);
    expect(redo(state, (tr) => { state = state.applyTransaction(tr).state; })).toBe(true);
    expect(state.doc.firstChild!.childCount).toBe(2);
    assertCarets(state, plugins);
  });

  it('does not normalize unrelated blocks on a local text edit', () => {
    // Imported legacy content outside the edit range is left to the onCreate pass.
    const plugin = createInlineAtomMaintenancePlugin(['noteReference']);
    let state = EditorState.create({ doc: schema.node('doc', null, [
      paragraph(text('edit')), paragraph(text('middle')), paragraph(br(), atom('noteReference')),
    ]), plugins: [plugin] });
    state = state.applyTransaction(state.tr.insertText('x', 2)).state;
    expect(state.doc.child(2).firstChild!.type.name).toBe('hardBreak');
  });

  it('keeps live widget positions correct while reusing their DOM after position mapping', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { state } = fixture();
    view = new EditorView(host, { state });
    const anchor = host.querySelector<HTMLElement>('.terminal-inline-atom-caret-anchor')!;
    const before = terminalInlineAtomCaretPosition(anchor)!;
    const tr = view.state.tr.insertText('extra', 1);
    view.updateState(view.state.applyTransaction(tr).state);
    expect(host.querySelector('.terminal-inline-atom-caret-anchor')).toBe(anchor);
    expect(terminalInlineAtomCaretPosition(anchor)).toBe(before + 5);
  });
});
