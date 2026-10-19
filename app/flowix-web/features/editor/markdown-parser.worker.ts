import type { JSONContent } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { createMarkdownParserExtensions } from './markdown-parser-extensions'

interface WorkerRequest {
  id: number
  markdown: string
}

interface MarkdownTokenLike {
  type?: string
  raw?: string
  tokens?: MarkdownTokenLike[]
}

let manager: MarkdownManager | null = null

function createManager(): MarkdownManager {
  const extensions = createMarkdownParserExtensions()
  return new MarkdownManager({
    extensions,
    markedOptions: { gfm: true, breaks: true },
  })
}

function getManager(): MarkdownManager {
  if (!manager) manager = createManager()
  return manager
}

function containsHtmlToken(tokens: MarkdownTokenLike[]): boolean {
  return tokens.some((token) => token.type === 'html'
    || (Array.isArray(token.tokens) && containsHtmlToken(token.tokens)))
}

/**
 * Turn an HTML token into plain text so the markdown parser can still consume
 * the surrounding document. Tags are dropped, text content survives; a token
 * without text (comments, void elements) disappears.
 */
function htmlTokenToText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * Rebuild the source with every raw-HTML token folded into plain text.
 *
 * Tiptap routes `html` tokens through `generateJSON`, which can fail for
 * documents whose HTML references nodes the parser schema does not model. When
 * that happens we would rather drop the markup than refuse the whole note.
 */
function foldRawHtmlTokens(tokens: MarkdownTokenLike[], blockLevel: boolean): string {
  let result = ''
  for (const token of tokens) {
    if (token.type === 'html') {
      const text = htmlTokenToText(token.raw ?? '')
      result += text ? (blockLevel ? `\n\n${text}\n\n` : text) : ''
      continue
    }
    if (Array.isArray(token.tokens) && token.tokens.length > 0 && containsHtmlToken(token.tokens)) {
      result += foldRawHtmlTokens(token.tokens, false)
      continue
    }
    result += token.raw ?? ''
  }
  return result
}

function stripRawHtml(markdown: string): string | null {
  const tokens = getManager().instance.lexer(markdown) as MarkdownTokenLike[]
  if (!containsHtmlToken(tokens)) return null
  const stripped = foldRawHtmlTokens(tokens, true)
  return stripped === markdown ? null : stripped
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, markdown } = event.data
  const startedAt = performance.now()
  try {
    const document: JSONContent = getManager().parse(markdown)
    self.postMessage({
      id,
      ok: true,
      document,
      workerMs: Math.round((performance.now() - startedAt) * 10) / 10,
    })
  } catch (error) {
    // One retry with raw HTML folded to text. Anything that still fails is a
    // real parse error and reaches the caller instead of silently falling back
    // to a blocking parse on the UI thread.
    const stripped = stripRawHtml(markdown)
    if (stripped !== null) {
      try {
        const document: JSONContent = getManager().parse(stripped)
        self.postMessage({
          id,
          ok: true,
          document,
          workerMs: Math.round((performance.now() - startedAt) * 10) / 10,
          rawHtmlFiltered: true,
        })
        return
      } catch {
        // Fall through to the original error, which names the actual failure.
      }
    }
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
