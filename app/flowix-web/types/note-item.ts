/** Color labels are persisted in Note frontmatter as lowercase strings. */
export type NoteColor = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'gray';

export const NOTE_COLORS: readonly NoteColor[] = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'gray',
] as const;

export interface AgentThreadItem {
  threadId: string;
  title: string;
  agentType: string;
}

/** Main-list projection from the rebuildable Note index, keyed by notebook path. */
export interface NoteListItem {
  kind: 'path-note';
  notebookId: string;
  relativePath: string;
  /** Ephemeral React identity retained across an in-session path rename. */
  renderKey?: string;
  filename: string;
  title: string;
  preview: string;
  thumbnail: string | null;
  tags: string[];
  todos: { content: string; status: string }[];
  agents: AgentThreadItem[];
  createdAt: number;
  updatedAt: number;
  favorited: boolean;
  icon: string | null;
  colors: NoteColor[];
  properties: Record<string, unknown>;
}

export function noteListItemKey(item: NoteListItem): string {
  return item.renderKey ?? `path:${item.notebookId}:${item.relativePath}`;
}

export function noteListItemRelativePath(item: NoteListItem): string {
  return item.relativePath;
}

export function noteListItemTitle(item: NoteListItem): string {
  return item.title;
}
