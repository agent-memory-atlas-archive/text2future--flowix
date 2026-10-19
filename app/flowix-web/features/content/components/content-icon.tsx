import { forwardRef } from 'react';
import type { Icon, IconProps } from '@phosphor-icons/react';
import { Folder, Globe } from 'lucide-react';
import {
  FileCodeIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
} from '@phosphor-icons/react';
import { classifyFileContent, type FileContentKind } from '@features/content/model/content-kind';
import { NoteContentIcon } from './note-content-icon';

export type ContentFileIconKind = FileContentKind | 'fallback';

const PHOSPHOR_ICON_BY_KIND: Record<ContentFileIconKind, Icon> = {
  note: FileMdIcon,
  html: FileHtmlIcon,
  document: FileDocIcon,
  presentation: FilePptIcon,
  spreadsheet: FileXlsIcon,
  pdf: FilePdfIcon,
  video: FileVideoIcon,
  archive: FileZipIcon,
  image: FileImageIcon,
  code: FileCodeIcon,
  fallback: FileTextIcon,
  text: FileTextIcon,
  unknown: FileTextIcon,
};

/** Flat icon categories; special resources sit beside file categories. */
export type ContentKind = FileContentKind | 'folder' | 'web' | 'media-library' | 'multidimensional-table';

export type ContentDescription =
  | { kind: 'file'; path: string; mimeType?: string | null }
  | { kind: ContentKind };

/** One renderer for content icons; callers provide facts and layout only. */
export function ContentIcon({ content, className }: { content: ContentDescription; className?: string }) {
  const kind = content.kind === 'file'
    ? getFileIconKind(content.path, content.mimeType)
    : content.kind;
  if (kind === 'folder') return <Folder aria-hidden="true" className={className} />;
  if (kind === 'web') return <Globe aria-hidden="true" className={className} />;
  if (kind === 'note') return <NoteContentIcon className={className} />;
  if (kind === 'media-library') return <MediaLibraryIcon className={className} />;
  if (kind === 'multidimensional-table') return <TableDocumentIcon className={className} />;
  return <FileKindIcon kind={kind} className={className} />;
}

/** Resolve a file's semantic icon kind through the shared content classifier. */
export function getFileIconKind(path: string, mimeType?: string | null): ContentFileIconKind {
  return classifyFileContent(path, mimeType);
}

/** Resolve the legacy Phosphor component for callers that need it. */
export function getFileIcon(path: string): Icon {
  if (isTableDocumentPath(path)) return PHOSPHOR_ICON_BY_KIND.spreadsheet;
  return PHOSPHOR_ICON_BY_KIND[getFileIconKind(path)];
}

export function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  if (isTableDocumentPath(path)) return <ContentIcon content={{ kind: 'multidimensional-table' }} className={className} />;
  if (/\.lib\.ya?ml$/i.test(path)) return <ContentIcon content={{ kind: 'media-library' }} className={className} />;
  return <ContentIcon content={{ kind: 'file', path }} className={className} />;
}

/** Resolve the custom icons used for non-note files in the notebook tree. */
export function NotebookTreeResourceIcon({ path, className, collectionType }: { path: string; className?: string; collectionType?: 'table' | 'media_library' | 'work_documents' }) {
  const legacyCollectionType = collectionType
    ?? (isTableDocumentPath(path) ? 'table' : /\.lib\.ya?ml$/i.test(path) ? 'media_library' : /\.workdocs\.ya?ml$/i.test(path) ? 'work_documents' : undefined);
  const content: ContentDescription = legacyCollectionType === 'table'
    ? { kind: 'multidimensional-table' }
    : legacyCollectionType === 'media_library'
      ? { kind: 'media-library' }
      : legacyCollectionType === 'work_documents'
        ? { kind: 'document' }
      : { kind: 'file', path };
  return <ContentIcon content={content} className={className} />;
}

function FileKindIcon({ kind, className }: { kind: ContentFileIconKind; className?: string }) {
  if (kind === 'image' || kind === 'video' || kind === 'code' || kind === 'unknown') {
    return <CustomFileIcon kind={kind === 'unknown' ? 'fallback' : kind} className={className} />;
  }
  const IconComponent = PHOSPHOR_ICON_BY_KIND[kind];
  return <IconComponent aria-hidden="true" className={className} />;
}

