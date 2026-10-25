import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaLibrary, serializeMediaLibrary } from './model';
import { mutateCollectionFile, collectionNotebookId } from '@features/collection/mutations';
import { renameMediaLibrary } from './rename-media-library';

vi.mock('@platform/tauri/client', () => ({ files: {} }));
vi.mock('@features/collection/mutations', () => ({ mutateCollectionFile: vi.fn(), collectionNotebookId: vi.fn() }));

describe('media library collection rename', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(collectionNotebookId).mockResolvedValue('book'); });
  it('uses the stable collection identity and returns the committed content', async () => {
    const document = createMediaLibrary('Old');
    // 集合的 name 不再存进文档（由集合路径派生），所以期望值里也没有它。
    const renamed = { ...document, collection: { ...document.collection, revision: 1 } };
    const content = serializeMediaLibrary(renamed);
    vi.mocked(mutateCollectionFile).mockResolvedValue({ operationId: 'op', status: 'completed', collectionId: document.collection.id, actualName: 'New', actualRelativePath: 'New.lib.yaml', previousRelativePath: 'Old.lib.yaml', notebookPath: '/book', directoryMove: null, actualRevision: 1, indexSequence: 4, filePath: '/book/New.lib.yaml', content, errorCode: null });
    const onRenamed = vi.fn();
    const result = await renameMediaLibrary({ notebookPath: '/book', collectionId: document.collection.id, title: 'New', onRenamed });
    expect(mutateCollectionFile).toHaveBeenCalledWith({ notebookId: 'book', notebookPath: '/book', collectionId: document.collection.id, newName: 'New' });
    expect(result.document).toEqual(renamed);
    expect(onRenamed).toHaveBeenCalledWith('/book/New.lib.yaml');
  });
  it('publishes the actual path when only part of the operation completed', async () => {
    const document = createMediaLibrary('New');
    vi.mocked(mutateCollectionFile).mockResolvedValue({ operationId: 'op', status: 'partial', collectionId: document.collection.id, actualName: 'New', actualRelativePath: 'Old.lib.yaml', previousRelativePath: 'Old.lib.yaml', notebookPath: '/book', directoryMove: null, actualRevision: 1, indexSequence: 4, filePath: '/book/Old.lib.yaml', content: serializeMediaLibrary(document), errorCode: 'FILE_EXISTS' });
    const onRenamed = vi.fn();
    const result = await renameMediaLibrary({ notebookPath: '/book', collectionId: document.collection.id, title: 'New', onRenamed });
    expect(result.errorCode).toBe('FILE_EXISTS');
    expect(onRenamed).toHaveBeenCalledWith('/book/Old.lib.yaml');
  });
});
