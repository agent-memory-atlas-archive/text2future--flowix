import { memos } from '@platform/tauri/client';
import type { DocumentPathRequest, DocumentWriteOutcome, DocumentWriteRequest, EditableDocumentOperations } from './editable-document-operations';

/** File editing through the indexed Memo backend. The ID is required only by
 * operations that must update the Memo index or follow a renamed file. */
export const memoDocumentOperations = {
  read: ({ path }: DocumentPathRequest) => memos.readDocument(path),
  write: async ({
    memoId,
    content,
    expectedContent,
  }: DocumentWriteRequest): Promise<DocumentWriteOutcome> => {
    if (!memoId) throw new Error('Memo ID is required to save an indexed document');
    const result = await memos.writeDocument({ key: memoId, content, expectedContent });
    return result
      ? { status: 'saved', ...result }
      : { status: 'refused' };
  },
  renameTitle: (request: { memoId: string; title: string; expectedFilename: string }) =>
    memos.renameMemoTitle({
      id: request.memoId,
      title: request.title,
      expectedFilename: request.expectedFilename,
    }),
} satisfies Pick<EditableDocumentOperations, 'read' | 'write'> & {
  renameTitle: (request: { memoId: string; title: string; expectedFilename: string }) => ReturnType<typeof memos.renameMemoTitle>;
};
