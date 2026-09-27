import YAML from 'yaml';
import type { DocumentIdentity } from '@features/document/store/document-identity';

const FRONTMATTER_RE = /^\uFEFF?(?:[ \t]*\n)*---\n([\s\S]*?)\n---(?:\n|$)/;

function normalizeYamlValue(value: unknown, preserveMappingOrder = false): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeYamlValue(item));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!preserveMappingOrder) {
    entries.sort(([left], [right]) => left.localeCompare(right));
  }
  return Object.fromEntries(
    entries.map(([key, child]) => [key, normalizeYamlValue(child)]),
  );
}

function normalizeBody(body: string): string {
  return body
    .replace(/^\n+/, '')
    // Legacy imports could displace a file-leading UTF-8 BOM behind injected
    // frontmatter. Ignore only that body-boundary marker for dirty checks.
    .replace(/^\uFEFF/, '')
    .replace(/\n+$/, '');
}

function normalizeYaml(yamlContent: string): string {
  const document = YAML.parseDocument(yamlContent);
  if (document.errors.length > 0) {
    // Invalid YAML must remain byte-sensitive so an edit is never mistaken
    // for an unchanged document and silently discarded.
    return `invalid:${yamlContent.trim()}`;
  }
  // Preserve top-level frontmatter order because it is user-visible and is
  // intentionally changed by the property move actions. Nested mappings keep
  // their previous order-insensitive comparison semantics.
  return `valid:${JSON.stringify(normalizeYamlValue(document.toJS(), true))}`;
}

/**
 * Normalize Markdown for editor dirty-state comparisons.
 *
 * Line endings and harmless YAML formatting changes are ignored, while YAML
 * values and top-level frontmatter field order remain part of the comparison.
 * In particular, changing frontmatter `tags` or moving a property is a real
 * document edit and must trigger autosave/CAS.
 */
export function normalizeForEquality(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) {
    return JSON.stringify({
      frontmatter: null,
      body: normalizeBody(normalized),
    });
  }
  return JSON.stringify({
    frontmatter: normalizeYaml(match[1] ?? ''),
    body: normalizeBody(normalized.slice(match[0].length)),
  });
}

export function isContentSemanticallyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeForEquality(a) === normalizeForEquality(b);
}

function isMarkdownPath(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension === 'md' || extension === 'markdown';
}

/**
 * Memo and external Markdown editors normalize harmless Markdown formatting.
 * Code/text documents must stay byte-sensitive because whitespace can be
 * meaningful source content.
 */
export function isDocumentContentEqual(
  identity: DocumentIdentity,
  a: string,
  b: string,
): boolean {
  if (!isMarkdownPath(identity.path)) {
    return a === b;
  }
  return isContentSemanticallyEqual(a, b);
}
