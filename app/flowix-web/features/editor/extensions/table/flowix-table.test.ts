import { Editor, type JSONContent } from '@tiptap/core';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { sanitizeExternalHtml } from '../paste-rules/html-sanitizer';
import { htmlTableToTableContent } from '../paste-rules/table';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it } from 'vitest';

import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';

const editors: Editor[] = [];

function createEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), createTablePlugin(), Markdown],
    content,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('Flowix table column widths', () => {
  it('restores hidden column widths from Markdown metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":240}]} -->',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    const table = editor.state.doc.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.firstChild?.firstChild?.attrs.colwidth).toEqual([120]);
    expect(table?.firstChild?.child(1).attrs.colwidth).toEqual([240]);
  });

  it('serializes restored widths back to metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":null}]} -->',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(editor.getMarkdown()).toContain('<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":null}]} -->');
  });

  it('keeps reading the legacy width metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table-widths=120,240 -->',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([120]);
    expect(editor.getMarkdown()).toContain('<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":240}]} -->');
    expect(editor.getMarkdown()).not.toContain('flowix:table-widths=');
  });

  it('keeps tables without width metadata compatible', () => {
    const editor = createEditor([
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(editor.state.doc.firstChild?.type.name).toBe('table');
    expect(editor.getMarkdown()).not.toContain('flowix:table-widths=');
  });

  it('distinguishes a missing row header from a column header', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":null},{"width":null}],"rowHeader":false,"columnHeader":true} -->',
      '|  |  |',
      '| --- | --- |',
      '| Name | Value |',
      '| Alpha | 1 |',
    ].join('\n'));

    const table = editor.state.doc.firstChild;
    expect(table?.firstChild?.firstChild?.type.name).toBe('tableHeader');
    expect(table?.firstChild?.firstChild?.textContent).toBe('Name');
    expect(table?.child(1).firstChild?.type.name).toBe('tableHeader');
    expect(table?.child(1).firstChild?.textContent).toBe('Alpha');
    expect(editor.getMarkdown()).toContain('"rowHeader":false');
    expect(editor.getMarkdown()).toContain('"columnHeader":true');
  });

  it('preserves a table after its header row is removed', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":null},{"width":null}],"rowHeader":false} -->',
      '|  |  |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    const table = editor.state.doc.firstChild;
    expect(table?.firstChild?.firstChild?.type.name).toBe('tableCell');
    expect(table?.firstChild?.firstChild?.textContent).toBe('Alpha');
    expect(editor.getMarkdown()).toContain('"rowHeader":false');
  });
});


describe('complex table HTML persistence', () => {
  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const bullet = { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('哈哈'),
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('nested | <text>')] }] },
  ] }] };
  const tasks = { type: 'taskList', content: [true, false].map(checked => ({
    type: 'taskItem', attrs: { checked }, content: [paragraph('todo'),
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: !checked }, content: [paragraph('child')] }] },
    ],
  })) };

  it.each([bullet, tasks, { type: 'paragraph', content: [{ type: 'text', text: 'first' }] }])(
    'preserves complex cells, attributes and neighboring Markdown across repeated saves: $type', block => {
      const editor = createEditor('');
      editor.commands.setContent({ type: 'doc', content: [paragraph('before'), { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colwidth: [180] }, content: [paragraph('header')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [block, paragraph('after block')] }] },
      ] }, paragraph('after')] });
      const expected = editor.getJSON();
      for (let i = 0; i < 2; i++) {
        const markdown = editor.getMarkdown();
        expect(markdown).toContain('<table');
        expect(markdown).not.toContain('| ---');
        editor.commands.setContent(markdown, { contentType: 'markdown' });
        expect(editor.getJSON()).toEqual(expected);
      }
      const html = editor.getMarkdown();
      expect(htmlTableToTableContent(html, editor.schema)).toEqual(expected.content?.[1]);
    },
  );

  it.each([bullet, tasks])('uses HTML for a single list block: $type', block => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [{ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [160], colspan: 2 }, content: [block] }] },
    ] }] });
    const table: JSONContent | undefined = editor.getJSON().content?.[0];
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('<table');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON().content?.[0]).toEqual(table);
    const pasted = htmlTableToTableContent(sanitizeExternalHtml(markdown), editor.schema);
    expect(pasted?.content?.[0]?.content?.[0]?.content).toEqual(table?.content?.[0]?.content?.[0]?.content);
  });

  it('keeps renderers isolated between simultaneous editors', () => {
    const first = createEditor('<table><tr><td><ul><li><p>first</p></li></ul></td></tr></table>');
    const second = createEditor('<table><tr><td><p>one</p><p>two</p></td></tr></table>');
    expect(first.getMarkdown()).toContain('<ul>');
    second.destroy();
    expect(first.getMarkdown()).toContain('<ul>');
    first.commands.setContent('<table><tr><td><p>simple</p></td></tr></table>', { contentType: 'markdown' });
    expect(first.getMarkdown()).not.toContain('<table');
  });

  it('keeps literal list-like text in a simple Markdown table', () => {
    const editor = createEditor('| Header |\n| --- |\n| - 哈哈 |');
    expect(editor.getMarkdown()).not.toContain('<table');
    expect(editor.state.doc.firstChild?.child(1).firstChild?.firstChild?.type.name).toBe('paragraph');
  });
});
