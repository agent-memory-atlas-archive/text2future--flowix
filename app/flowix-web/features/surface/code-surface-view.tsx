'use client';

import type { ComponentProps } from 'react';
import { DocumentContainer } from '@features/document/components/document-container';
import { FileBrowserView, type FileBrowserViewSurface } from './file-browser-view';
import type { FileDisplayIdentity } from '@features/workspace/store/file-display-store';

type DocumentProps = Omit<ComponentProps<typeof DocumentContainer>, 'fileIdentity'> & {
  fileIdentity?: FileDisplayIdentity;
};

export type CodeSurfaceFileTree = Omit<FileBrowserViewSurface, 'content'> & {
  fileIdentity?: FileDisplayIdentity;
};

export function CodeSurfaceView({
  props,
  fileTree,
}: {
  props: DocumentProps;
  fileTree: CodeSurfaceFileTree | null;
}) {
  if (!fileTree) {
    if (!props.fileIdentity) return null;
    return <DocumentContainer {...props} fileIdentity={props.fileIdentity} />;
  }

  const activeFilePath = fileTree.activeFilePath;
  const fileIdentity = activeFilePath
    ? fileTree.fileIdentity ?? props.fileIdentity
    : undefined;
  if (activeFilePath && !fileIdentity) return null;
  const documentProps = {
    ...props,
    ...(fileIdentity ? { fileIdentity } : {}),
    externalScopePath: fileTree.scopePath,
  };
  const content = activeFilePath && fileIdentity
    ? <DocumentContainer {...documentProps} fileIdentity={fileIdentity} />
    : undefined;
  return <FileBrowserView surface={{
    ...fileTree,
    content,
  }} />;
}
