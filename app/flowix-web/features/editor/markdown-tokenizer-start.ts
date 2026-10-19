/**
 * Block tokenizers receive the whole remaining document as `src` and are asked
 * where their construct could start next. Only the beginning of that string can
 * matter: a block construct always starts a line, and paragraphs end at the next
 * blank line long before this window is exhausted. Scanning the full remainder
 * makes lexing O(blocks × document) — measured at roughly a third of lexing time
 * on a 200 KB note with ~2k blocks.
 *
 * The window is generous enough that even a long single paragraph cannot hide a
 * construct from it in practice.
 */
export const MARKDOWN_START_SCAN_WINDOW = 2048;

export function scanHead(src: string): string {
  return src.length > MARKDOWN_START_SCAN_WINDOW
    ? src.slice(0, MARKDOWN_START_SCAN_WINDOW)
    : src;
}

export function boundedIndexOf(src: string, needle: string): number {
  return scanHead(src).indexOf(needle);
}

export function boundedSearch(src: string, pattern: RegExp | string): number {
  return scanHead(src).search(pattern);
}
