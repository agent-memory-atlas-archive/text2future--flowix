/** Open Markdown by notebook ID and relative path or by a physical file path. */

import { memos as memosClient } from '@platform/tauri/client';
import { useMemoStore } from '@features/memo/store/memo-store';
import { setCurrentWorkspaceNotebook } from '@features/memo/public/workspace-api';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { clearWorkspaceDocument, openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';

function hasHiddenNotebookDirectory(path: string, notebookPath: string): boolean {
  const absolutePath = canonicalPath(path);
  const root = canonicalDirectoryPath(notebookPath);
  const prefix = root === '/' ? '/' : `${root}/`;
  if (!absolutePath.startsWith(prefix)) return false;
  const relativeParts = absolutePath.slice(prefix.length).split('/').filter(Boolean);
  if (relativeParts.includes('.flowix')) return false;
  return relativeParts.slice(0, -1).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

function physicalPathFromTarget(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.toLowerCase().startsWith('flowix://open?')) {
    try {
      const path = new URL(trimmed).searchParams.get('path');
      if (path) return physicalPathFromTarget(path);
    } catch {
      return trimmed;
    }
  }
  if (!trimmed.toLowerCase().startsWith('file://')) return trimmed;
  try {
    const pathname = decodeURIComponent(new URL(trimmed).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return trimmed;
  }
}

function hiddenNotebookForPhysicalTarget(rawPath: string): { path: string; notebookPath: string } | null {
  const path = physicalPathFromTarget(rawPath);
  const notebook = useMemoStore.getState().notebooks.find((item) => (
    hasHiddenNotebookDirectory(path, item.path)
  ));
  return notebook ? { path, notebookPath: notebook.path } : null;
}

/** Resolve a path link through the notebook path index and open the document. */
export async function openNoteByDeepLink(url: string): Promise<void> {
  if (/^flowix:\/\/open\?/i.test(url.trim())) {
    const target = new URL(url.trim());
    const book = target.searchParams.get('b') ?? target.searchParams.get('book');
    const file = target.searchParams.get('f') ?? target.searchParams.get('file');
    if (book && file) {
      let notebooks = useMemoStore.getState().notebooks;
      if (!notebooks.some((item) => item.name === book)) {
        await useMemoStore.getState().loadNotebooks();
        notebooks = useMemoStore.getState().notebooks;
      }
      const matches = notebooks.filter((item) => item.name === book);
      if (matches.length !== 1) throw new Error(`Notebook link is unavailable or ambiguous: ${book}`);
      await openNoteByNotebookPath(matches[0].id, file);
      return;
    }
    const notebookId = target.searchParams.get('notebookId');
    const relativePath = target.searchParams.get('relativePath');
    if (notebookId && relativePath) {
      await openNoteByNotebookPath(notebookId, relativePath);
      return;
    }
    if (!target.searchParams.get('path')) throw new Error(`Invalid note link: ${url}`);
  }
  if (/^flowix:\/\/memo\//i.test(url.trim())) throw new Error(`Expired note link: ${url}`);
  const notebookLink = /^flowix:\/\/notebook\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  if (notebookLink) {
    if (!await openNotebookById(decodeURIComponent(notebookLink[1]))) {
      throw new Error(`Notebook is unavailable: ${notebookLink[1]}`);
    }
    return;
  }
  const physicalPath = physicalPathFromTarget(url);
  if (/\.(?:md|markdown)$/i.test(physicalPath)) {
    const location = await memosClient.resolveMarkdownLocation(physicalPath).catch(() => null);
    if (location?.indexable && location.notebookId && location.relativePath) {
      await openNoteByNotebookPath(location.notebookId, location.relativePath);
      return;
    }
  }
  const hiddenTarget = hiddenNotebookForPhysicalTarget(url);
  if (hiddenTarget) {
    await openExternalTarget(hiddenTarget.path, {
      destination: 'main-third',
      scopePath: hiddenTarget.notebookPath,
    });
    return;
  }

  if (/^flowix:\/\//i.test(url.trim()) && !/^flowix:\/\/open\?/i.test(url.trim())) {
    throw new Error(`Unable to resolve note target: ${url}`);
  }
  if (!/\.(?:md|markdown)$/i.test(physicalPath)) {
    throw new Error(`Unsupported note target: ${url}`);
  }
  await openExternalTarget(physicalPath, { scopePath: null, destination: 'main-third' });
}

export async function openNoteByNotebookPath(notebookId: string, relativePath: string): Promise<void> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid notebook-relative note path');
  }
  let notebook = useMemoStore.getState().notebooks.find((item) => item.id === notebookId);
  if (!notebook) {
    await useMemoStore.getState().loadNotebooks();
    notebook = useMemoStore.getState().notebooks.find((item) => item.id === notebookId);
  }
  if (!notebook) throw new Error(`Notebook is unavailable: ${notebookId}`);
  const path = joinNotebookMemoPath(notebook.path, normalized);
  if (!path) throw new Error('Invalid notebook-relative note path');
  await openExternalTarget(path, { scopePath: notebook.path, destination: 'main-third' });
}

/** Open a Markdown file by absolute path or file URL. */
export async function openNoteByPhysicalPath(rawPath: string): Promise<void> {
  await openNoteByDeepLink(rawPath);
}

/** Open a notebook by its explicit notebook link. */
export async function openNotebookById(notebookId: string): Promise<boolean> {
  const store = useMemoStore.getState();
  let notebook = store.notebooks.find((item) => item.id === notebookId);
  if (!notebook) {
    await store.loadNotebooks();
    notebook = useMemoStore.getState().notebooks.find((item) => item.id === notebookId);
  }
  if (!notebook) return false;
  await clearWorkspaceDocument();
  await setCurrentWorkspaceNotebook(notebook);
  useMemoStore.getState().setSelectedNotebook(notebook);
  await useMemoStore.getState().loadPathNotes({ notebookId: notebook.id });
  return true;
}
