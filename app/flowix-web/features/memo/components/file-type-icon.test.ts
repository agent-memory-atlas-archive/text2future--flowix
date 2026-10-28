import { describe, expect, it } from 'vitest';
import {
  FileCodeIcon,
  FileImageIcon,
  FileMdIcon,
  FileTextIcon,
  FileVideoIcon,
  FileZipIcon,
} from '@phosphor-icons/react';

import {
  DocumentFileIcon,
  getFileIcon,
  HtmlFileIcon,
  PdfFileIcon,
  PresentationFileIcon,
  SpreadsheetFileIcon,
} from '@features/memo/components/file-type-icon';

describe('getFileIcon', () => {
  it.each([
    ['README.MD', FileMdIcon],
    ['index.html', HtmlFileIcon],
    ['app.tsx', FileCodeIcon],
    ['photo.JPEG', FileImageIcon],
    ['report.docx', DocumentFileIcon],
    ['notes.rtf', DocumentFileIcon],
    ['letter.odt', DocumentFileIcon],
    ['slides.pptx', PresentationFileIcon],
    ['deck.key', PresentationFileIcon],
    ['talk.ppt', PresentationFileIcon],
    ['recording.mp4', FileVideoIcon],
    ['archive.zip', FileZipIcon],
    ['budget.xlsx', SpreadsheetFileIcon],
    ['export.csv', SpreadsheetFileIcon],
    ['sheet.tsv', SpreadsheetFileIcon],
    ['planning.numbers', SpreadsheetFileIcon],
    ['manual.pdf', PdfFileIcon],
  ])('maps %s to its file icon', (filename, expectedIcon) => {
    expect(getFileIcon(filename)).toBe(expectedIcon);
  });

  it('uses a generic file icon for unknown extensions', () => {
    // Extensionless text files are opened by CodeMirror (LICENSE, Makefile,
    // Dockerfile), while a binary-looking extension remains generic.
    expect(getFileIcon('LICENSE')).toBe(FileCodeIcon);
    expect(getFileIcon('data.bin')).toBe(FileTextIcon);
  });
});
