import { canonicalPath } from '@/lib/path';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { renameLocalDocumentFile } from '@features/document/public/file-operations-api';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { replaceExternalDocumentPath } from './workspace-navigation';

/** File-tree filename edits share the title editor's guarded rename pipeline. */
export function renameWorkspaceFile(request: {
  path: string;
  name: string;
  scopePath: string;
  notebookId?: string;
  collectionId?: string;
}) {
  const path = canonicalPath(request.path);
  const notebook = getWorkspaceMemoState().notebooks
    .filter(item => (!request.notebookId || item.id === request.notebookId)
      && path.startsWith(`${canonicalPath(item.path).replace(/\/+$/, '')}/`))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  if (request.notebookId && !notebook) {
    throw new Error('Rename source must belong to the supplied notebook');
  }
  const identity = ensureFileDisplayIdentity(path);
  return renameLocalDocumentFile({
    ...request,
    notebook,
    displayId: identity.displayId,
    onPathChanged: (previous, next) => replaceExternalDocumentPath(identity.displayId, previous, next),
  });
}
