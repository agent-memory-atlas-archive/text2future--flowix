import { canonicalPath, fileLocatorKey } from '@/lib/path';
import type { FileDisplayIdentity } from '@features/workspace/store/file-display-store';

/** Durable Markdown address used by history and recovery data. */
export interface DocumentLocator {
  kind: 'md';
  path: string;
}

/** Runtime identity shared by every Markdown surface displaying this file.
 * memoId is optional Memo business context and never participates in identity keys.
 */
export interface DocumentIdentity extends FileDisplayIdentity {
  kind: 'md';
  memoId: string | null;
}

/** Add Markdown business context to an already established local-file identity. */
export function documentIdentityFromFile(
  fileIdentity: FileDisplayIdentity,
  memoId: string | null = null,
): DocumentIdentity {
  return {
    kind: 'md',
    memoId,
    path: canonicalPath(fileIdentity.path),
    displayId: fileIdentity.displayId,
  };
}

export function normalizeDocumentIdentity(identity: DocumentIdentity): DocumentIdentity {
  return { ...identity, kind: 'md', path: canonicalPath(identity.path) };
}

export function documentIdentityKey(identity: DocumentIdentity): string {
  return `md:${identity.displayId}`;
}

/** Surface-scoped event target for frontmatter controls on any Markdown file. */
export function documentPropertyTargetId(displayId: string): string {
  return `file:${displayId}`;
}

/** Convert runtime identity into a durable path-based address. */
export function documentLocator(identity: DocumentIdentity): DocumentLocator {
  return { kind: 'md', path: canonicalPath(identity.path) };
}

export function documentLocatorKey(locator: DocumentLocator): string {
  // Durable document state follows the file path.
  return fileLocatorKey(locator.path);
}
