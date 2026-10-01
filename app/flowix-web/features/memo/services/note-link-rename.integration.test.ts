import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

const { invoke, notebooks } = vi.hoisted(() => ({
  invoke: vi.fn(),
  notebooks: [] as { id: string; name: string; path: string }[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => ({ notebooks, notebooksInitialized: true }) },
}));

import { localDocumentOperations } from '@features/document/use-cases/local-document-operations';
import { applyLoadedDocumentContent, getDocumentBuffer, recordDocumentEdit } from '@features/document/store/document-session-service';
import { acceptBackgroundDocumentContent, hasLiveUnsavedDocumentAtPath } from '@features/document/public/workspace-api';
import { NoteReference } from '@features/editor/extensions/note-link/view-note';
import { toNoteReferenceAttrs } from '@features/editor/extensions/note-mention/note-mention-data';
import { canonicalPath } from '@/lib/path';
import { rewriteNoteLinkMoves } from './note-link-rewriter';

let root = '';
const editors: Editor[] = [];
afterEach(async () => {
  editors.splice(0).forEach(editor => editor.destroy());
  localStorage.removeItem('flowix:pending-note-link-moves');
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

function editor() {
  const value = new Editor({ extensions: [StarterKit, Markdown, NoteReference], content: '<p></p>' });
  editors.push(value);
  return value;
}

describe('rename B updates the Markdown reference in A', () => {
  it('uses the real mention serializer, rename entry, job queue, files, and retained document buffer', async () => {
    root = await mkdtemp(join(tmpdir(), 'flowix-link-rename-'));
    const noteA = canonicalPath(join(root, 'A.md'));
    const noteB = canonicalPath(join(root, '教学方案', '简介.md'));
    notebooks.splice(0, notebooks.length, { id: 'test-book', name: 'Test Book', path: canonicalPath(root) });
    await mkdir(dirname(noteB));
    await writeFile(noteB, 'B content', 'utf8');
    const sourceEditor = editor();
    sourceEditor.commands.insertContent({ type: 'noteReference', attrs: toNoteReferenceAttrs({
      notebookId: 'test-book', notebookName: 'Test Book', notebookPath: root,
      relativePath: '教学方案/简介.md', filename: '简介.md', title: '简介',
      originalPath: null, updatedAt: 0,
    }) });
    const original = sourceEditor.getMarkdown();
    await writeFile(noteA, original, 'utf8');
    const identity = { kind: 'md' as const, path: noteA, displayId: `cached-A-${root}` };
    applyLoadedDocumentContent(identity, noteA, original);

    // Only replace the native transport: reads, CAS writes and rename really
    // operate on temporary files. The application pipeline is left intact.
    invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'rename_file') {
        const target = join(dirname(args.filePath), args.name);
        await rename(args.filePath, target);
        return target;
      }
      if (command === 'get_dir_children') {
        return (await readdir(args.dirPath, { withFileTypes: true })).map(entry => ({
          name: entry.name, type: entry.isDirectory() ? 'folder' : 'document',
          fullPath: canonicalPath(join(args.dirPath, entry.name)),
        }));
      }
      if (command === 'read_external_document') return readFile(args.filePath, 'utf8');
      if (command === 'write_document') {
        if (await readFile(args.filePath, 'utf8') !== args.expectedContent) return null;
        await writeFile(args.filePath, args.content, 'utf8');
        return { path: args.filePath, content: args.content };
      }
      if (command === 'acknowledge_document_operation') return;
      throw new Error(`Unexpected native operation: ${command}`);
    });

    await localDocumentOperations.rename!({ path: noteB, name: '简介2.md', scopePath: root });
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem('flowix:pending-note-link-moves') ?? '[]')).toEqual([]);
    });
    const saved = await readFile(noteA, 'utf8');
    expect(saved).toContain('[简介2](flowix://open?b=Test+Book&f=%E6%95%99%E5%AD%A6%E6%96%B9%E6%A1%88%2F%E7%AE%80%E4%BB%8B2.md)');
    expect(getDocumentBuffer(identity)).toMatchObject({ content: saved, lastSavedContent: saved, saveState: 'clean' });
    const reopened = editor();
    reopened.commands.setContent(getDocumentBuffer(identity).content, { contentType: 'markdown' });
    expect(reopened.state.doc.firstChild?.firstChild?.attrs.relativePath).toBe('教学方案/简介2.md');
    expect(reopened.view.dom.querySelector('.editor-note-reference__title')?.textContent).toBe('简介2');

    // A persisted chain must reach the final filename in one pass.
    expect(await rewriteNoteLinkMoves([
      { oldPath: noteB, newPath: noteB.replace('简介.md', '简介2.md'), folder: false },
      { oldPath: noteB.replace('简介.md', '简介2.md'), newPath: noteB.replace('简介.md', '简介3.md'), folder: false },
    ])).toBe(true);
    expect(await readFile(noteA, 'utf8')).toContain('[简介3]');
  });

  it('protects an unmounted dirty tab instead of replacing its draft with disk content', () => {
    const identity = { kind: 'md' as const, path: '/retained-dirty-A.md', displayId: 'retained-dirty-A' };
    applyLoadedDocumentContent(identity, identity.path, 'original');
    recordDocumentEdit(identity, 'unsaved user text');
    expect(hasLiveUnsavedDocumentAtPath(identity.path)).toBe(true);
    expect(acceptBackgroundDocumentContent(identity.path, 'rewritten disk')).toBe(false);
    expect(getDocumentBuffer(identity).content).toBe('unsaved user text');
  });
});
