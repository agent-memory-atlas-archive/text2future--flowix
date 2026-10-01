import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalTarget, store } = vi.hoisted(() => ({
  openExternalTarget: vi.fn(),
  store: {
    notebooks: [{ id: 'work-id', name: 'My Vault', path: 'C:/Notes' }],
    loadNotebooks: vi.fn(),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: { getState: () => store } }));
vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({
  clearWorkspaceDocument: vi.fn(),
  openExternalTarget,
}));
vi.mock('@features/memo/public/workspace-api', () => ({ setCurrentWorkspaceNotebook: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notes: {
  resolveLocation: vi.fn(),
  pathStatus: vi.fn().mockResolvedValue('present'),
} }));

import { openNoteByDeepLink } from './open-by-target';

describe('note deep links', () => {
  beforeEach(() => openExternalTarget.mockClear());

  it('opens a note by notebook name and relative file', async () => {
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md');
    expect(openExternalTarget).toHaveBeenCalledWith('C:/Notes/Projects/Plan.md', {
      scopePath: 'C:/Notes',
      destination: 'main-third',
    });
  });

  it('still opens existing book/file links', async () => {
    await openNoteByDeepLink('flowix://open?book=My+Vault&file=Projects%2FPlan.md');
    expect(openExternalTarget).toHaveBeenCalledWith('C:/Notes/Projects/Plan.md', {
      scopePath: 'C:/Notes',
      destination: 'main-third',
    });
  });

  it('rejects legacy memo ID links', async () => {
    await expect(openNoteByDeepLink('flowix://memo/abc12345')).rejects.toThrow('Expired note link');
    expect(openExternalTarget).not.toHaveBeenCalled();
  });
});
