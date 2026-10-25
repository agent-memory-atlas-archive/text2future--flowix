import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDocumentBuffer } from '../store/document-buffer';
import { runActionableNoticeAction, clearActionableNotice } from '@features/notifications/actionable-notice-store';

const mocks = vi.hoisted(() => ({
  buffer: null as unknown as ReturnType<typeof emptyDocumentBuffer>,
  path: '/notes/a.md', session: { recoveryRevision: 1 },
  read: vi.fn(), apply: vi.fn(), clearDraft: vi.fn(),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/file-display-registry', () => ({ findFileDisplayPath: () => mocks.path }));
vi.mock('../store/document-runtime-session', () => ({ findDocumentSession: () => mocks.session }));
vi.mock('../store/document-title-session', () => ({ isTitleSaving: () => false, subscribeTitleChanges: () => () => {} }));
vi.mock('../store/recovery-draft-store', () => ({ clearRecoveryDraftThrough: mocks.clearDraft }));
vi.mock('../store/buffer-registry', () => ({ notifyDocumentBufferChanged: vi.fn(), subscribeDocumentBufferChanges: () => () => {} }));
vi.mock('../store/document-session-service', () => ({
  getDocumentBuffer: () => mocks.buffer, captureLatestDocumentContent: vi.fn(),
  protectDocumentDraft: vi.fn().mockResolvedValue(true), saveDocumentContent: vi.fn(), applyLoadedDocumentContent: mocks.apply,
}));
vi.mock('../use-cases/local-document-operations', () => ({ localDocumentOperations: { read: mocks.read } }));
import { DocumentSaveStatus } from './document-save-status';

const identity = { kind: 'md' as const, displayId: 'conflict-review', path: '/notes/a.md' };
describe('conflict actions while document state changes', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buffer = { ...emptyDocumentBuffer(), content: 'local', conflicted: true, conflictContent: 'disk-v1' };
    mocks.path = identity.path;
    mocks.session = { recoveryRevision: 1 };
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    clearActionableNotice(`document-conflict:${identity.displayId}`);
  });
  it('applies a disk choice when the document and conflict remain current', async () => {
    mocks.read.mockResolvedValueOnce('current disk');
    await act(async () => root.render(<DocumentSaveStatus identity={identity} scopePath="/notes" />));
    await act(async () => { await runActionableNoticeAction(`document-conflict:${identity.displayId}`, 'disk'); });
    expect(mocks.apply).toHaveBeenCalledWith(identity, identity.path, 'current disk', { preservePending: false });
    expect(mocks.clearDraft).toHaveBeenCalledOnce();
  });
  it.each(['conflict', 'path', 'session'] as const)('does not apply an old disk choice after %s changes', async (change) => {
    let finish!: (content: string) => void;
    mocks.read.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    await act(async () => root.render(<DocumentSaveStatus identity={identity} scopePath="/notes" />));
    let run!: Promise<void>;
    await act(async () => { run = runActionableNoticeAction(`document-conflict:${identity.displayId}`, 'disk'); });
    if (change === 'conflict') mocks.buffer.conflictContent = 'disk-v2';
    if (change === 'path') mocks.path = '/notes/renamed.md';
    if (change === 'session') mocks.session = { recoveryRevision: 2 };
    await act(async () => { finish('old read result'); await run; });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.clearDraft).not.toHaveBeenCalled();
  });
});
