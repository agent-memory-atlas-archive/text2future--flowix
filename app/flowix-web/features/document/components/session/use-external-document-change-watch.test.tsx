import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalDocumentChange, ExternalDocumentChangeContext } from '../../store/external-document-watch';

const mocks = vi.hoisted(() => ({
  handler: null as null | ((event: ExternalDocumentChange, context: ExternalDocumentChangeContext) => void | Promise<void>),
  dirty: false, reconcile: vi.fn(), capture: vi.fn(), stop: vi.fn(),
}));
vi.mock('../../store/document-session-service', () => ({
  captureLatestDocumentContent: mocks.capture,
  hasDocumentUnsavedChanges: () => mocks.dirty,
  protectDocumentDraft: vi.fn(), reconcileUnsavedExternalDocumentChange: mocks.reconcile,
  scheduleDocumentSessionSave: vi.fn(),
}));
vi.mock('@/lib/file-display-registry', () => ({ findFileDisplayPath: () => '/notes/a.md' }));
vi.mock('@features/document/store/external-document-watch', () => ({ subscribeExternalDocumentChanges: (_path: string, _scope: string, handler: typeof mocks.handler) => {
  mocks.handler = handler;
  return mocks.stop;
} }));
vi.mock('@features/preferences/public/runtime-api', () => ({ getCurrentAppLanguage: () => 'zh-CN' }));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn() } }));
import { useExternalDocumentChangeWatch } from './use-external-document-change-watch';

const identity = { kind: 'md' as const, displayId: 'recovery', path: '/notes/a.md' };
afterEach(() => vi.clearAllMocks());
describe('document recovery respects pending edits', () => {
  it.each([false, true])('rechecks the disk with unsaved edits = %s', async (dirty) => {
    mocks.dirty = dirty;
    const reload = vi.fn().mockResolvedValue(undefined);
    const clearSave = vi.fn();
    function View() {
      useExternalDocumentChangeWatch({ identity, filePath: identity.path, scopePath: '/notes', clearSaveTimer: clearSave, reloadDocument: reload });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(<View />));
      const context: ExternalDocumentChangeContext = { runOnce: async (_key, operation) => operation() };
      await act(async () => { await mocks.handler?.({ kind: 'invalidated', path: identity.path }, context); });
      if (dirty) {
        expect(mocks.reconcile).toHaveBeenCalledWith(identity, identity.path, '/notes');
        expect(reload).not.toHaveBeenCalled();
      } else {
        expect(reload).toHaveBeenCalledWith(identity.path, { preservePending: false, showLoading: false });
        expect(mocks.reconcile).not.toHaveBeenCalled();
      }
      await act(async () => root.unmount());
      vi.clearAllMocks();
      await mocks.handler?.({ kind: 'invalidated', path: identity.path }, context);
      expect(reload).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
