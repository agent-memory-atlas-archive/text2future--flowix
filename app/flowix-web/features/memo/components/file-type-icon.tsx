/** @deprecated Import ContentIcon from features/content for new callers. */
export {
  FileTypeIcon,
  NotebookTreeResourceIcon,
  getFileIcon,
  TableDocumentIcon,
  MediaLibraryIcon,
  PresentationFileIcon,
  SpreadsheetFileIcon,
  DocumentFileIcon,
  PdfFileIcon,
  HtmlFileIcon,
  CodeFileIcon,
  FallbackFileIcon,
  VideoFileIcon,
  ImageFileIcon,
} from '@features/content/components/content-icon';

import { getFileIconKind as getContentFileIconKind } from '@features/content/components/content-icon';

/** Legacy name retained for callers that expect Markdown-specific terminology. */
export type FileIconKind =
  | 'markdown'
  | 'html'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'pdf'
  | 'video'
  | 'archive'
  | 'image'
  | 'code'
  | 'fallback';

export function getFileIconKind(path: string): FileIconKind {
  if (/\.table\.ya?ml$/i.test(path)) return 'spreadsheet';
  const kind = getContentFileIconKind(path);
  if (kind === 'note') return 'markdown';
  if (kind === 'text' || kind === 'unknown') return 'fallback';
  return kind;
}
