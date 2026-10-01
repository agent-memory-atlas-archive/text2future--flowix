import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDirChildren, readDocument, writeDocument } = vi.hoisted(() => ({
  getDirChildren: vi.fn(),
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
}));
const { hasLiveUnsavedDocumentAtPath, acceptBackgroundDocumentContent, notebooks } = vi.hoisted(() => ({
  hasLiveUnsavedDocumentAtPath: vi.fn(() => false),
  acceptBackgroundDocumentContent: vi.fn(() => true),
  notebooks: [{ id: 'work', name: 'Work', path: 'C:/Notes' }],
}));

vi.mock('@platform/tauri/client/desktop', () => ({ files: { getDirChildren } }));
vi.mock('@platform/tauri/client', () => ({ externalDocuments: { read: readDocument }, notes: { writeDocument } }));
vi.mock('@features/document/public/workspace-api', () => ({ hasLiveUnsavedDocumentAtPath, acceptBackgroundDocumentContent }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => ({
    notebooksInitialized: true,
    notebooks,
  }) },
}));

import { rewriteLinksInNotebooks } from './note-link-rewriter';

describe('background link update', () => {
  beforeEach(() => {
    getDirChildren.mockReset();
    readDocument.mockReset();
    writeDocument.mockReset();
    hasLiveUnsavedDocumentAtPath.mockReset();
    hasLiveUnsavedDocumentAtPath.mockReturnValue(false);
    acceptBackgroundDocumentContent.mockClear();
    notebooks.splice(0, notebooks.length, { id: 'work', name: 'Work', path: 'C:/Notes' });
  });
  it('rewrites a reference in a nested Markdown file without using the note index', async () => {
    getDirChildren.mockImplementation(async (path: string) => path === 'C:/Notes'
      ? [{ type: 'folder', fullPath: 'C:/Notes/Projects', name: 'Projects' }]
      : [{ type: 'document', fullPath: 'C:/Notes/Projects/Index.md', name: 'Index.md' }]);
    const content = '[Old](flowix://open?book=Work&file=Old.md)';
    readDocument.mockResolvedValue(content);
    const updated = '[New](flowix://open?b=Work&f=New.md)';
    writeDocument.mockResolvedValue({ path: 'C:/Notes/Projects/Index.md', content: updated });

    await rewriteLinksInNotebooks('C:/Notes/Old.md', 'C:/Notes/New.md');

    expect(writeDocument).toHaveBeenCalledWith({
      filePath: 'C:/Notes/Projects/Index.md',
      content: '[New](flowix://open?b=Work&f=New.md)',
      expectedContent: content,
    });
    expect(acceptBackgroundDocumentContent).toHaveBeenCalledWith('C:/Notes/Projects/Index.md', updated);
    expect(readDocument).toHaveBeenCalledWith('C:/Notes/Projects/Index.md', 'C:/Notes');
  });

  it('defers a dirty open note for a later pass', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    hasLiveUnsavedDocumentAtPath.mockReturnValueOnce(true);
    readDocument.mockClear();
    writeDocument.mockClear();
    expect(await rewriteLinksInNotebooks('C:/Notes/Old.md', 'C:/Notes/New.md')).toBe(false);
    expect(readDocument).not.toHaveBeenCalled();
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it('keeps a failed compare-and-swap pending after retrying fresh content', async () => {
    getDirChildren.mockResolvedValue([{ type: 'document', fullPath: 'C:/Notes/Index.md', name: 'Index.md' }]);
    readDocument.mockResolvedValue('[Old](flowix://open?b=Work&f=Old.md)');
    writeDocument.mockResolvedValue(null);
    expect(await rewriteLinksInNotebooks('C:/Notes/Old.md', 'C:/Notes/New.md')).toBe(false);
    expect(writeDocument).toHaveBeenCalledTimes(2);
  });

  it('updates A in the affected notebook before any unrelated notebook scan', async () => {
    notebooks.unshift({ id: 'slow', name: 'Slow', path: 'C:/Slow' });
    getDirChildren.mockImplementation(async (path: string) => {
      if (path === 'C:/Slow') {
        expect(writeDocument).toHaveBeenCalledTimes(1);
        return [];
      }
      return [{ type: 'document', fullPath: 'C:/Notes/A.md', name: 'A.md' }];
    });
    readDocument.mockResolvedValue('[B](flowix://open?b=Work&f=B.md)');
    writeDocument.mockImplementation(async (request) => ({ path: request.filePath, content: request.content }));
    expect(await rewriteLinksInNotebooks('C:/Notes/B.md', 'C:/Notes/B2.md')).toBe(true);
    expect(getDirChildren.mock.calls[0][0]).toBe('C:/Notes');
    expect(acceptBackgroundDocumentContent).toHaveBeenCalledWith('C:/Notes/A.md', '[B2](flowix://open?b=Work&f=B2.md)');
  });
});
