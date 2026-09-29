import { joinNotebookMemoPath } from '@/lib/path';
import type { Notebook } from '@features/memo/store/memo-store';
import type { PathNoteListItem } from '@/types/memo-item';
import { createLogger } from '@/lib/logger';
import type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
import { openNotebookNote } from './open-notebook-note';

const logger = createLogger('memo-session');

/** Open a main-list note by its notebook-relative path, without resolving a
 * memo ID or creating an ID-backed workspace target. */
export async function openPathNoteSession(
  note: PathNoteListItem,
  notebook: Notebook | null,
): Promise<WorkspaceContentLocation | null> {
  if (!notebook?.path || notebook.id !== note.notebookId) return null;
  const fullPath = joinNotebookMemoPath(notebook.path, note.relativePath);
  if (!fullPath) return null;
  try {
    return await openNotebookNote(fullPath, notebook, {
      mayBePlugin: typeof note.properties.flowix_plugin === 'string',
    });
  } catch (error) {
    logger.error('open path note failed', { error, path: fullPath });
    return null;
  }
}
