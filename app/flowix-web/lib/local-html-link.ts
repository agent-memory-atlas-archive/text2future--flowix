export interface LocalHtmlLink {
  href: string;
  baseHref: string | null;
}

type HtmlLinkTarget =
  | { kind: 'file'; path: string; anchor: string }
  | { kind: 'web'; url: string }
  | { kind: 'flowix'; url: string }
  | { kind: 'external'; url: string };

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function fileUrl(path: string): string {
  const normalized = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
    ? path.replace(/\\/g, '/') : path;
  if (!normalized.startsWith('/') && !/^[a-z]:\//i.test(normalized)) {
    throw new Error('HTML document requires an absolute file path');
  }
  const encoded = normalized.split('/').map(encodeURIComponent).join('/');
  if (normalized.startsWith('//')) return `file:${encoded}`;
  return /^[a-z]:\//i.test(normalized)
    ? `file:///${encoded.replace(/^([a-z])%3A\//i, '$1:/')}`
    : `file://${encoded}`;
}

/** Resolve HTML URL semantics against the original file, never the app origin. */
export function resolveLocalHtmlLink(link: LocalHtmlLink, sourcePath: string): HtmlLinkTarget {
  if (!link.href.trim() || link.href.length > 8192 || hasControlCharacters(link.href)) {
    throw new Error('Invalid document link');
  }
  const source = fileUrl(sourcePath);
  const base = link.baseHref === null ? source : new URL(link.baseHref, source).href;
  const url = new URL(link.href, base);
  const localAsset = (url.protocol === 'asset:' && url.hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
  if (url.protocol === 'file:' || localAsset) {
    if (url.username || url.password || url.port) throw new Error('Invalid local document URL');
    let path = decodeURIComponent(localAsset ? url.pathname.slice(1) : url.pathname);
    if (localAsset && !path.startsWith('/') && !/^(?:[a-z]:[\\/]|\\\\)/i.test(path)) path = `/${path}`;
    if (hasControlCharacters(path)) throw new Error('Invalid document path');
    if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
    if (!localAsset && url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`;
    return { kind: 'file', path, anchor: decodeURIComponent(url.hash.slice(1)) };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'web', url: url.href };
  if (url.protocol === 'flowix:') return { kind: 'flowix', url: url.href };
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return { kind: 'external', url: url.href };
  throw new Error(`Unsupported link protocol: ${url.protocol}`);
}
