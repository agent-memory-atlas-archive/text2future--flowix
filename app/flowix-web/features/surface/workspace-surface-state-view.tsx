'use client';

import { Component, createContext, Fragment, lazy, useContext, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactNode } from 'react';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/locales';
import type { SurfaceAppearance, SurfaceMessage, SurfacePresentationUpdate, SurfaceState } from '@features/workspace/public/surface-api';

const WorkspaceSurfaceRendererRetryContext = createContext<object>({});
const rendererCache = new WeakMap<object, WeakMap<object, unknown>>();

/** Recreate a lazy component when the shared renderer boundary retries. */
export function useWorkspaceSurfaceRendererLazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  const retryScope = useContext(WorkspaceSurfaceRendererRetryContext);
  // Initial suspension discards hook state, including useMemo. Cache outside
  // the suspending component so retries reuse the same resolved lazy wrapper.
  let scopes = rendererCache.get(load);
  if (!scopes) {
    scopes = new WeakMap();
    rendererCache.set(load, scopes);
  }
  let renderer = scopes.get(retryScope) as LazyExoticComponent<ComponentType<P>> | undefined;
  if (!renderer) {
    renderer = lazy(load);
    scopes.set(retryScope, renderer);
  }
  return renderer;
}

function messageText(message: SurfaceMessage, t: (key: I18nKey, params?: Record<string, string | number>) => string): string {
  const translated = t(message.key as I18nKey, message.params);
  return message.fallbackText ? `${translated}: ${message.fallbackText}` : translated;
}

function backgroundClass(appearance: SurfaceAppearance): string {
  return appearance.stateBackground === 'document'
    ? 'bg-[var(--document-bg)]'
    : 'bg-[var(--agent-bg,var(--document-bg))]';
}

export function WorkspaceSurfaceStateView({
  state,
  appearance,
  children,
  messageOverride,
  keepContentMounted = false,
  loadingOwner = 'surface',
}: {
  state: SurfaceState;
  appearance: Readonly<SurfaceAppearance>;
  children?: ReactNode;
  /** Adapter for callers that still hold an already-translated legacy message. */
  messageOverride?: string;
  /** Renderer-owned async state must not unmount the renderer publishing it. */
  keepContentMounted?: boolean;
  /** The parent host can provide one loading layer for the entire surface. */
  loadingOwner?: 'surface' | 'host';
}) {
  const { t } = useI18n();
  const message = 'message' in state && state.message
    ? messageOverride ?? messageText(state.message, t)
    : null;
  const detailText = state.status === 'error' ? state.detailText : undefined;

  if (keepContentMounted) {
    const contentVisible = state.status === 'ready' || state.status === 'loading'
      && state.retainContent;
    return <div className="relative flex h-full min-h-0 w-full flex-col">
      {state.status === 'ready' && <WorkspaceSurfaceStateView key="notices" state={state} appearance={appearance} />}
      {/* Keep a bounded flex viewport through this slot; renderers own scrolling. */}
      <div key="content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ visibility: contentVisible ? undefined : 'hidden' }}
        aria-hidden={contentVisible ? undefined : true} inert={!contentVisible}>
        {children}
      </div>
      {state.status !== 'ready' && !(state.status === 'loading'
        && (state.loadingMode === 'background' || loadingOwner === 'host')) && <div key="state"
        className={`absolute inset-0 z-10 ${state.status === 'loading' ? 'pointer-events-none' : ''}`}>
        <WorkspaceSurfaceStateView state={state} appearance={appearance} messageOverride={messageOverride} loadingOwner={loadingOwner} />
      </div>}
    </div>;
  }

  if (state.status === 'ready') {
    return <>
      {state.notices?.map((notice) => (
        <div key={notice.id} role={notice.severity === 'error' ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 border-b px-3 py-2 text-xs ${backgroundClass(appearance)}`}>
          <span>{messageText(notice.message, t)}</span>
          {notice.actions?.length ? <div className="flex shrink-0 gap-2">
            {notice.actions.map((action) => <button key={action.id} type="button" disabled={!action.enabled}
              onClick={() => { void action.run(); }}
              className="rounded-lg border border-[var(--border)] px-2 py-1 transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50">
              {messageText(action.label, t)}
            </button>)}
          </div> : null}
        </div>
      ))}
      {children}
    </>;
  }

  if (state.status === 'loading') {
    if (state.loadingMode === 'background') return <>{children}</>;
    if (loadingOwner === 'host') return null;
    if (state.retainContent && children) {
      return <div className="relative h-full min-h-0 w-full">
        <div className="h-full min-h-0 w-full">{children}</div>
        <div className="pointer-events-none absolute inset-0 z-10 flex min-h-0 flex-col">
          <CenteredLoadingSpinner className="min-h-0 flex-1" />
        </div>
      </div>;
    }
    return <div className="pointer-events-none flex h-full min-h-0 w-full flex-col">
      <CenteredLoadingSpinner className="min-h-0 flex-1" />
    </div>;
  }

  if (state.status === 'empty' && appearance.emptyDecoration === 'document-artwork') {
    return <WorkspaceEmptyState
      tone={appearance.stateBackground === 'agent' ? 'agent' : 'document'}
      message={message}
    />;
  }

  return <div className={`flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-6 text-center ${backgroundClass(appearance)}`}
    role={state.status === 'error' || state.status === 'unavailable' ? 'alert' : 'status'}>
    <p className={detailText ? 'text-sm font-medium text-[var(--foreground)]' : 'text-sm text-[var(--muted-foreground)]'}>{message}</p>
    {detailText ? <p className="max-w-full break-all text-xs text-[var(--muted-foreground)]">{detailText}</p> : null}
    {'actions' in state && state.actions?.length ? <div className="flex flex-wrap justify-center gap-2">
      {state.actions.map((action) => <button key={action.id} type="button" disabled={!action.enabled}
        onClick={() => { void action.run(); }}
        className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50">
        {messageText(action.label, t)}
      </button>)}
    </div> : null}
  </div>;
}

interface WorkspaceSurfaceErrorBoundaryProps {
  appearance: Readonly<SurfaceAppearance>;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  onRendererError?: () => void;
  children: ReactNode;
}

interface WorkspaceSurfaceErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

/** Gives every registry renderer the same error state and retry behavior. */
export class WorkspaceSurfaceErrorBoundary extends Component<
  WorkspaceSurfaceErrorBoundaryProps,
  WorkspaceSurfaceErrorBoundaryState
> {
  constructor(props: WorkspaceSurfaceErrorBoundaryProps) {
    super(props);
    this.state = { error: null, retryKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<WorkspaceSurfaceErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[WorkspaceSurface] Renderer failed:', error, info);
    this.props.reportPresentation?.({ state: {
      status: 'error',
      message: { key: 'error.unexpected' },
      actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: this.retry }],
    } });
    this.props.onRendererError?.();
  }

  private retry = () => {
    this.props.reportPresentation?.({ state: {
      status: 'loading', loadingMode: 'blocking', retainContent: false,
    } });
    this.setState(({ retryKey }) => ({ error: null, retryKey: retryKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return <WorkspaceSurfaceStateView
        appearance={this.props.appearance}
        state={{
          status: 'error',
          message: { key: 'error.unexpected' },
          actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: this.retry }],
        }}
      />;
    }

    return <WorkspaceSurfaceRendererRetryContext.Provider value={this.state}>
      <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>
    </WorkspaceSurfaceRendererRetryContext.Provider>;
  }
}
