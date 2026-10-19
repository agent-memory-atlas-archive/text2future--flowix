'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Globe, RotateCw, X } from 'lucide-react';
import { canonicalUrl } from '@features/workspace/model/surface-identity';
import type { WorkspaceWebRuntime } from '@features/workspace/model/surface-contract';
import { createWorkspaceWebRuntime, navigateWorkspaceWebRuntime, moveWorkspaceWebHistory, reloadWorkspaceWebRuntime } from '@features/workspace/model/web-navigation';
import { openUrl } from '@platform/tauri/opener';
import { styleAccessibleIframeScrollbar } from '@shared/ui/iframe-scrollbar';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext, WorkspaceWebNavigationPort } from './workspace-surface-renderer-contract';

/** Work owns a view-local web session; Browser injects its tab runtime port. */
function useLocalWebNavigation(url: string) {
  const [runtime, setRuntime] = useState(() => createWorkspaceWebRuntime(url));
  const current = useRef(runtime);
  const port = useMemo<WorkspaceWebNavigationPort>(() => {
    const commit = (next: WorkspaceWebRuntime | null) => {
      if (!next) return;
      current.current = next;
      setRuntime(next);
    };
    return {
      getRuntime: () => current.current,
      setRuntime: commit,
      navigate: (address) => commit(navigateWorkspaceWebRuntime(current.current, address)),
      back: () => commit(moveWorkspaceWebHistory(current.current, -1)),
      forward: () => commit(moveWorkspaceWebHistory(current.current, 1)),
      reload: () => commit(reloadWorkspaceWebRuntime(current.current)),
      updateMetadata: () => {},
    };
  }, []);
  return { runtime, port };
}

