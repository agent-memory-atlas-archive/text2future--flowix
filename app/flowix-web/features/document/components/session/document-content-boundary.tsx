import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { getBuffer, subscribeDocumentBufferChanges } from '../../store/buffer-registry';
import type { DocumentIdentity } from '../../store/document-identity';

/** The session owns text; only the editor boundary subscribes to live content. */
export function DocumentContentBoundary({ identity, children }: {
  identity: DocumentIdentity;
  children: (content: string) => ReactNode;
}) {
  const subscribe = useCallback((changed: () => void) => subscribeDocumentBufferChanges((document, reason) => {
    if (document.displayId !== identity.displayId) return;
    // A merged save must reach the editor before the next synchronous capture.
    if (reason === 'merged') flushSync(changed);
    else changed();
  }), [identity]);
  const snapshot = useCallback(() => getBuffer(identity)?.content ?? '', [identity]);
  const content = useSyncExternalStore(subscribe, snapshot, snapshot);
  return children(content);
}
