import { act, Suspense, useEffect, type ComponentType } from 'react';
import type { SurfaceState } from '@features/workspace/model/surface-contract';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSurfaceRendererLazy, WorkspaceSurfaceErrorBoundary, WorkspaceSurfaceStateView } from './workspace-surface-state-view';

vi.mock('@shared/ui/centered-loading-spinner', () => ({
  CenteredLoadingSpinner: () => <div data-testid="surface-spinner" />,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const appearance = {
  headerStyle: 'document' as const,
  contentBackground: 'document' as const,
  stateBackground: 'document' as const,
  emptyDecoration: 'none' as const,
};
let host: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
});

describe('WorkspaceSurfaceStateView', () => {
  it('preserves renderer identity and its effects through loading, failure and retry', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    const mount = vi.fn();
    const dispose = vi.fn();
    function Content() {
      useEffect(() => { mount(); return dispose; }, []);
      return <input defaultValue="draft" />;
    }
    const render = async (state: SurfaceState) => {
      await act(async () => root.render(<WorkspaceSurfaceStateView appearance={appearance} state={state} keepContentMounted>
        <Content />
      </WorkspaceSurfaceStateView>));
    };
    await render({ status: 'ready' });
    const input = host.querySelector('input');
    await render({ status: 'loading', loadingMode: 'blocking', retainContent: false });
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).not.toBeNull();
    await render({ status: 'error', message: { key: 'error.unexpected' } });
    await render({ status: 'loading', loadingMode: 'blocking', retainContent: true });
    await render({ status: 'ready' });
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).toBeNull();
    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });
  it('keeps async content mounted beneath a retained loading state', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root.render(<WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'loading', loadingMode: 'blocking', retainContent: true }}>
      <div data-testid="async-content">mounted</div>
    </WorkspaceSurfaceStateView>));

    expect(host.querySelector('[data-testid="async-content"]')?.textContent).toBe('mounted');
    expect(host.querySelector('[data-testid="surface-spinner"]')).not.toBeNull();
  });

  it('retains interactive content with one transparent loader and delegates background or host loading', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    const render = async (state: SurfaceState, loadingOwner: 'surface' | 'host' = 'surface') => {
      await act(async () => root.render(<WorkspaceSurfaceStateView
        appearance={appearance} state={state} keepContentMounted loadingOwner={loadingOwner}>
        <input defaultValue="draft" />
      </WorkspaceSurfaceStateView>));
    };

    await render({ status: 'ready' });
    const input = host.querySelector('input');
    await render({ status: 'loading', loadingMode: 'blocking', retainContent: true });
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="surface-spinner"]')).toHaveLength(1);
    expect(host.querySelector('[class*="bg-"]')).toBeNull();
    expect(host.querySelector('[data-testid="surface-spinner"]')!.closest('.pointer-events-none')).not.toBeNull();

    await render({ status: 'loading', loadingMode: 'background', retainContent: true });
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).toBeNull();
    expect(host.querySelector('[data-testid="surface-spinner"]')).toBeNull();

    await render({ status: 'loading', loadingMode: 'blocking', retainContent: false }, 'host');
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).not.toBeNull();
    expect(host.querySelector('[data-testid="surface-spinner"]')).toBeNull();
  });

  it('shows domain error detail and its retry action in the shared state view', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    const retry = vi.fn();
    await act(async () => root.render(<WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'error', message: { key: 'error.unexpected', fallbackText: 'artifact missing' },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retry }] }} />));

    expect(host.textContent).toContain('artifact missing');
    await act(async () => host.querySelector('button')?.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('settles initial loading when Suspense wraps the lazy-renderer hook', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    let resolve!: (value: { default: ComponentType }) => void;
    const load = vi.fn(() => new Promise<{ default: ComponentType }>((done) => { resolve = done; }));
    function LazyRenderer() {
      const Renderer = useWorkspaceSurfaceRendererLazy(load);
      return <Renderer />;
    }
    await act(async () => root.render(<WorkspaceSurfaceErrorBoundary appearance={appearance}>
      <Suspense fallback={<div>loading</div>}><LazyRenderer /></Suspense>
    </WorkspaceSurfaceErrorBoundary>));
    expect(host.textContent).toBe('loading');
    await act(async () => resolve({ default: () => <div>content ready</div> }));
    expect(host.textContent).toBe('content ready');
    expect(load).toHaveBeenCalledOnce();
  });

  it('retries a rejected lazy renderer with a fresh React lazy wrapper', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    const load = vi.fn(async (): Promise<{ default: ComponentType }> => {
      if (load.mock.calls.length === 1) throw new Error('temporary chunk failure');
      return { default: () => <div>renderer recovered</div> };
    });
    function LazyRenderer() {
      const Renderer = useWorkspaceSurfaceRendererLazy(load);
      return <Suspense fallback={<div>loading</div>}><Renderer /></Suspense>;
    }
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => root.render(<WorkspaceSurfaceErrorBoundary appearance={appearance}>
      <LazyRenderer />
    </WorkspaceSurfaceErrorBoundary>));
    expect(host.textContent).toContain('error.unexpected');

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('renderer recovered');
    expect(load).toHaveBeenCalledTimes(2);
    logError.mockRestore();
  });
});
