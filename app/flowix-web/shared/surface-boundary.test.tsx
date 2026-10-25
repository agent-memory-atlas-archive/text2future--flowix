import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfaceBoundary } from './surface-boundary';

let container: HTMLDivElement;
let root: Root;
const state = { shouldThrow: true };

function Flaky({ label }: { label: string }) {
  if (state.shouldThrow) throw new Error('boom');
  return <div data-ok>{label}</div>;
}

async function render(ui: React.ReactNode) {
  await act(async () => root.render(ui));
}

beforeEach(() => {
  state.shouldThrow = true;
  // React 会把 render 错误再打一遍到 console.error，测试里静音。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('SurfaceBoundary', () => {
  it('renders the panel fallback instead of unmounting the whole tree', async () => {
    await render(
      <div>
        <div data-sibling>still here</div>
        <SurfaceBoundary name="test-panel" language="zh-CN">
          <Flaky label="content" />
        </SurfaceBoundary>
      </div>,
    );

    expect(container.querySelector('[data-sibling]')).not.toBeNull();
    expect(container.textContent).toContain('这个面板出错了');
    expect(container.querySelector('[data-ok]')).toBeNull();
  });

  it('recovers through retry after the failure cause is gone', async () => {
    await render(
      <SurfaceBoundary name="test-panel" language="zh-CN">
        <Flaky label="recovered" />
      </SurfaceBoundary>,
    );

    state.shouldThrow = false;
    const retry = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('重新加载面板'));
    expect(retry).toBeDefined();

    await act(async () => retry!.click());

    expect(container.querySelector('[data-ok]')?.textContent).toBe('recovered');
    expect(container.textContent).not.toContain('这个面板出错了');
  });

  it('auto-recovers when resetKeys change', async () => {
    const view = (target: string) => (
      <SurfaceBoundary name="test-panel" language="zh-CN" resetKeys={[target]}>
        <Flaky label={target} />
      </SurfaceBoundary>
    );

    await render(view('note-a'));
    expect(container.textContent).toContain('这个面板出错了');

    state.shouldThrow = false;
    await render(view('note-b'));

    expect(container.querySelector('[data-ok]')?.textContent).toBe('note-b');
  });

  it('stays in the error state while resetKeys are unchanged', async () => {
    const view = () => (
      <SurfaceBoundary name="test-panel" language="zh-CN" resetKeys={['note-a']}>
        <Flaky label="content" />
      </SurfaceBoundary>
    );

    await render(view());
    state.shouldThrow = false;
    await render(view());

    expect(container.textContent).toContain('这个面板出错了');
  });
});
