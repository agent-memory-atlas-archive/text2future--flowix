import { notes } from '@platform/tauri/client';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import type { DocumentPathRequest, DocumentWriteOutcome, DocumentWriteRequest, EditableDocumentOperations } from './editable-document-operations';

/** Resolve notebook-relative note addresses from file paths for Markdown CRUD. */
export const memoDocumentOperations = {
  read: ({ path }: DocumentPathRequest) => notes.readDocument(path),
  write: async ({
    path,
    content,
    expectedContent,
  }: DocumentWriteRequest): Promise<DocumentWriteOutcome> => {
    const result = await notes.writeDocument({ filePath: path, content, expectedContent });
    return result
      ? { status: 'saved', ...result }
      : { status: 'refused' };
  },
  renameTitle: async (request: { path: string; title: string; expectedFilename: string; expectedContent: string }) => {
    const result = await notes.renameTitle({
      filePath: request.path,
      title: request.title,
      expectedFilename: request.expectedFilename,
      expectedContent: request.expectedContent,
    });
    if (result.path !== request.path) updateNoteLinksAfterMove(request.path, result.path);
    return result;
  },
} satisfies Pick<EditableDocumentOperations, 'read' | 'write'> & {
  renameTitle: (request: { path: string; title: string; expectedFilename: string; expectedContent: string }) => ReturnType<typeof notes.renameTitle>;
};
