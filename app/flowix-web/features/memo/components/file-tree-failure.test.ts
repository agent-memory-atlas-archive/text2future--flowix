import { describe, expect, it } from 'vitest';
import { fileTreeCreateFailureKey, fileTreeRenameFailureKey } from './file-tree-failure';

describe('file tree failure mapping', () => {
  it('reads operation-wrapped string errors', () => {
    // document_operations::run formats io failures as "<CODE>: <detail>".
    const error = 'FILE_EXISTS: File exists (os error 17)';
    expect(fileTreeRenameFailureKey(error)).toBe('memo.fileTree.nameConflict');
    expect(fileTreeCreateFailureKey(error)).toBe('memo.fileTree.nameConflict');
  });

  it('reads plain command failure objects', () => {
    // create_folder / create_document reject with { code, message? }.
    expect(fileTreeCreateFailureKey({ code: 'INVALID_FILE_NAME' })).toBe('memo.fileTree.invalidName');
    expect(fileTreeCreateFailureKey({ code: 'FILE_PERMISSION_DENIED', message: 'denied' }))
      .toBe('memo.fileTree.createFailed');
  });

  it('keeps a code carried on an Error object', () => {
    const error = Object.assign(new Error('File exists'), { code: 'FILE_EXISTS' });
    expect(fileTreeRenameFailureKey(error)).toBe('memo.fileTree.nameConflict');
  });

  it('falls back per operation instead of leaking a raw code', () => {
    expect(fileTreeRenameFailureKey('boom')).toBe('memo.fileTree.renameFailed');
    expect(fileTreeCreateFailureKey('boom')).toBe('memo.fileTree.createFailed');
    expect(fileTreeCreateFailureKey(undefined)).toBe('memo.fileTree.createFailed');
  });
});
