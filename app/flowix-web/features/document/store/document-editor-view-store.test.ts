import { afterEach, describe, expect, it } from 'vitest';

import {
  documentEditorViewKey,
  getDocumentEditorMode,
  setDocumentEditorMode,
  useDocumentEditorViewStore,
} from './document-editor-view-store';

const memoIdentity = { kind: 'md' as const, path: '/memo-1.md', displayId: 'display-1' };

describe('document editor view store', () => {
  afterEach(() => {
    useDocumentEditorViewStore.getState().reset();
  });

  it('defaults every document host to rich mode', () => {
    expect(getDocumentEditorMode('main-third', memoIdentity)).toBe('rich');
  });

  it('keeps modes isolated by host and document identity', () => {
    setDocumentEditorMode('main-third', memoIdentity, 'source');

    expect(getDocumentEditorMode('main-third', memoIdentity)).toBe('source');
    expect(getDocumentEditorMode('browser-column', memoIdentity)).toBe('rich');
    expect(getDocumentEditorMode('main-third', { kind: 'md', path: '/memo-2.md', displayId: 'display-2' })).toBe('rich');
  });

  it('uses stable keys for equivalent identity objects', () => {
    expect(documentEditorViewKey('main-third', memoIdentity)).toBe('main-third:md:display-1');
    expect(documentEditorViewKey('main-third', { ...memoIdentity })).toBe(
      documentEditorViewKey('main-third', memoIdentity),
    );
  });
});
