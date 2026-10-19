import type { BundledLanguage, BundledTheme } from 'shiki'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'

import {
  collectShikiHighlightInputs,
  createShikiDecorationSet,
  invalidateShikiThemeCache,
  type ShikiHighlightBlockResult,
  type ShikiHighlightInput,
} from '@features/editor/extensions/codeblock-shiki/shiki/shiki-decorations'
import { tokenizeCodeBlocksInWorker } from './shiki-worker-client'
import { transactionNeedsShikiLoad, transactionTouchesCodeBlock } from './shiki-transaction-scope'
import { markDocumentOpenTrace } from '@/lib/document-open-perf'
import { notifyCodeBlockThemeChange } from '../theme-coordinator'

export interface PluginShikiOptions {
  name: string
  defaultLanguage: BundledLanguage | 'plaintext' | null | undefined
  defaultTheme: BundledTheme
  preloadThemes?: BundledTheme[]
  traceId?: number | null
}

function highlightCacheKey(block: ShikiHighlightInput): string {
  return `${block.language}\u0000${block.theme}\u0000${block.text}`
}

function countCodeBlocks(doc: ProseMirrorNode, typeName: string): number {
  let count = 0
  doc.descendants((node) => {
    if (node.type.name === typeName) count++
  })
  return count
}

interface ShikiPluginState {
  decorations: DecorationSet
  loadVersion: number
}

const SHIKI_DECORATIONS_META = 'shikiPluginWorkerDecorations'