function browserTitleForUrl(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function browserFaviconForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function WebRenderer({ surface, context }: {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: 'web' }>;
  context: WorkspaceSurfaceRenderContext;
}) {
  const local = useLocalWebNavigation(surface.url);
  const port = context.webNavigation ?? local.port;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedTimeoutRef = useRef<number | null>(null);
  const runtime = context.webNavigation ? surface.runtime ?? port.getRuntime() : local.runtime;
  const lastLoadedUrlRef = useRef(runtime && !runtime.isLoading ? runtime.currentUrl : null);
  const currentUrl = runtime?.currentUrl ?? surface.url;
  const reloadToken = runtime?.reloadToken ?? 0;
  const [address, setAddress] = useState(currentUrl);
  const [pageTitle, setPageTitle] = useState(() => browserTitleForUrl(currentUrl));
  const [addressError, setAddressError] = useState<string | null>(null);
  const [showEmbedTimeout, setShowEmbedTimeout] = useState(false);

  useEffect(() => {
    setAddress(currentUrl);
    setPageTitle(browserTitleForUrl(currentUrl));
  }, [currentUrl]);

  useEffect(() => {
    if (runtime) return;
    port.setRuntime({
      currentUrl: surface.url,
      history: [surface.url],
      historyIndex: 0,
      reloadToken: 0,
      isLoading: true,
      error: null,
    });
  }, [runtime, port, surface.url]);

  const reportRuntime = useCallback((patch: Partial<WorkspaceWebRuntime>) => {
    const current = port.getRuntime() ?? {
      currentUrl,
      history: [currentUrl],
      historyIndex: 0,
      reloadToken,
      isLoading: true,
      error: null,
    };
    port.setRuntime({ ...current, ...patch });
  }, [currentUrl, reloadToken, port]);

  useEffect(() => {
    setShowEmbedTimeout(false);
    embedTimeoutRef.current = window.setTimeout(() => {
      setShowEmbedTimeout(true);
      reportRuntime({ isLoading: false, error: '网页可能禁止嵌入或加载超时' });
    }, 6_000);
    return () => {
      if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
      embedTimeoutRef.current = null;
    };
  }, [currentUrl, reloadToken, reportRuntime]);

  const handleNavigate = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = canonicalUrl(address);
    if (!normalized) {
      setAddressError('请输入 http:// 或 https:// 地址');
      return;
    }
    setAddressError(null);
    setAddress(normalized);
    port.navigate(normalized);
    port.updateMetadata({
      icon: browserFaviconForUrl(normalized),
      title: browserTitleForUrl(normalized),
    });
  }, [address, port]);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    styleAccessibleIframeScrollbar(iframe);
    if (embedTimeoutRef.current !== null) window.clearTimeout(embedTimeoutRef.current);
    embedTimeoutRef.current = null;
    setShowEmbedTimeout(false);
    let loadedUrl = currentUrl;
    let pageTitle = '';
    try {
      const href = iframe?.contentWindow?.location.href;
      loadedUrl = canonicalUrl(href ?? '') ?? currentUrl;
      pageTitle = iframe?.contentDocument?.title?.trim() ?? '';
    } catch {
      // Cross-origin pages intentionally do not expose their URL/title to the
      // host document. Keep the address bar and tab title at their last known
      // values in that case.
    }
    lastLoadedUrlRef.current = loadedUrl;

    const runtimeNow = port.getRuntime();
    if (runtimeNow && loadedUrl !== runtimeNow.currentUrl) {
      const history = runtimeNow.history.slice(0, runtimeNow.historyIndex + 1);
      if (history[history.length - 1] !== loadedUrl) history.push(loadedUrl);
      reportRuntime({
        currentUrl: loadedUrl,
        history,
        historyIndex: history.length - 1,
        isLoading: false,
        error: null,
      });
    } else {
      reportRuntime({ isLoading: false, error: null });
    }
    port.updateMetadata({
      title: pageTitle || browserTitleForUrl(loadedUrl),
      icon: browserFaviconForUrl(loadedUrl),
    });
    setPageTitle(pageTitle || browserTitleForUrl(loadedUrl));
  }, [currentUrl, pageTitle, reportRuntime, port]);

  useEffect(() => {
    const error = runtime?.error;
    const isLoading = runtime?.isLoading ?? true;
    context.reportPresentation?.({
      title: pageTitle,
      icon: browserFaviconForUrl(currentUrl) ?? undefined,
      state: error
        ? {
            status: 'error',
            message: { key: 'error.unexpected', fallbackText: error },
            actions: [{ id: 'reload', label: { key: 'error.retry' }, enabled: true, run: port.reload }],
          }
        : isLoading
          ? {
              status: 'loading',
              loadingMode: lastLoadedUrlRef.current === currentUrl ? 'background' : 'blocking',
              retainContent: true,
            }
          : { status: 'ready' },
    });
  }, [context.reportPresentation, currentUrl, pageTitle, port.reload, runtime?.error, runtime?.isLoading]);

  const handleOpenInSystemBrowser = useCallback(() => {
    void openUrl(currentUrl).catch(() => {
      reportRuntime({ error: '无法在系统浏览器中打开' });
    });
  }, [currentUrl, reportRuntime]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)]">
      <form
        onSubmit={handleNavigate}
        className="flex shrink-0 items-center gap-1 border-b border-[var(--divider)] bg-[var(--bg-titlebar)] px-2 py-1.5"
      >
        <button
          type="button"
          aria-label="后退"
          title="后退"
          disabled={!runtime || runtime.historyIndex <= 0}
          onClick={() => port.back()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!runtime || runtime.historyIndex >= runtime.history.length - 1}
          onClick={() => port.forward()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="重新加载"
          title="重新加载"
          onClick={() => port.reload()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-[var(--border)] bg-[var(--background)] px-2">
          <Globe className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
          <input
            aria-label="网页地址"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(null);
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none"
            spellCheck={false}
          />
        </div>
        <button type="button" aria-label="在系统浏览器中打开" title="在系统浏览器中打开"
          onClick={handleOpenInSystemBrowser}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
        {runtime?.isLoading && (
          <span
            role="status"
            aria-label="加载中"
            className="mx-1 h-4 w-4 shrink-0 flowix-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]"
          />
        )}
        {runtime?.error && <span className="shrink-0 text-[10px] text-[var(--destructive)]">{runtime.error}</span>}
      </form>
      {addressError && <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--destructive)]">{addressError}</div>}
      <div className="relative min-h-0 min-w-0 flex-1 bg-white">
        <iframe
          key={`${context.viewId}:${currentUrl}:${reloadToken}`}
          ref={iframeRef}
          title={surface.title ?? browserTitleForUrl(currentUrl)}
          src={currentUrl}
          onLoad={handleIframeLoad}
          onError={() => {
            reportRuntime({ isLoading: false, error: '网页加载失败' });
            setShowEmbedTimeout(true);
          }}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
        />
        {showEmbedTimeout && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-6 backdrop-blur-sm">
            <div className="relative flex max-w-sm flex-col items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] px-8 py-7 text-center shadow-lg">
              <button
                type="button"
                aria-label="关闭提示"
                title="关闭提示"
                onClick={() => setShowEmbedTimeout(false)}
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="text-sm text-[var(--muted-foreground)]">网页可能禁止嵌入或加载超时</p>
              <button
                type="button"
                onClick={handleOpenInSystemBrowser}
                className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
              >
                在系统浏览器中打开
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
