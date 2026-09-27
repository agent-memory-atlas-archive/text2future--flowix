import type { EditableDocumentOperations } from './editable-document-operations';
import { localDocumentOperations } from './local-document-operations';
import { memoDocumentOperations } from './memo-document-operations';

/** Select persistence by document kind; display identity remains file based. */
export function documentContentOperations(channel: 'internal' | 'external'): Pick<EditableDocumentOperations, 'read' | 'write'> {
  return channel === 'internal' ? memoDocumentOperations : localDocumentOperations;
}
