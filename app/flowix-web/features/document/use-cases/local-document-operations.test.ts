import { describe, expect, it, vi } from 'vitest';

const { rename, updateNoteLinksAfterMove } = vi.hoisted(() => ({
  rename: vi.fn(async () => 'C:/Notes/New.md'),
  updateNoteLinksAfterMove: vi.fn(),
}));

vi.mock('@platform/tauri/client', () => ({ externalDocuments: {} }));
vi.mock('@platform/tauri/client/desktop', () => ({ files: { rename } }));
vi.mock('@features/memo/services/note-link-rewriter', () => ({ updateNoteLinksAfterMove }));

import { localDocumentOperations } from './local-document-operations';

describe('local note rename', () => {
  it('schedules link updates after the editor title renames the file', async () => {
    const result = await localDocumentOperations.rename!({
      path: 'C:/Notes/Old.md',
      name: 'New.md',
      scopePath: 'C:/Notes',
    });
    expect(result.path).toBe('C:/Notes/New.md');
    expect(updateNoteLinksAfterMove).toHaveBeenCalledWith('C:/Notes/Old.md', 'C:/Notes/New.md');
  });
});
