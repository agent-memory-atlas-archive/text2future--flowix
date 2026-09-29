import { memos } from '@platform/tauri/client';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import type { DocumentPathRequest, DocumentWriteOutcome, DocumentWriteRequest, EditableDocumentOperations } from './editable-document-operations';

/** Resolve notebook-relative note addresses from file paths for Markdown CRUD. */
export const memoDocumentOperations = {
  read: ({ path }: DocumentPathRequest) => memos.readDocument(path),
  write: async ({
    path,
    content,
    expectedContent,
  }: DocumentWriteRequest): Promise<DocumentWriteOutcome> => {
    const result = await memos.writeDocument({ filePath: path, content, expectedContent });
    return result
      ? { status: 'saved', ...result }
      : { status: 'refused' };
  },
  renameTitle: async (request: { path: string; title: string; expectedFilename: string; expectedContent: string }) => {
    const result = await memos.renameMemoTitle({
      filePath: request.path,
      title: request.title,
      expectedFilename: request.expectedFilename,
      expectedContent: request.expectedContent,
    });
    if (result.path !== request.path) updateNoteLinksAfterMove(request.path, result.path);
    return result;
  },
} satisfies Pick<EditableDocumentOperations, 'read' | 'write'> & {
  renameTitle: (request: { path: string; title: string; expectedFilename: string; expectedContent: string }) => ReturnType<typeof memos.renameMemoTitle>;
};
