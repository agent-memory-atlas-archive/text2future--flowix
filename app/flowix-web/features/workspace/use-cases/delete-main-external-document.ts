import { deleteExternalDocument, getWorkspaceDocumentState } from '@features/document/public/workspace-api';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { clearWorkspaceDocument } from './workspace-navigation';

export async function deleteMainExternalDocument(): Promise<'deleted' | 'unsaved' | 'missing'> {
  const session = getWorkspaceDocumentState().activeExternalSession;
  if (!session) return 'missing';
  if (!await deleteExternalDocument(session)) return 'unsaved';
  useBrowserColumnStore.getState().clearExternalPath(session.fileIdentity.path);
  if (getWorkspaceDocumentState().activeExternalSession?.fileIdentity.displayId === session.fileIdentity.displayId) {
    await clearWorkspaceDocument();
  }
  return 'deleted';
}
