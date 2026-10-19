import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { changedTextblockRanges, forEachTextblock } from './textblock-ranges';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    blockquote: { group: 'block', content: 'block+' },
    text: {},
  },
  marks: { code: {} },
});
const paragraph = (text: string) => schema.node('paragraph', null, schema.text(text));

function visited(state: EditorState, transactions: Parameters<typeof changedTextblockRanges>[0]) {
  const result: string[] = [];
  forEachTextblock(state.doc, changedTextblockRanges(transactions, state.doc), (block) => result.push(block.textContent));
  return result;
}

describe('changed textblock ranges', () => {
  it('visits a bounded number of blocks in a 5000-paragraph document', () => {
    const state = EditorState.create({ doc: schema.node('doc', null,
      Array.from({ length: 5000 }, (_, i) => paragraph(`paragraph ${i}`))) });
    const at = state.doc.child(0).nodeSize + 2;
    const tr = state.tr.insertText('x', at);
    const blocks = visited(state.apply(tr), [tr]);
    expect(blocks.length).toBeLessThanOrEqual(3);
    expect(blocks).toContain('pxaragraph 1');
    expect(blocks).not.toContain('paragraph 4999');
  });

  it('covers mark-only changes whose StepMap is empty', () => {
    const state = EditorState.create({ doc: schema.node('doc', null, [paragraph('first'), paragraph('second')]) });
    const from = state.doc.child(0).nodeSize + 1;
    const tr = state.tr.addMark(from, from + 6, schema.marks.code.create());
    expect(visited(state.apply(tr), [tr])).toContain('second');
  });

  it('maps earlier changes through later transactions used by appendTransaction', () => {
    const state = EditorState.create({ doc: schema.node('doc', null, [paragraph('first'), paragraph('second'), paragraph('third')]) });
    const first = state.tr.insertText('!', 10);
    const intermediate = state.apply(first);
    const second = intermediate.tr.insertText('prefix ', 1);
    const blocks = visited(intermediate.apply(second), [first, second]);
    expect(blocks).toContain('prefix first');
    expect(blocks).toContain('se!cond');
  });

  it('expands edits inside nested blocks and joins to their final textblocks', () => {
    let state = EditorState.create({ doc: schema.node('doc', null, [schema.node('blockquote', null, [paragraph('one'), paragraph('two')])]) });
    const tr = state.tr.join(1 + state.doc.firstChild!.firstChild!.nodeSize);
    state = state.apply(tr);
    expect(visited(state, [tr])).toEqual(['onetwo']);
  });
});