export function proseMirrorPluginShiki(options: PluginShikiOptions) {
  const { name, defaultLanguage, defaultTheme, traceId = null } = options
  let currentView: EditorView | null = null
  let pendingRaf: number | null = null
  let pendingDebounce: ReturnType<typeof setTimeout> | null = null
  let requestWorkerRecompute: (() => void) | null = null

  const shikiPlugin: Plugin = new Plugin({
    key: new PluginKey('codeBlockShiki'),

    state: {
      // Parsing and initial editor mount should not traverse or tokenize the
      // full document. The worker computes decorations after the view exists.
      init: () => ({
        decorations: DecorationSet.empty,
        loadVersion: 0,
      } satisfies ShikiPluginState),

      apply: (transaction, pluginState, oldState, newState) => {
        const workerDecorations = transaction.getMeta(SHIKI_DECORATIONS_META) as DecorationSet | undefined
        if (workerDecorations) {
          return {
            decorations: workerDecorations,
            loadVersion: pluginState.loadVersion,
          } satisfies ShikiPluginState
        }

        const oldNodeName = oldState.selection.$head.parent.type.name
        const newNodeName = newState.selection.$head.parent.type.name
        let didChangeSomeCodeBlock = false
        let needsShikiLoad = false
        if (transaction.docChanged) {
          didChangeSomeCodeBlock = [oldNodeName, newNodeName].includes(name)
            || transactionTouchesCodeBlock(transaction, name)
          needsShikiLoad = transactionNeedsShikiLoad(transaction, name)
        }

        if (didChangeSomeCodeBlock && pendingRaf === null) {
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = null
            requestWorkerRecompute?.()
          })
        }

        return {
          decorations: pluginState.decorations.map(transaction.mapping, transaction.doc),
          loadVersion: pluginState.loadVersion + (needsShikiLoad ? 1 : 0),
        } satisfies ShikiPluginState
      },
    },

    props: {
      decorations(state) {
        return shikiPlugin.getState(state).decorations
      },
    },

    view(editorView) {
      currentView = editorView
      let cancelled = false
      let running = false
      let needsRerun = false
      let idleId: number | null = null
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const tokenResults = new Map<string, ShikiHighlightBlockResult['lines']>()

      const scheduleRecompute = () => {
        if (cancelled) return
        if (running) {
          needsRerun = true
          return
        }
        void recomputeDecorations()
      }
      const scheduleDebouncedRecompute = () => {
        if (cancelled) return
        if (pendingDebounce !== null) clearTimeout(pendingDebounce)
        pendingDebounce = setTimeout(() => {
          pendingDebounce = null
          scheduleRecompute()
        }, 150)
      }
      requestWorkerRecompute = scheduleDebouncedRecompute

      const recomputeDecorations = async () => {
        if (cancelled || running || editorView.isDestroyed) return
        running = true
        needsRerun = false
        const documentSnapshot = editorView.state.doc
        const startedAt = performance.now()
        const { codeBlockCount, blocks } = collectShikiHighlightInputs({
          doc: documentSnapshot,
          name,
          defaultLanguage,
          defaultTheme,
        })
        const currentKeys = new Set(blocks.map(highlightCacheKey))
        const missingBlocks = blocks.filter(block => !tokenResults.has(highlightCacheKey(block)))
        markDocumentOpenTrace(traceId, 'shiki:worker-start', {
          codeBlockCount,
          highlightedBlockCount: blocks.length,
          tokenizedBlockCount: missingBlocks.length,
          contentChars: documentSnapshot.textContent.length,
        })

        try {
          const reply = await tokenizeCodeBlocksInWorker(missingBlocks)
          if (cancelled || editorView.isDestroyed) return
          if (editorView.state.doc !== documentSnapshot) {
            needsRerun = true
            return
          }

          const missingByPosition = new Map(missingBlocks.map(block => [block.from, block]))
          for (const result of reply.blocks ?? []) {
            const input = missingByPosition.get(result.from)
            if (input) tokenResults.set(highlightCacheKey(input), result.lines)
          }
          // Keep only token results represented by the current document. This
          // bounds memory to the open document and avoids LRU churn when it has
          // more than 64 distinct code blocks.
          for (const key of tokenResults.keys()) {
            if (!currentKeys.has(key)) tokenResults.delete(key)
          }
          const allResults = blocks.flatMap((block): ShikiHighlightBlockResult[] => {
            const lines = tokenResults.get(highlightCacheKey(block))
            return lines ? [{ from: block.from, lines }] : []
          })

          const decorations = createShikiDecorationSet(
            documentSnapshot,
            { doc: documentSnapshot, name, defaultLanguage, defaultTheme },
            blocks,
            allResults,
          )
          editorView.dispatch(editorView.state.tr.setMeta(SHIKI_DECORATIONS_META, decorations))
          const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10
          const tokenCount = allResults.reduce((count, block) => (
            count + block.lines.reduce((lineCount, line) => lineCount + line.length, 0)
          ), 0)
          console.info('[perf:open-doc]', 'Shiki:worker-tokenize', {
            elapsedMs,
            workerMs: reply.workerMs,
            codeBlockCount,
            highlightedBlockCount: blocks.length,
            tokenizedBlockCount: missingBlocks.length,
            tokenCount,
            contentChars: documentSnapshot.textContent.length,
          })
          markDocumentOpenTrace(traceId, 'shiki:worker-ready', {
            elapsedMs,
            workerMs: reply.workerMs,
            codeBlockCount,
            highlightedBlockCount: blocks.length,
            tokenizedBlockCount: missingBlocks.length,
            tokenCount,
          })
          markDocumentOpenTrace(traceId, 'shiki:first-decoration')
        } catch (error) {
          console.error('[CodeBlockShiki] worker tokenization failed:', error)
          markDocumentOpenTrace(traceId, 'shiki:worker-error', {
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          running = false
          if (needsRerun && !cancelled) {
            needsRerun = false
            scheduleDebouncedRecompute()
          }
        }
      }

      const scheduleLoad = () => {
        if (cancelled) return
        if (running) {
          needsRerun = true
          return
        }
        if (idleId !== null || timeoutId !== null) return

        if ('requestIdleCallback' in window) {
          idleId = window.requestIdleCallback(() => {
            idleId = null
            scheduleRecompute()
          }, { timeout: 1200 })
        } else {
          timeoutId = globalThis.setTimeout(() => {
            timeoutId = null
            scheduleRecompute()
          }, 300)
        }
      }

      const handleThemeChange = () => {
        if (cancelled) return
        invalidateShikiThemeCache()
        notifyCodeBlockThemeChange(editorView)
        scheduleRecompute()
      }
      window.addEventListener('app-theme-changed', handleThemeChange)

      const initialCodeBlockCount = countCodeBlocks(editorView.state.doc, name)
      if (initialCodeBlockCount > 0) {
        markDocumentOpenTrace(traceId, 'shiki:init-start', { codeBlockCount: initialCodeBlockCount })
        scheduleLoad()
      }

      return {
        update(view, previousState) {
          const docChanged = previousState.doc !== view.state.doc
          if (running && docChanged) needsRerun = true

          const previousPluginState = shikiPlugin.getState(previousState)
          const currentPluginState = shikiPlugin.getState(view.state)
          if (currentPluginState.loadVersion !== previousPluginState.loadVersion) {
            scheduleLoad()
          }

        },
        destroy() {
          cancelled = true
          window.removeEventListener('app-theme-changed', handleThemeChange)
          if (idleId !== null && 'cancelIdleCallback' in window) {
            window.cancelIdleCallback(idleId)
            idleId = null
          }
          if (timeoutId !== null) {
            globalThis.clearTimeout(timeoutId)
            timeoutId = null
          }
          if (pendingDebounce !== null) {
            clearTimeout(pendingDebounce)
            pendingDebounce = null
          }
          if (pendingRaf !== null) {
            cancelAnimationFrame(pendingRaf)
            pendingRaf = null
          }
          if (currentView === editorView) currentView = null
          if (requestWorkerRecompute === scheduleRecompute) requestWorkerRecompute = null
        },
      }
    },
  })

  return shikiPlugin
}
