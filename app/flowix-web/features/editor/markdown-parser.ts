import type { JSONContent } from '@tiptap/core'
interface MarkdownParserReply {
  id: number
  ok: boolean
  document?: JSONContent
  workerMs?: number
  /** Present when raw HTML had to be folded to text before parsing. */
  rawHtmlFiltered?: boolean
  error?: string
}

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<number, {
  resolve: (reply: MarkdownParserReply) => void
  reject: (error: Error) => void
}>()

function failWorker(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
  worker?.terminate()
  worker = null
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<MarkdownParserReply>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.ok && event.data.document) request.resolve(event.data)
    else request.reject(new Error(event.data.error ?? 'Markdown worker failed'))
  })
  worker.addEventListener('error', (event) => {
    failWorker(new Error(event.message || 'Markdown parser worker crashed'))
  })
  worker.addEventListener('messageerror', () => {
    failWorker(new Error('Markdown parser worker returned an unreadable result'))
  })
  return worker
}

/** Parse Markdown away from the UI thread using the parser-only extension registry. */
export function parseMarkdownInWorker(
  markdown: string,
): Promise<MarkdownParserReply> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('Web Workers are unavailable'))
  const id = ++nextRequestId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      getWorker().postMessage({ id, markdown })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
