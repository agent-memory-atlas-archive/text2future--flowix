import { replaceActiveMemoPath } from '@features/workspace/use-cases/workspace-navigation';

export function syncMemoPathAfterLocalWrite(memoId: string, path: string): void {
  replaceActiveMemoPath(memoId, path);
}
