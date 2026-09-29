import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  isRelativeNoteDestination,
  NoteReference,
  parseWikiNoteLinkAtStart,
  splitObsidianTarget,
} from './view-note';
import { MarkdownLink } from '../markdown-link';

describe('Obsidian note links', () => {
  it('shows an inserted note with a notebook and path as valid immediately', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: '<p></p>',
    });
    editor.commands.insertContent({
      type: 'noteReference',
      attrs: {
        notebookId: 'work', relativePath: 'Projects/Plan.md', notebookName: 'Work',
        title: 'Plan', memoId: null, originalPath: null, linkStyle: 'flowix',
        linkTarget: null, heading: null, stale: false,
      },
    });
    expect(editor.view.dom.querySelector('.editor-note-reference__card')?.getAttribute('data-stale')).toBe('false');
    editor.destroy();
  });
  it('round trips a child note by notebook and relative path without a memo ID', () => {
    const link = 'flowix://open?b=Work&f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.attrs).toMatchObject({ notebookName: 'Work', relativePath: 'Projects/Plan.md', memoId: null });
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });
  it('uses the target filename as an internal link display name', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: '[Custom label](flowix://open?b=Work&f=Projects%2FPlan.md)',
      contentType: 'markdown',
    });
    expect(editor.view.dom.querySelector('.editor-note-reference__title')?.textContent).toBe('Plan');
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?b=Work&f=Projects%2FPlan.md)');
    editor.destroy();
  });
  it('keeps an ID-based path link until its notebook name is available', () => {
    const link = 'flowix://open?notebookId=unloaded-book&relativePath=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });
  it('keeps a Flowix notebook path link as a note reference', () => {
    const link = 'flowix://open?b=MyVault&f=Projects%2FPlan.md';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.type.name).toBe('noteReference');
    expect(node?.attrs.linkTarget).toBe(link);
    expect(node?.attrs.memoId).toBeNull();
    editor.destroy();
  });
  it('normalizes an existing book/file link when saved', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: '[Old label](flowix://open?book=MyVault&file=Projects%2FPlan.md)',
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toContain('[Plan](flowix://open?b=MyVault&f=Projects%2FPlan.md)');
    editor.destroy();
  });
  it('marks legacy memo ID links as stale and preserves them for repair', () => {
    const link = 'flowix://memo/abc12345';
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: `[Plan](${link})`,
      contentType: 'markdown',
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.attrs).toMatchObject({ memoId: null, stale: true, linkTarget: link });
    expect(editor.getMarkdown()).toContain(link);
    editor.destroy();
  });
  it('keeps ordinary relative Markdown links lightweight', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown, NoteReference, MarkdownLink],
      content: '[Install](docs/install.md)',
      contentType: 'markdown',
    });

    expect(editor.state.doc.textContent).toBe('Install');
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe('text');
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe('link');
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe('docs/install.md');
    editor.destroy();
  });

  it('parses wiki targets and aliases', () => {
    expect(parseWikiNoteLinkAtStart('[[笔记名称.md]] rest')).toEqual({
      raw: '[[笔记名称.md]]',
      target: '笔记名称.md',
      heading: null,
      title: '笔记名称',
    });
    expect(parseWikiNoteLinkAtStart('[[文件夹/笔记.md|显示名称]]')).toEqual({
      raw: '[[文件夹/笔记.md|显示名称]]',
      target: '文件夹/笔记.md',
      heading: null,
      title: '显示名称',
    });
  });

  it('accepts Obsidian headings and the double-hash compatibility form', () => {
    expect(splitObsidianTarget('笔记名称#二级标题')).toEqual({
      target: '笔记名称',
      heading: '二级标题',
    });
    expect(splitObsidianTarget('笔记名称## 二级标题')).toEqual({
      target: '笔记名称',
      heading: '二级标题',
    });
  });

  it('decodes relative Markdown note destinations without claiming web links', () => {
    expect(splitObsidianTarget('笔记名称%20with%20spaces')).toEqual({
      target: '笔记名称 with spaces',
      heading: null,
    });
    expect(isRelativeNoteDestination('笔记名称.md')).toBe(true);
    expect(isRelativeNoteDestination('笔记名称%20with%20spaces')).toBe(true);
    expect(isRelativeNoteDestination('https://example.com/note.md')).toBe(false);
    expect(isRelativeNoteDestination('#二级标题')).toBe(false);
  });
});
