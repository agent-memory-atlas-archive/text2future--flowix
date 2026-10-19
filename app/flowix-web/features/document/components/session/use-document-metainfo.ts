import { useEffect, useRef } from 'react';
import { getBuffer, subscribeDocumentBufferChanges } from '../../store/buffer-registry';
import type { DocumentBuffer } from '../../store/document-buffer';
import type { DocumentIdentity } from '../../store/document-identity';
import { documentIdentityKey } from '../../store/document-identity';
import { useDocumentMetricsStore } from '../../store/document-metrics-store';
import type { DocumentContainerProps, DocumentContainerState } from './types';
import { countTextUnits, extractBodyContent } from './document-utils';

type Metrics = { charCount: number; tokenCount: number };
const metricsCache = new WeakMap<DocumentBuffer, Metrics & { content: string }>();
function textMetrics(buffer: DocumentBuffer): Metrics {
  const cached = metricsCache.get(buffer);
  if (cached?.content === buffer.content) return cached;
  const charCount = countTextUnits(extractBodyContent(buffer.content));
  const result = { content: buffer.content, charCount, tokenCount: Math.ceil(charCount / 4) };
  metricsCache.set(buffer, result);
  return result;
}

type Metadata = Pick<DocumentContainerState, 'createdAt' | 'updatedAt' | 'isFavorited' | 'frontmatterMeta'>;
interface Options {
  identity: DocumentIdentity;
  loaded: boolean;
  active: boolean;
  metadata: Metadata;
  onMetainfoData?: DocumentContainerProps['onMetainfoData'];
}

/** Publish text immediately for commands; compute presentation-only counts once
 * after a short pause (at most one second during continuous source editing).
 * No React container state participates in either path.
 */
export function useDocumentMetainfo({ identity, loaded, active, metadata, onMetainfoData }: Options) {
  const callback = useRef(onMetainfoData); callback.current = onMetainfoData;
  useEffect(() => {
    const key = documentIdentityKey(identity);
    if (!loaded) {
      if (active) useDocumentMetricsStore.getState().clear(key);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstAt: number | undefined;
    let metrics: Metrics = { charCount: 0, tokenCount: 0 };
    let last: { content: string; charCount: number; tokenCount: number } | undefined;
    const publish = () => {
      const buffer = getBuffer(identity);
      if (!buffer) return;
      if (active) useDocumentMetricsStore.getState().setCharCount(key, metrics.charCount);
      if (last?.content === buffer.content && last.charCount === metrics.charCount && last.tokenCount === metrics.tokenCount) return;
      last = { content: buffer.content, ...metrics };
      callback.current?.({ ...metadata, ...metrics, memoPath: null, memoContent: buffer.content });
    };
    const measure = () => {
      clearTimeout(timer); timer = undefined; firstAt = undefined;
      const buffer = getBuffer(identity);
      if (!buffer) return;
      metrics = textMetrics(buffer);
      publish();
    };
    measure();
    const unsubscribe = subscribeDocumentBufferChanges((document, reason) => {
      if (document.displayId !== identity.displayId) return;
      if (reason === 'loaded' || reason === 'merged') { measure(); return; }
      const buffer = getBuffer(identity);
      if (!buffer || last?.content === buffer.content) return;
      publish();
      firstAt ??= Date.now();
      clearTimeout(timer);
      timer = setTimeout(measure, Math.max(0, Math.min(200, 1000 - (Date.now() - firstAt))));
    });
    return () => {
      unsubscribe(); clearTimeout(timer);
      if (active) useDocumentMetricsStore.getState().clear(key);
    };
  }, [identity, loaded, active, metadata]);
}
