import { describe, expect, it, vi } from 'vitest';
import type { Notebook } from '@features/memo/store/note-store';

const mocks = vi.hoisted(() => ({
  openExternalTarget: vi.fn(),
}));

vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({
  openExternalTarget: mocks.openExternalTarget,
}));

import { openNotebookNote } from './open-notebook-note';

const notebook = { id: 'book-1', path: '/notes' } as Notebook;

describe('openNotebookNote', () => {
  it('opens ordinary Markdown by path without requiring a memo ID', async () => {
    mocks.openExternalTarget.mockClear();
    await openNotebookNote('/notes/a.md', notebook);
    expect(mocks.openExternalTarget).toHaveBeenCalledWith('/notes/a.md', {
      scopePath: '/notes', destination: undefined, history: undefined, initialFocus: undefined,
    });
  });

  it('opens plugin Markdown through the path document surface', async () => {
    mocks.openExternalTarget.mockClear();
    await openNotebookNote('/notes/map.md', notebook);
    expect(mocks.openExternalTarget).toHaveBeenCalledWith('/notes/map.md', expect.objectContaining({ scopePath: '/notes' }));
  });
});
