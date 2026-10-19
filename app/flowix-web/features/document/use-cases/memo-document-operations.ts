import { notes } from '@platform/tauri/client';
import type { DocumentPathRequest, DocumentWriteOutcome, DocumentWriteRequest } from './editable-document-operations';

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
};
