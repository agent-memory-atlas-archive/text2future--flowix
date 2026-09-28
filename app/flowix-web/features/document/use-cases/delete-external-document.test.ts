import { beforeEach, expect, it, vi } from 'vitest';
import { deleteExternalDocument } from './delete-external-document';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(), settled: vi.fn(), dirty: vi.fn(), remove: vi.fn(),
  capture: vi.fn(), discard: vi.fn(), cancel: vi.fn(), expectDelete: vi.fn(),
}));
vi.mock('../store/document-session-service', () => ({
  captureLatestDocumentContent: mocks.capture, discardDocumentDraft: mocks.discard,
  flushDocumentPath: mocks.flush, hasDocumentUnsavedChanges: mocks.dirty,
}));
vi.mock('../store/save-queue', () => ({ waitForSaveQueue: mocks.settled }));
vi.mock('../store/external-document-operation', () => ({ expectExternalDocumentDelete: mocks.expectDelete }));
vi.mock('./local-document-operations', () => ({ localDocumentOperations: { delete: mocks.remove } }));
const session = { fileIdentity: { path: '/notes/file.md', displayId: 'live-file' }, scopePath: '/notes', openedAt: 1, transitionId: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.flush.mockResolvedValue(true);
  mocks.settled.mockResolvedValue(true);
  mocks.dirty.mockReturnValue(false);
  mocks.expectDelete.mockReturnValue(mocks.cancel);
  mocks.remove.mockResolvedValue({ path: session.fileIdentity.path });
});

it.each(['flush', 'settled', 'dirty'] as const)('preserves the file when the %s persistence barrier rejects deletion', async barrier => {
  if (barrier === 'dirty') mocks.dirty.mockReturnValue(true);
  else mocks[barrier].mockResolvedValue(false);
  expect(await deleteExternalDocument(session)).toBe(false);
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
});

it('waits for queued writes, deletes inside the file scope and then releases the draft', async () => {
  let settle!: (value: boolean) => void;
  mocks.settled.mockReturnValue(new Promise<boolean>(resolve => { settle = resolve; }));
  const pending = deleteExternalDocument(session);
  await Promise.resolve();
  expect(mocks.remove).not.toHaveBeenCalled();
  settle(true);
  expect(await pending).toBe(true);
  expect(mocks.remove).toHaveBeenCalledWith({ path: '/notes/file.md', scopePath: '/notes' });
  expect(mocks.discard).toHaveBeenCalledOnce();
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it('restores watcher observation and preserves the draft when deletion fails', async () => {
  mocks.remove.mockRejectedValue(new Error('permission denied'));
  await expect(deleteExternalDocument(session)).rejects.toThrow('permission denied');
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(mocks.discard).not.toHaveBeenCalled();
});
