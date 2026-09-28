import { memos } from '@platform/tauri/client';
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
  renameTitle: (request: { path: string; title: string; expectedFilename: string; expectedContent: string }) =>
    memos.renameMemoTitle({
      filePath: request.path,
      title: request.title,
      expectedFilename: request.expectedFilename,
      expectedContent: request.expectedContent,
    }),
} satisfies Pick<EditableDocumentOperations, 'read' | 'write'> & {
  renameTitle: (request: { path: string; title: string; expectedFilename: string; expectedContent: string }) => ReturnType<typeof memos.renameMemoTitle>;
};
