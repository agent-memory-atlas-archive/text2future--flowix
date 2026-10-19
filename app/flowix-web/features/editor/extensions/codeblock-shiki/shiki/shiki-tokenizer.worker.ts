import type { BundledLanguage, BundledTheme } from 'shiki'
import type { LanguageRegistration } from '@shikijs/types'
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import {
  getShikiLanguageDefinition,
  SHIKI_THEMES,
} from './shiki-languages'
import type {
  ShikiHighlightBlockResult,
  ShikiHighlightInput,
  ShikiHighlightToken,
} from './shiki-decorations'

type WorkerHighlighter = Awaited<ReturnType<typeof createHighlighterCore>>

interface WorkerRequest {
  id: number
  blocks: ShikiHighlightInput[]
}

let highlighter: WorkerHighlighter | undefined
let highlighterPromise: Promise<WorkerHighlighter> | undefined
const languagePromises = new Map<string, Promise<void>>()

function getHighlighter(): Promise<WorkerHighlighter> {
  if (highlighter) return Promise.resolve(highlighter)
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: SHIKI_THEMES,
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).then((created) => {
      highlighter = created
      return created
    }).catch((error) => {
      highlighterPromise = undefined
      throw error
    })
  }
  return highlighterPromise
}

async function ensureLanguage(
  instance: WorkerHighlighter,
  language: string,
): Promise<void> {
  const definition = getShikiLanguageDefinition(language)
  if (!definition || instance.getLoadedLanguages().includes(definition.id)) return
  let pending = languagePromises.get(definition.id)
  if (!pending) {
    pending = definition.load().then(async (registrations: LanguageRegistration[]) => {
      await instance.loadLanguage(...registrations)
    }).finally(() => {
      languagePromises.delete(definition.id)
    })
    languagePromises.set(definition.id, pending)
  }
  await pending
}

/**
 * Highlighting is recomputed for every code block whenever any block changes,
 * so one keystroke in a code block re-tokenizes the whole document. Unchanged
 * blocks always produce identical output, so keep a small LRU keyed by the
 * resolved language/theme/text.
 */
const TOKEN_CACHE_LIMIT = 64
const tokenCache = new Map<string, ShikiHighlightToken[][]>()

function cachedTokens(key: string): ShikiHighlightToken[][] | undefined {
  const hit = tokenCache.get(key)
  if (!hit) return undefined
  tokenCache.delete(key)
  tokenCache.set(key, hit)
  return hit
}

function storeTokens(key: string, lines: ShikiHighlightToken[][]): void {
  tokenCache.set(key, lines)
  if (tokenCache.size <= TOKEN_CACHE_LIMIT) return
  const oldest = tokenCache.keys().next().value
  if (oldest !== undefined) tokenCache.delete(oldest)
}

async function tokenize(blocks: readonly ShikiHighlightInput[]): Promise<ShikiHighlightBlockResult[]> {
  const instance = await getHighlighter()
  await Promise.all([...new Set(blocks.map((block) => block.language))]
    .map((language) => ensureLanguage(instance, language)))

  return blocks.map((block) => {
    const theme = instance.getLoadedThemes().includes(block.theme as BundledTheme)
      ? block.theme as BundledTheme
      : instance.getLoadedThemes()[0]
    const language = instance.getLoadedLanguages().some((loadedLanguage) => loadedLanguage === block.language)
      ? block.language
      : 'plaintext'
    const cacheKey = `${language}\u0000${theme}\u0000${block.text}`
    const cached = cachedTokens(cacheKey)
    if (cached) return { from: block.from, lines: cached }
    const lines = instance.codeToTokensBase(block.text, {
      lang: language as BundledLanguage,
      theme,
    })
    const resultLines: ShikiHighlightToken[][] = lines.map((line) => line.map((token) => ({
      content: token.content,
      color: token.color ?? '',
    })))
    storeTokens(cacheKey, resultLines)
    return { from: block.from, lines: resultLines }
  })
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, blocks } = event.data
  const startedAt = performance.now()
  void tokenize(blocks).then((results) => {
    self.postMessage({
      id,
      ok: true,
      blocks: results,
      workerMs: Math.round((performance.now() - startedAt) * 10) / 10,
    })
  }).catch((error) => {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  })
})
