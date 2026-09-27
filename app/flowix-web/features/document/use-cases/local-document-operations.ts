import { canonicalPath } from '@/lib/path';
import { externalDocuments } from '@platform/tauri/client';
import { files } from '@platform/tauri/client/desktop';

import type { EditableDocumentOperations } from './editable-document-operations';

/** Persistence boundary for Markdown and other editable local files. */
export const localDocumentOperations: EditableDocumentOperations = {
  read: ({ path, scopePath }) => externalDocuments.read(path, scopePath),
  write: async ({ path, content, expectedContent, scopePath }) => {
    const result = await externalDocuments.write({
      filePath: path,
      content,
      expectedContent,
      scopePath,
    });
    return result.status === 'saved'
      ? { status: 'saved', path: canonicalPath(result.path), content: result.content }
      : result;
  },
  rename: async ({ path, name, scopePath }) => {
    if (!scopePath) throw new Error('A file scope is required to rename this document');
    return { path: canonicalPath(await files.rename(path, name, scopePath)) };
  },
  delete: async ({ path, scopePath }) => {
    const deleted = await files.delete(path, scopePath ?? undefined);
    if (!deleted) throw new Error('delete_file returned false');
    return { path: canonicalPath(path) };
  },
};
