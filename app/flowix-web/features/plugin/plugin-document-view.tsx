'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CornersInIcon,
  CornersOutIcon,
  ArrowClockwiseIcon,
} from '@phosphor-icons/react';
import { artifacts, type ArtifactSession } from '@platform/tauri/client';
import { useDocumentStore } from '@features/document/store/document-store';
import { PluginArtifactRenderer, type PluginArtifactRendererHandle } from './plugin-artifact-renderer';
import { PluginMarkmapControls } from './plugin-markmap-controls';
import type { SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

export function PluginDocumentView({
  notePath,
  transitionId,
  reportPresentation,
}: {
  notePath: string;
  transitionId?: number;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}) {
  const [artifact, setArtifact] = useState<ArtifactSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PluginArtifactRendererHandle>(null);
  const requestSequenceRef = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const currentNotePathRef = useRef(notePath);
  currentNotePathRef.current = notePath;
  const retryPresentation = useCallback(() => {
    void loadRef.current();
  }, []);

  const load = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    const isCurrentRequest = () => requestSequence === requestSequenceRef.current
      && currentNotePathRef.current === notePath;
    setError(null);
    reportPresentation?.({
      state: { status: 'loading', loadingMode: 'blocking', retainContent: true },
    });
    try {
      const resolved = await artifacts.resolve(notePath);
      if (!isCurrentRequest()) return;
      setArtifact(resolved);
      reportPresentation?.({
        title: resolved.name,
        state: resolved.content?.length
          ? { status: 'ready' }
          : {
              status: 'unavailable', reason: 'unsupported',
              message: { key: 'error.unexpected', fallbackText: resolved.error ?? '插件产物内容不可读' },
              actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryPresentation }],
            },
      });
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setArtifact(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      reportPresentation?.({
        state: {
          status: 'error',
          message: { key: 'error.unexpected', fallbackText: loadError instanceof Error ? loadError.message : String(loadError) },
          actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryPresentation }],
        },
      });
    } finally {
      // Plugin pointer notes bypass DocumentContainer, which normally owns
      // the document transition completion callback. Complete the same
      // transition after the pointer/artifact has been resolved, otherwise
      // MainLayout's document loading overlay remains visible forever.
      if (isCurrentRequest() && transitionId !== undefined) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
    }
  }, [notePath, reportPresentation, retryPresentation, transitionId]);
  loadRef.current = load;

  useEffect(() => {
    void load();
    return () => { requestSequenceRef.current += 1; };
  }, [load]);
  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!canvasRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await canvasRef.current.requestFullscreen();
  };

  if (error) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm text-[var(--muted-foreground)]">
      <p>插件产物无法加载：{error}</p>
      <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2" onClick={() => void load()}><ArrowClockwiseIcon size={16} weight="bold" />重试</button>
    </div>;
  }
  if (!artifact) return reportPresentation ? null : <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在加载插件产物…</div>;

  const canRenderContent = artifact.content != null && artifact.content.length > 0;
  if (!canRenderContent) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm text-[var(--muted-foreground)]">
      <p className="font-medium text-[var(--foreground)]">{artifact.name}</p>
      <p>产物内容当前不可读，但指针和元数据仍已保留。</p>
      {artifact.error && <p className="max-w-xl text-center text-xs">{artifact.error}</p>}
      <p className="max-w-xl break-all text-center text-xs opacity-75">{artifact.path}</p>
      <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2" onClick={() => void load()}><ArrowClockwiseIcon size={16} weight="bold" />重试</button>
    </div>;
  }

  // A hash mismatch means the specialized renderer cannot be trusted to
  // interpret the content. Keep the bytes visible through the host's plain
  // text renderer while retaining the diagnostic banner below.
  const renderer = artifact.status === 'invalid' ? 'text' : artifact.renderer;

  return <div ref={canvasRef} className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--document-bg)] [&:fullscreen]:h-screen">
    {artifact.status !== 'ready' && artifact.error && (
      <div className="pointer-events-none absolute left-4 top-4 z-20 max-w-[min(520px,calc(100%-2rem))] rounded-lg border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
        {artifact.error}
      </div>
    )}
    {renderer === 'markmap' ? (
      <PluginMarkmapControls
        fullscreen={fullscreen}
        onFit={() => rendererRef.current?.fit?.()}
        onZoomIn={() => rendererRef.current?.zoomIn?.()}
        onZoomOut={() => rendererRef.current?.zoomOut?.()}
        onToggleFullscreen={() => { void toggleFullscreen(); }}
      />
    ) : (
      <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-1 rounded-xl border border-[var(--divider)] bg-[var(--card)]/90 p-1 shadow-lg backdrop-blur">
        <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={() => void toggleFullscreen()} title={fullscreen ? '退出全屏' : '全屏'} aria-label={fullscreen ? '退出全屏' : '全屏'}>{fullscreen ? <CornersInIcon size={16} weight="bold" /> : <CornersOutIcon size={16} weight="bold" />}</button>
      </div>
    )}
    <div className="min-h-0 flex-1 overflow-hidden"><PluginArtifactRenderer rendererRef={rendererRef} renderer={renderer} content={artifact.content ?? ''} /></div>
  </div>;
}
