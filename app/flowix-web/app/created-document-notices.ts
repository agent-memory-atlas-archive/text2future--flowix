import { create } from 'zustand';
import { canonicalPath } from '@/lib/path';
import { openCreatedDocumentFromNotice } from '@features/workspace/public/app-api';

export interface CreatedDocumentNotice {
  id: string;
  path: string;
  notebookPath: string;
  notebookId: string;
  busy: boolean;
  error: string | null;
}
export const useCreatedDocumentNotices = create<{ notices: CreatedDocumentNotice[] }>(() => ({ notices: [] }));
let sequence = 0;

export function notifyCreatedDocument(path: string, notebookPath: string, notebookId: string): void {
  const normalized = canonicalPath(path);
  useCreatedDocumentNotices.setState(({ notices }) => notices.some((item) => canonicalPath(item.path) === normalized)
    ? { notices }
    : { notices: [{ id: String(++sequence), path, notebookPath, notebookId, busy: false, error: null }, ...notices] });
}
export function clearCreatedDocumentNotices(): void {
  useCreatedDocumentNotices.setState({ notices: [] });
}
export function dismissCreatedDocumentNotice(id: string): void {
  useCreatedDocumentNotices.setState(({ notices }) => ({ notices: notices.filter((item) => item.id !== id) }));
}
export function removeCreatedDocumentNotices(path: string): void {
  const normalized = canonicalPath(path);
  useCreatedDocumentNotices.setState(({ notices }) => ({ notices: notices.filter((item) => {
    const current = canonicalPath(item.path);
    return current !== normalized && !current.startsWith(`${normalized}/`);
  }) }));
}
export function moveCreatedDocumentNotices(previous: string, next: string, directory: boolean): void {
  const before = canonicalPath(previous);
  useCreatedDocumentNotices.setState(({ notices }) => ({ notices: notices.map((item) => {
    const current = canonicalPath(item.path);
    return current === before || (directory && current.startsWith(`${before}/`))
      ? { ...item, path: canonicalPath(next) + current.slice(before.length), error: null }
      : item;
  }) }));
}
export async function openCreatedDocumentNotice(id: string): Promise<void> {
  const item = useCreatedDocumentNotices.getState().notices.find((notice) => notice.id === id);
  if (!item || item.busy) return;
  const patch = (updates: Partial<CreatedDocumentNotice>) => useCreatedDocumentNotices.setState(({ notices }) => ({
    notices: notices.map((notice) => notice.id === id ? { ...notice, ...updates } : notice),
  }));
  patch({ busy: true, error: null });
  try {
    const opened = await openCreatedDocumentFromNotice(item.path, item.notebookPath, item.notebookId);
    if (opened) dismissCreatedDocumentNotice(id);
    else patch({ busy: false });
  } catch (error) {
    patch({ busy: false, error: error instanceof Error ? error.message : String(error) });
  }
}
