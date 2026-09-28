import type { ExternalDocumentSession } from '../store/document-store';
import { documentIdentityFromFile, documentIdentityKey } from '../store/document-identity';
import { captureLatestDocumentContent, discardDocumentDraft, flushDocumentPath, hasDocumentUnsavedChanges } from '../store/document-session-service';
import { waitForSaveQueue } from '../store/save-queue';
import { expectExternalDocumentDelete } from '../store/external-document-operation';
import { localDocumentOperations } from './local-document-operations';

/** Delete only after every editor sharing this identity has persisted its draft. */
export async function deleteExternalDocument(session: ExternalDocumentSession): Promise<boolean> {
  const identity = documentIdentityFromFile(session.fileIdentity);
  captureLatestDocumentContent(identity);
  const flushed = await flushDocumentPath(identity, identity.path, session.scopePath);
  const settled = await waitForSaveQueue(documentIdentityKey(identity));
  if (!flushed || !settled || hasDocumentUnsavedChanges(identity)) return false;

  const cancelExpectedDelete = expectExternalDocumentDelete(identity.path);
  try {
    await localDocumentOperations.delete({ path: identity.path, scopePath: session.scopePath });
    discardDocumentDraft(identity);
    return true;
  } catch (error) {
    cancelExpectedDelete();
    throw error;
  }
}
