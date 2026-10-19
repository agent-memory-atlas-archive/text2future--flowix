import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

const tokenizeMock = vi.hoisted(() => vi.fn())
vi.mock('./shiki-worker-client', () => ({ tokenizeCodeBlocksInWorker: tokenizeMock }))

import { CodeBlockShiki } from '../codeblock-shiki'
import { transactionNeedsShikiLoad, transactionTouchesCodeBlock } from './shiki-transaction-scope'

function createEditor(content: Record<string, unknown>) {
  return new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockShiki,
    ],
    content,
  })
}

function findCodeBlockPosition(editor: Editor): number {
  let position = -1
  editor.state.doc.descendants((node, nodePosition) => {
    if (node.type.name === 'codeBlock') {
      position = nodePosition
      return false
    }
    return true
  })
  return position
}

describe('Shiki transaction scope detection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    tokenizeMock.mockReset()
  })

  it('does not request a Shiki load for ordinary paragraph input', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
    })

    try {
      const transaction = editor.state.tr.insertText('x', 1)
      expect(transactionTouchesCodeBlock(transaction, 'codeBlock')).toBe(false)
      expect(transactionNeedsShikiLoad(transaction, 'codeBlock')).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('recomputes highlighting for code content without requesting a language load', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'plain' }] }],
    })

    try {
      const position = findCodeBlockPosition(editor)
      const transaction = editor.state.tr.insertText('x', position + 1)
      expect(transactionTouchesCodeBlock(transaction, 'codeBlock')).toBe(true)
      expect(transactionNeedsShikiLoad(transaction, 'codeBlock')).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('detects code block creation and attribute changes as load triggers', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })

    try {
      const codeBlock = editor.schema.nodes.codeBlock.create(
        null,
        editor.schema.text('plain'),
      )
      const createTransaction = editor.state.tr.insert(editor.state.doc.content.size, codeBlock)
      expect(transactionNeedsShikiLoad(createTransaction, 'codeBlock')).toBe(true)

      const withCodeBlock = createEditor({
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'plain' }] }],
      })
      try {
        const position = findCodeBlockPosition(withCodeBlock)
        const attributeTransaction = withCodeBlock.state.tr.setNodeAttribute(
          position,
          'language',
          'javascript',
        )
        expect(transactionTouchesCodeBlock(attributeTransaction, 'codeBlock')).toBe(true)
        expect(transactionNeedsShikiLoad(attributeTransaction, 'codeBlock')).toBe(true)

        const node = withCodeBlock.state.doc.nodeAt(position)
        const markupTransaction = withCodeBlock.state.tr.setNodeMarkup(position, null, {
          ...node?.attrs,
          language: 'javascript',
        })
        expect(transactionNeedsShikiLoad(markupTransaction, 'codeBlock')).toBe(true)

        const deleteTransaction = withCodeBlock.state.tr.delete(
          position,
          position + (node?.nodeSize ?? 0),
        )
        expect(transactionNeedsShikiLoad(deleteTransaction, 'codeBlock')).toBe(false)
      } finally {
        withCodeBlock.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it('keeps Mermaid out of the Shiki grammar load path', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'graph TD' }] }],
    })

    try {
      const position = findCodeBlockPosition(editor)
      const transaction = editor.state.tr.setNodeAttribute(position, 'language', 'mermaid')
      expect(transactionTouchesCodeBlock(transaction, 'codeBlock')).toBe(true)
      expect(transactionNeedsShikiLoad(transaction, 'codeBlock')).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('only sends changed code blocks to the worker after the initial highlight', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    tokenizeMock.mockImplementation(async (blocks: Array<{ from: number; text: string }>) => ({
      id: 1,
      ok: true,
      workerMs: 0,
      blocks: blocks.map(block => ({
        from: block.from,
        lines: block.text.split('\n').map(content => content ? [{ content, color: '#000000' }] : []),
      })),
    }))
    const editor = createEditor({
      type: 'doc',
      content: Array.from({ length: 80 }, (_, index) => ({
        type: 'codeBlock',
        content: [{ type: 'text', text: `const value${index} = ${index}` }],
      })),
    })

    try {
      await vi.advanceTimersByTimeAsync(300)
      await vi.waitFor(() => expect(tokenizeMock).toHaveBeenCalledTimes(1))
      expect(tokenizeMock.mock.calls[0][0]).toHaveLength(80)

      const position = findCodeBlockPosition(editor)
      editor.commands.insertContentAt(position + 1, '!')
      await vi.advanceTimersByTimeAsync(150)
      await vi.waitFor(() => expect(tokenizeMock).toHaveBeenCalledTimes(2))

      expect(tokenizeMock.mock.calls[1][0]).toHaveLength(1)
    } finally {
      editor.destroy()
    }
  })
})
