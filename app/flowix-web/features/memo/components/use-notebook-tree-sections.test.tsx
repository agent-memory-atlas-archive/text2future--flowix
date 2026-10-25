import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useNotebookTreeSections, type NotebookTreeSection } from './use-notebook-tree-sections';

const system = vi.hoisted(() => ({
  getNotebookFileTreePreferences: vi.fn(),
  setNotebookFileTreeSectionOrder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@platform/tauri/client', () => ({ system }));

it('syncs preferences for the same notebook and ignores stale reads after an edit', async () => {
  const order: NotebookTreeSection[] = ['agents', 'pinned', 'views', 'files', 'repositories'];
  let resolveRead!: (preferences: { sectionOrder: NotebookTreeSection[]; hiddenSections: NotebookTreeSection[] }) => void;
  const staleRead = new Promise<{ sectionOrder: NotebookTreeSection[]; hiddenSections: NotebookTreeSection[] }>((resolve) => { resolveRead = resolve; });
  system.getNotebookFileTreePreferences.mockImplementation((id: string) => id === 'first'
    ? staleRead
    : Promise.resolve({ sectionOrder: order, hiddenSections: [] }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let update!: (order: NotebookTreeSection[], hidden: NotebookTreeSection[]) => void;
  function Observer({ id, name }: { id: string; name: string }) {
    const preferences = useNotebookTreeSections(id, true);
    if (name === 'guide') update = preferences.updateSections;
    return <output data-observer={name}>{JSON.stringify([preferences.sectionOrder, preferences.hiddenSections])}</output>;
  }
  try {
    await act(async () => root.render(<>
      <Observer id="first" name="guide" />
      <Observer id="first" name="tree" />
      <Observer id="other" name="other" />
    </>));
    const nextOrder = [...order].reverse();
    await act(async () => update(nextOrder, ['files']));
    await act(async () => resolveRead({ sectionOrder: order, hiddenSections: [] }));
    const expected = JSON.stringify([nextOrder, ['files']]);
    expect(host.querySelector('[data-observer="guide"]')?.textContent).toBe(expected);
    expect(host.querySelector('[data-observer="tree"]')?.textContent).toBe(expected);
    expect(host.querySelector('[data-observer="other"]')?.textContent).toBe(JSON.stringify([order, []]));
    expect(system.setNotebookFileTreeSectionOrder).toHaveBeenCalledWith('first', nextOrder, ['files']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
