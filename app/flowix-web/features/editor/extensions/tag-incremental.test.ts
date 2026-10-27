import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import { describe, expect, it, vi } from 'vitest';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Tag, createTagDecorations, createTagDecorationPlugin, tagDecorationPluginKey } from './tag';

const schema = getSchema([StarterKit, Tag]);
const p = (text: string) => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const positions = (state: EditorState) => tagDecorationPluginKey.getState(state)!.find().map(({ from, to }) => [from, to]);

/**
 * 每个 tag 现在产出 4 条 inline decoration：prefix 与 content 各有一层文字
 * span 和一层背景框 span（见 tag.ts 里 nodeName 分层的注释）。
 * 断言按“tag 数 × 4”写，避免以后再加一层包装又要改数字。
 */
const DECORATIONS_PER_TAG = 4;
function expectFullResult(state: EditorState) {
  expect(positions(state)).toEqual(createTagDecorations(state).find().map(({ from, to }) => [from, to]));
}
function fixture() {
  return EditorState.create({ doc: schema.node('doc', null, [p('#first tail'), p('#second'), p('中文 #项目/阶段')]),
    plugins: [createTagDecorationPlugin(), history()] });
}

describe('incremental tag decorations', () => {
  it('matches full recomputation after multi-step replacements, splits, joins and mark changes', () => {
    let state = fixture();
    const apply = (tr: typeof state.tr) => { state = state.apply(tr); expectFullResult(state); };
    apply(state.tr.insertText('x', 3).insertText(' #added', 9));
    apply(state.tr.addMark(1, 8, schema.marks.code.create()));
    apply(state.tr.removeMark(1, 8, schema.marks.code));
    apply(state.tr.split(5));
    apply(state.tr.join(state.doc.child(0).nodeSize));
    apply(state.tr.replaceWith(0, state.doc.content.size, [p('#new'), schema.node('codeBlock', null, schema.text('#code'))]));
    // 段落里 1 个 tag；codeBlock 内的 #code 不算。
    expect(positions(state)).toHaveLength(DECORATIONS_PER_TAG);
  });

  it('updates block type changes and tags around inline hard breaks', () => {
    let state = EditorState.create({ doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('#one'), schema.node('hardBreak'), schema.text('#two')]),
      p('plain'),
    ]), plugins: [createTagDecorationPlugin()] });
    expectFullResult(state);
    expect(positions(state)).toHaveLength(2 * DECORATIONS_PER_TAG);
    state = state.apply(state.tr.setBlockType(0, state.doc.child(0).nodeSize, schema.nodes.codeBlock));
    expectFullResult(state);
    expect(positions(state)).toHaveLength(0);
    state = state.apply(state.tr.setBlockType(0, state.doc.child(0).nodeSize, schema.nodes.paragraph));
    expectFullResult(state);
  });

  it('keeps decorations correct during composition updates, undo and redo', () => {
    let state = fixture();
    state = state.apply(state.tr.insertText('任务', 3).setMeta('composition', 1));
    state = state.apply(state.tr.insertText('完成', 5).setMeta('composition', 1));
    expectFullResult(state);
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expectFullResult(state);
    expect(redo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expectFullResult(state);
    const before = tagDecorationPluginKey.getState(state);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    expect(tagDecorationPluginKey.getState(state)).toBe(before);
  });

  it('does not rescan text in unrelated paragraphs on an ordinary keystroke', () => {
    let state = EditorState.create({ doc: schema.node('doc', null,
      Array.from({ length: 5000 }, (_, i) => p(`#tag${i} text`))), plugins: [createTagDecorationPlugin()] });
    const spy = vi.spyOn(ProseMirrorNode.prototype, 'descendants');
    try {
      state = state.apply(state.tr.insertText('x', 3));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
      expect(spy.mock.contexts).not.toContain(state.doc.child(4999));
    } finally { spy.mockRestore(); }
    expectFullResult(state);
  });

  it('matches a fresh decoration set across repeated edits and deletions', () => {
    let state = fixture();
    for (let i = 0; i < 60; i++) {
      const from = 1 + (i % Math.max(1, state.doc.firstChild!.content.size));
      const tr = i % 3 === 0 ? state.tr.delete(from, Math.min(from + 1, state.doc.firstChild!.nodeSize - 1))
        : state.tr.insertText(i % 2 ? '#' : ' ', from);
      state = state.apply(tr);
      expectFullResult(state);
    }
  });
});
