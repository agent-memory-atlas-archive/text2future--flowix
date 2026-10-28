import type { I18nKey } from '@/lib/i18n';

/**
 * Normalize the failure shapes the file-tree commands throw.
 *
 * `document_operations`-wrapped commands reject with a string like
 * `FILE_EXISTS: File exists`, while plain commands (`create_folder`,
 * `create_document`) reject with a `{ code, message }` object. Callers used to
 * stringify the error, which meant an object silently became `[object Object]`
 * and lost its code — keep the extraction in one place.
 */
function failureText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return code === undefined ? error.message : `${String(code)} ${error.message}`;
  }
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter((part) => part !== undefined && part !== '').join(' ');
  }
  return String(error);
}

/**
 * Message for a failed rename (tree row, note card, repository section, table
 * header). `FILE_EXISTS` / `INVALID_FILE_NAME` are the stable codes returned by
 * `rename_file` / `rename_folder`; anything else is a generic rename failure.
 */
export function fileTreeRenameFailureKey(error: unknown): I18nKey {
  const text = failureText(error);
  if (text.includes('FILE_EXISTS')) return 'memo.fileTree.nameConflict';
  if (text.includes('INVALID_FILE_NAME')) return 'memo.fileTree.invalidName';
  return 'memo.fileTree.renameFailed';
}

/** Message for a failed create (`create_folder` / `create_document`). */
export function fileTreeCreateFailureKey(error: unknown): I18nKey {
  const text = failureText(error);
  if (text.includes('FILE_EXISTS')) return 'memo.fileTree.nameConflict';
  if (text.includes('INVALID_FILE_NAME')) return 'memo.fileTree.invalidName';
  return 'memo.fileTree.createFailed';
}