function isTableDocumentPath(path: string): boolean {
  return /\.table\.ya?ml$/i.test(path);
}

/**
 * 多维表格 (`.table.yaml`) 的统一图标 ── 与媒体库图标共用 viewBox、缩放、
 * 描边和透明度，保持文件树内视觉尺寸一致。保留 Phosphor 兼容组件
 * (forwardRef + IconProps), 以便直接作为 SlashMenuItem.icon 使用。
 */
export const TableDocumentIcon = forwardRef<SVGSVGElement, IconProps>(
  function TableDocumentIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <g transform="translate(1.5 1.5) scale(0.625)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="18" x="2" y="3" rx="2" />
          <path d="M9 4v16M3 9h18" />
        </g>
      </svg>
    );
  },
);

export const MediaLibraryIcon = forwardRef<SVGSVGElement, IconProps>(
  function MediaLibraryIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <g transform="translate(1.5 1.5) scale(0.625)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 7v10" />
          <path d="M6 5v14" />
          <rect width="12" height="18" x="10" y="3" rx="2" />
        </g>
      </svg>
    );
  },
);

function CustomFileIcon({ kind, className }: { kind: ContentFileIconKind; className?: string }) {
  if (kind === 'image') return <ImageFileIcon className={className} />;
  if (kind === 'video') return <VideoFileIcon className={className} />;
  if (kind === 'code') return <CodeFileIcon className={className} />;
  return <FallbackFileIcon className={className} />;
}

export function CodeFileIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
      <path d="M5.25 5.37L2.87 7.53C2.01 8.33 2.01 9.05 2.87 9.85L5.25 11.93" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.6 1.8L7.3 16.3" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.76 5.37L15.13 7.53C15.99 8.33 15.99 9.05 15.13 9.85L12.76 11.93" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FallbackFileIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
      <g transform="matrix(0.6923077 0 0 0.6923077 0.6923077 0.6923077)">
        <path d="M 3.6667 19 V 5 c 0 -1.4733 1.1933 -2.6667 2.6667 -2.6667 h 7.448 c 0.3533 0 0.6933 0.14 0.9427 0.3907 l 5.2187 5.2187 c 0.2507 0.2507 0.3907 0.5893 0.3907 0.9427 v 10.1146 c 0 1.4733 -1.1933 2.6667 -2.6667 2.6667 H 6.3333 c -1.4733 0 -2.6667 -1.1933 -2.6667 -2.6667 Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path d="M 20.2133 8.3333 h -4.5467 c -0.736 0 -1.3333 -0.5973 -1.3333 -1.3333 V 2.4693" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

export function VideoFileIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
      <rect x="1.8" y="3.6" width="11.8" height="10.8" rx="1.8" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.6 7.08L16 5.16C16.6 4.68 17.3 5.16 17.3 6V12C17.3 12.84 16.6 13.32 16 12.84L13.6 10.92V7.08Z" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ImageFileIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="64"
      height="64"
      viewBox="0 0 18 18"
      fill="none"
      opacity={0.6}
      aria-hidden="true"
      className={className}
    >
      <g transform="matrix(0.6666667 0 0 0.6666667 1 1)">
        <path d="M21.6799 16.9599L18.5499 9.64988C17.4899 7.16988 15.5399 7.06988 14.2299 9.42988L12.3399 12.8399C11.3799 14.5699 9.58993 14.7199 8.34993 13.1699L8.12993 12.8899C6.83993 11.2699 5.01993 11.4699 4.08993 13.3199L2.36993 16.7699C1.15993 19.1699 2.90993 21.9999 5.58993 21.9999H18.3499C20.9499 21.9999 22.6999 19.3499 21.6799 16.9599Z" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6.96997 8C8.62682 8 9.96997 6.65685 9.96997 5C9.96997 3.34315 8.62682 2 6.96997 2C5.31312 2 3.96997 3.34315 3.96997 5C3.96997 6.65685 5.31312 8 6.96997 8Z" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
