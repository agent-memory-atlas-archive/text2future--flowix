import type { AnyExtension } from '@tiptap/core';

/**
 * @tiptap/extension-list splits the whole remaining document on every block
 * boundary (`src.split('\n')`) before checking whether the block is even a
 * list. On a 200 KB note with ~2k blocks that alone costs hundreds of
 * milliseconds, which is what made Markdown parsing look quadratic.
 *
 * This wrapper rejects non-list blocks in O(1) before the original tokenizer
 * runs. It must replace the original extension in the registry: registering
 * both would execute the expensive path twice (measured 65% slower).
 */
export function guardListMarkdownTokenizer<T extends AnyExtension>(
  extension: T,
  headPattern: RegExp,
): T {
  const original = (extension as unknown as {
    config?: { markdownTokenizer?: { name?: string; tokenize?: (...args: unknown[]) => unknown } };
  }).config?.markdownTokenizer;

  if (!original || typeof original.tokenize !== 'function') {
    return extension;
  }

  const extended = (extension as unknown as {
    extend: (config: Record<string, unknown>) => T;
  }).extend({
    markdownTokenizer: {
      ...original,
      tokenize(src: string, tokens: unknown, lexer: unknown) {
        if (!headPattern.test(src)) return undefined;
        return original.tokenize!(src, tokens, lexer);
      },
    },
  });

  return extended;
}
