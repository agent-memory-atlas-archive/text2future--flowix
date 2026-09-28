import { canonicalPath } from '@/lib/path';

/** Persist a notebook-relative address in a Flowix deep link. */
export function buildNoteOpenLink(book: string, relativeFile: string, heading?: string): string {
  const file = relativeFile.replace(/\\/g, '/');
  if (!book || !file || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid notebook link target');
  }
  const params = new URLSearchParams({ book, file });
  // Explicit heading also disambiguates filenames containing '#'.
  if (heading !== undefined || file.includes('#')) params.set('heading', heading ?? '');
  return `flowix://open?${params.toString()}`;
}

export function buildNoteOpenLinkFromPath(
  path: string,
  notebooks: ReadonlyArray<{ name: string; path: string }>,
  heading?: string,
): string | null {
  const target = canonicalPath(path);
  const matches = notebooks
    .map((notebook) => ({ notebook, root: canonicalPath(notebook.path).replace(/\/+$/, '') }))
    .filter(({ root }) => {
      const caseInsensitive = /^[A-Za-z]:\//.test(target) || target.startsWith('//');
      return caseInsensitive
        ? target.toLowerCase().startsWith(`${root}/`.toLowerCase())
        : target.startsWith(`${root}/`);
    })
    .sort((a, b) => b.root.length - a.root.length);
  const match = matches[0];
  if (!match || notebooks.filter((book) => book.name === match.notebook.name).length !== 1) return null;
  return buildNoteOpenLink(match.notebook.name, target.slice(match.root.length + 1), heading);
}
