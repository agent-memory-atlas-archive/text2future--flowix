import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { externalDocuments } from '@platform/tauri/client';

interface PendingRefresh {
  sessionKey: string;
  path: string;
}

export function useMediaLibraryRefresh({
  sessionKey,
  notebookPath,
  currentFilePath,
  saving,
  saveInFlightRef,
  acceptContent,
}: {
  sessionKey: string;
  notebookPath: string | null;
  currentFilePath: string;
  saving: boolean;
  saveInFlightRef: MutableRefObject<boolean>;
  acceptContent: (content: string) => boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const activeSessionKeyRef = useRef(sessionKey);
  const requestIdRef = useRef(0);
  const pendingRefreshRef = useRef<PendingRefresh | null>(null);
  activeSessionKeyRef.current = sessionKey;

  const refreshContent = useCallback((path: string, replacePending = true) => {
    const requestId = ++requestIdRef.current;
    if (saveInFlightRef.current) {
      if (replacePending || pendingRefreshRef.current?.sessionKey !== sessionKey) {
        pendingRefreshRef.current = { sessionKey, path };
      }
      return;
    }

    void externalDocuments.read(path, notebookPath).then((content) => {
      if (activeSessionKeyRef.current !== sessionKey || requestIdRef.current !== requestId) return;
      if (saveInFlightRef.current) {
        if (replacePending || pendingRefreshRef.current?.sessionKey !== sessionKey) {
          pendingRefreshRef.current = { sessionKey, path };
        }
        return;
      }
      if (!content) throw new Error('无法读取媒体库文件');
      if (!acceptContent(content)) throw new Error('媒体库身份或版本已变化');
      setError(null);
    }).catch((reason: unknown) => {
      if (activeSessionKeyRef.current !== sessionKey || requestIdRef.current !== requestId) return;
      console.warn('Media library refresh failed', reason);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [acceptContent, notebookPath, saveInFlightRef, sessionKey]);

  useEffect(() => {
    setError(null);
    requestIdRef.current += 1;
    if (pendingRefreshRef.current?.sessionKey !== sessionKey) pendingRefreshRef.current = null;
  }, [sessionKey]);
  useEffect(() => () => { requestIdRef.current += 1; }, []);

  useEffect(() => {
    if (saving) return;
    const pending = pendingRefreshRef.current;
    pendingRefreshRef.current = null;
    if (pending?.sessionKey === sessionKey) refreshContent(pending.path);
  }, [refreshContent, saving, sessionKey]);

  const retryRefresh = useCallback(() => refreshContent(currentFilePath), [currentFilePath, refreshContent]);
  return { error, refreshContent, retryRefresh };
}
