import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { externalDocuments, files } from '@platform/tauri/client';

export const HTML_PREVIEW_TIMEOUT_MS = 10_000;
export type HtmlPreviewPhase = 'reading' | 'loading' | 'ready' | 'timeout' | 'error';

/** One hook instance belongs to one keyed file/open attempt. Native asset URLs
 * preserve relative resources; the scoped read authorizes and validates the entry.
 */
export function useLocalHtmlPreview(filePath: string, scopePath: string | null) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<HtmlPreviewPhase>('reading');
  const active = useRef(false);
  const terminal = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = useCallback(() => clearTimeout(timer.current), []);
  const ready = useCallback(() => {
    if (!active.current || terminal.current) return;
    clearTimer();
    setPhase('ready');
  }, [clearTimer]);
  const fail = useCallback(() => {
    if (!active.current) return;
    terminal.current = true;
    clearTimer();
    setPhase('error');
  }, [clearTimer]);

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    terminal.current = false;
    timer.current = setTimeout(() => {
      // A late read cannot mount a frame after its authorization attempt expired.
      terminal.current = true;
      setPhase('timeout');
    }, HTML_PREVIEW_TIMEOUT_MS);
    void externalDocuments.read(filePath, scopePath).then((text) => {
      if (cancelled || terminal.current) return;
      clearTimer();
      setContent(text);
      setSrc(files.toAssetUrl(filePath));
      setPhase('loading');
      timer.current = setTimeout(() => setPhase('timeout'), HTML_PREVIEW_TIMEOUT_MS);
    }).catch(() => { if (!cancelled && !terminal.current) fail(); });
    return () => {
      cancelled = true;
      active.current = false;
      clearTimer();
    };
  }, [clearTimer, fail, filePath, scopePath]);

  const probe = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'flowix:local-html-document-probe' }, '*');
  }, []);

  useLayoutEffect(() => {
    if (!src) return;
    const onMessage = (event: MessageEvent) => {
      // Sandboxed documents have opaque origins. Match the actual frame window
      // and entry URL; readiness conveys no native privileges.
      if (event.source !== iframeRef.current?.contentWindow
        || event.data?.type !== 'flowix:local-html-document-ready'
        || event.data?.url !== src) return;
      ready();
    };
    const iframe = iframeRef.current;
    iframe?.addEventListener('error', fail);
    window.addEventListener('message', onMessage);
    probe();
    return () => {
      iframe?.removeEventListener('error', fail);
      window.removeEventListener('message', onMessage);
    };
  }, [fail, probe, ready, src]);

  return { iframeRef, src, content, phase, onLoad: probe };
}
