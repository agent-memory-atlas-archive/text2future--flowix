// MemoItem 类型 — 独立文件, 供 types/memo.ts (MemoEvent 镜像) 和
// store/memo-store.ts 共享, 避免循环引用。
//
// 跟后端 `flowix-core::memo_file::Memo` 镜像, 字段命名是 camelCase
// (后端走 `#[serde(rename_all = "camelCase")]` 跨 IPC 边界)。

export type MemoColor = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'gray';

/** Canonical order and membership for every Flowix document color picker. */
export const MEMO_COLORS: readonly MemoColor[] = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'gray',
] as const;

export interface AgentThreadItem {
  threadId: string;
  title: string;
  // Agent Type key, kept separate from agentRole* persona fields.
  agentType: string;
}

export interface MemoItem {
  id: string;
  filename: string;
  /** Path relative to the notebook root, using `/` separators. */
  relativePath?: string;
  preview: string;
  thumbnail?: string | null;
  tags: string[];
  todos: { content: string; status: string }[];
  agents: AgentThreadItem[];
  createdAt: number;
  updatedAt: number;
  favorited: boolean;
  icon: string | null;
  colors: MemoColor[];
  properties: Record<string, unknown>;
  isOpen?: boolean;
}

/** Main-list projection from the rebuildable V2 index. Its identity is the
 * notebook-relative path; it intentionally has no memo ID field. */
export interface PathNoteListItem {
  kind: 'path-note';
  notebookId: string;
  relativePath: string;
  filename: string;
  title: string;
  preview: string;
  thumbnail: string | null;
  tags: string[];
  todos: { id: string; content: string; status: string }[];
  agents: AgentThreadItem[];
  createdAt: number;
  updatedAt: number;
  favorited: boolean;
  icon: string | null;
  colors: MemoColor[];
  properties: Record<string, unknown>;
}

export type MemoListItem = MemoItem | PathNoteListItem;

export function isPathNoteListItem(item: MemoListItem): item is PathNoteListItem {
  return 'kind' in item && item.kind === 'path-note';
}

export function memoListItemKey(item: MemoListItem): string {
  return isPathNoteListItem(item)
    ? `path:${item.notebookId}:${item.relativePath}`
    : `memo:${item.id}`;
}

export function memoListItemRelativePath(item: MemoListItem): string {
  return item.relativePath?.trim() || item.filename;
}

export function memoListItemTitle(item: MemoListItem): string {
  return isPathNoteListItem(item) ? item.title : item.filename;
}
