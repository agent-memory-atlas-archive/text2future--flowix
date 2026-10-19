const EMPTY_MARKDOWN_PLACEHOLDER_RE = /^(?:\s|&(?:amp;)?nbsp;)*$/i;

/** Recognize whitespace and reserved empty-paragraph placeholders in local text. */
export function isEmptyMarkdownPlaceholderOnly(value: string): boolean {
  return EMPTY_MARKDOWN_PLACEHOLDER_RE.test(value);
}
