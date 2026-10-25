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
import { classifyFileContent, isEditableTextFilePath, type FileContentKind } from '@features/content/model/content-kind';
import { NoteContentIcon } from './note-content-icon';
import { WorkDocumentsIcon as WorkDocumentsCollectionIcon } from './work-documents-icon';

export { WorkDocumentsCollectionIcon };

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
export type ContentKind = FileContentKind | 'folder' | 'web' | 'media-library' | 'multidimensional-table' | 'work-documents';

export type ContentDescription =
  | { kind: 'file'; path: string; mimeType?: string | null }
  | { kind: ContentKind };

/** One renderer for content icons; callers provide facts and layout only. */
export function ContentIcon({ content, className }: { content: ContentDescription; className?: string }) {
  const kind = content.kind === 'file'
    ? isWorkDocumentsCollectionPath(content.path) ? 'work-documents' : getFileIconKind(content.path, content.mimeType)
    : content.kind;
  if (kind === 'folder') return <Folder aria-hidden="true" className={className} />;
  if (kind === 'web') return <Globe aria-hidden="true" className={className} />;
  if (kind === 'note') return <NoteContentIcon className={className} />;
  if (kind === 'media-library') return <MediaLibraryIcon className={className} />;
  if (kind === 'multidimensional-table') return <TableDocumentIcon className={className} />;
  if (kind === 'work-documents') return <WorkDocumentsCollectionIcon className={className} />;
  return <FileKindIcon kind={kind} className={className} />;
}

/** Resolve a file's semantic icon kind through the shared content classifier. */
export function getFileIconKind(path: string, mimeType?: string | null): ContentFileIconKind {
  return classifyFileContent(path, mimeType);
}

/** Resolve the legacy Phosphor component for callers that need it. */
export function getFileIcon(path: string): Icon {
  if (isTableDocumentPath(path)) return PHOSPHOR_ICON_BY_KIND.spreadsheet;
  const kind = getFileIconKind(path);
  // 无扩展名但能在 CodeMirror 打开的文本文件（LICENSE、Makefile…）用代码图标，
  // 其余纯文本用文本图标。分类器把这类文件判成 text，所以在这里升级图标，
  // 不去改共享的 content kind（它还决定用哪个编辑器打开）。
  if (kind === 'text' && isEditableTextFilePath(path)) return PHOSPHOR_ICON_BY_KIND.code;
  return PHOSPHOR_ICON_BY_KIND[kind];
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
        ? { kind: 'work-documents' }
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

export function HtmlFileIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      opacity={0.8}
      aria-hidden="true"
      className={className}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 4.75C7.99592 4.75 4.74999 7.99594 4.74999 12C4.74999 13.9048 5.48455 15.638 6.68585 16.9318C8.62786 16.4835 11.0216 15.5733 13.4782 14.2645C15.7717 13.0425 17.7079 11.6928 19.0825 10.4435C18.3702 7.18746 15.4698 4.75 12 4.75ZM19.2446 12.281C17.8627 13.4073 16.1329 14.5497 14.1835 15.5883C12.0622 16.7185 9.95852 17.5778 8.10042 18.113C9.2264 18.8328 10.5645 19.25 12 19.25C15.91 19.25 19.097 16.1548 19.2446 12.281ZM6.21026 18.5608C7.75299 19.9232 9.77993 20.75 12 20.75C16.8325 20.75 20.75 16.8325 20.75 12C20.75 11.6555 20.7301 11.3157 20.6913 10.9815C20.7214 10.9514 20.7512 10.9213 20.7806 10.8912C21.5345 10.1218 22.1234 9.35069 22.4527 8.62308C22.7767 7.90704 22.9112 7.07876 22.4649 6.36547C22.0451 5.69445 21.2797 5.40413 20.5094 5.30068C19.7379 5.19707 18.8066 5.25684 17.7897 5.43925C16.247 4.07679 14.22 3.25 12 3.25C7.16749 3.25 3.24999 7.16751 3.24999 12C3.24999 12.3445 3.26989 12.6843 3.30862 13.0185C2.54952 13.78 1.9542 14.5396 1.60462 15.2551C1.23859 16.0043 1.06423 16.882 1.53503 17.6345C1.96779 18.3262 2.76731 18.614 3.56745 18.709C4.32123 18.7986 5.22388 18.7377 6.21026 18.5608ZM4.97527 17.2178C4.43415 16.4905 4.00332 15.6762 3.70752 14.7999C3.36447 15.2104 3.11279 15.5852 2.95236 15.9136C2.67513 16.481 2.74418 16.7391 2.80665 16.8389C2.87948 16.9553 3.1117 17.1443 3.74441 17.2195C4.08653 17.2602 4.49917 17.2608 4.97527 17.2178ZM19.0247 6.78221C19.5275 6.73681 19.9584 6.74015 20.3097 6.78733C20.9042 6.86717 21.1231 7.04883 21.1933 7.16107C21.2526 7.25588 21.3187 7.49052 21.0861 8.00469C20.9301 8.34948 20.6665 8.75251 20.2924 9.20014C19.9967 8.32375 19.5658 7.50953 19.0247 6.78221Z"
        fill="currentColor"
      />
    </svg>
  );
}

function isTableDocumentPath(path: string): boolean {
  return /\.table\.ya?ml$/i.test(path);
}

function isWorkDocumentsCollectionPath(path: string): boolean {
  return /\.workdocs\.ya?ml$/i.test(path);
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
