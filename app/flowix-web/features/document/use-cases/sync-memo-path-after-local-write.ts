import { markSelfDocumentPathUpdate } from '@features/document/store/document-session-service';
import { replaceActiveMemoPath } from '@features/workspace/use-cases/workspace-navigation';

export function syncMemoPathAfterLocalWrite(memoId: string, path: string): void {
  markSelfDocumentPathUpdate(memoId, path);
  replaceActiveMemoPath(memoId, path);
}
