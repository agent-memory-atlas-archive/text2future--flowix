import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './markdown-editor'
import { ShortcutsProvider } from '@features/shortcuts'
import '@features/shortcuts/actions'

let container: HTMLDivElement
let root: Root

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

async function mountEditor(): Promise<Editor> {
  let editor: Editor | null = null
  await act(async () => {
    root.render(
      <ShortcutsProvider overrides={{}}>
        <MarkdownEditor content="" onBeforeCreate={instance => { editor = instance }} />
      </ShortcutsProvider>,
    )
  })
  if (!editor) throw new Error('Editor did not mount')
  return editor
}

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const item = (text: string, child?: object) => ({ type: 'listItem', content: [paragraph(text), ...(child ? [child] : [])] })
const task = (text: string, checked = false, child?: object) => ({
  type: 'taskItem', attrs: { checked }, content: [paragraph(text), ...(child ? [child] : [])],
})

describe('mixed list Markdown round trips', () => {
  it('restores a paragraph placed between two list items', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [item('A')] },
        paragraph('Between'),
        { type: 'bulletList', content: [item('B')] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    expect(editor.state.doc.content.content.slice(0, 3).map(node => node.type.name))
      .toEqual(['bulletList', 'paragraph', 'bulletList'])
  })

  it('restores a paragraph between nested list runs', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            paragraph('Parent'),
            { type: 'bulletList', content: [item('A')] },
            paragraph('Between'),
            { type: 'bulletList', content: [item('B')] },
          ],
        }],
      }],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const restored = editor.state.doc.firstChild?.firstChild
    expect(restored?.content.content.slice(1).map(node => node.type.name))
      .toEqual(['bulletList', 'paragraph', 'bulletList'])
  })

  it('restores adjacent ordinary and task list runs', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [item('A')] },
        { type: 'taskList', content: [task('B', true)] },
        { type: 'bulletList', content: [item('C')] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const lists = editor.state.doc.content.content.filter(node =>
      ['bulletList', 'orderedList', 'taskList'].includes(node.type.name))
    expect(lists.map(node => node.type.name)).toEqual(['bulletList', 'taskList', 'bulletList'])
    expect(lists[1].firstChild?.attrs.checked).toBe(true)
  })

  it('keeps numbering across a converted task item', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 4 }, content: [item('A')] },
        { type: 'taskList', content: [task('B')] },
        { type: 'orderedList', attrs: { start: 6 }, content: [item('C')] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const lists = editor.state.doc.content.content.filter(node =>
      ['orderedList', 'taskList'].includes(node.type.name))
    expect(lists.map(node => node.type.name)).toEqual(['orderedList', 'taskList', 'orderedList'])
    expect(lists[0].attrs.start).toBe(4)
    expect(lists[2].attrs.start).toBe(6)
  })

  it('restores task lists under numbered items and numbered lists under tasks', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 3 }, content: [
          item('Parent', { type: 'taskList', content: [task('Child', true)] }),
        ] },
        { type: 'taskList', content: [
          task('Task parent', false, { type: 'orderedList', content: [item('Numbered child')] }),
        ] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const ordered = editor.state.doc.content.content.find(node => node.type.name === 'orderedList')
    const taskList = editor.state.doc.content.content.find(node => node.type.name === 'taskList')
    expect(ordered?.attrs.start).toBe(3)
    expect(ordered?.firstChild?.lastChild?.type.name).toBe('taskList')
    expect(ordered?.firstChild?.lastChild?.firstChild?.attrs.checked).toBe(true)
    expect(taskList?.firstChild?.lastChild?.type.name).toBe('orderedList')
  })

  it('restores all six mixed parent and child list combinations', async () => {
    const editor = await mountEditor()
    const listTypes = ['bulletList', 'orderedList', 'taskList'] as const
    for (const parentType of listTypes) {
      for (const childType of listTypes) {
        if (parentType === childType) continue
        const child = {
          type: childType,
          content: [childType === 'taskList' ? task('Child', true) : item('Child')],
        }
        const parent = {
          type: parentType,
          content: [parentType === 'taskList' ? task('Parent', false, child) : item('Parent', child)],
        }
        act(() => editor.commands.setContent({ type: 'doc', content: [parent] }))
        const markdown = editor.getMarkdown()
        act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
        const restored = editor.state.doc.content.content.find(node => node.type.name === parentType)
        expect(restored?.firstChild?.lastChild?.type.name, `${parentType} > ${childType}: ${markdown}`)
          .toBe(childType)
      }
    }
  })
})


describe('table list persistence in the production editor', () => {
  it('restores native lists and interactive Todo state after saving', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({ type: 'doc', content: [{
      type: 'table', content: [{ type: 'tableRow', content: [{
        type: 'tableCell', attrs: { colwidth: [200] }, content: [
          { type: 'bulletList', content: [item('哈哈', { type: 'orderedList', attrs: { start: 2 }, content: [item('nested')] })] },
          { type: 'taskList', content: [task('done', true), task('pending')] },
        ],
      }] }],
    }] }))
    const expected = editor.state.doc.firstChild?.toJSON()
    const markdown = editor.getMarkdown()
    expect(markdown).toContain('<table')
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    expect(editor.state.doc.firstChild?.toJSON()).toEqual(expected)
    let taskPosition = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'taskItem' && taskPosition < 0) taskPosition = pos
    })
    act(() => { editor.view.dispatch(editor.state.tr.setNodeMarkup(taskPosition, undefined, { checked: false })) })
    const updated = editor.getMarkdown()
    act(() => editor.commands.setContent(updated, { contentType: 'markdown' }))
    expect(editor.state.doc.nodeAt(taskPosition)?.attrs.checked).toBe(false)
  })
})


describe('Tab priority for lists inside table cells', () => {
  const pressTab = (editor: Editor, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey, bubbles: true, cancelable: true })
    act(() => { editor.view.dom.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
  }
  const cellPosition = (editor: Editor) => {
    const { $from } = editor.state.selection
    for (let depth = $from.depth; depth > 0; depth--) {
      if (['tableCell', 'tableHeader'].includes($from.node(depth).type.name)) return $from.before(depth)
    }
    return -1
  }

  it.each(['bulletList', 'orderedList', 'taskList'])('indents and outdents %s before navigating cells', async type => {
    const editor = await mountEditor()
    const makeItem = type === 'taskList' ? (text: string) => task(text, true) : item
    act(() => editor.commands.setContent({ type: 'doc', content: [{ type: 'table', content: [{
      type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type, content: [makeItem('A'), makeItem('B')] }] },
        { type: 'tableCell', content: [paragraph('next')] },
      ],
    }] }] }))
    let position = -1
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'B') position = pos })
    act(() => editor.commands.setTextSelection(position))
    const originalCell = cellPosition(editor)
    pressTab(editor)
    expect(cellPosition(editor)).toBe(originalCell)
    const list = editor.state.doc.firstChild?.firstChild?.firstChild?.firstChild
    expect(list?.childCount).toBe(1)
    expect(list?.firstChild?.lastChild?.type.name).toBe(type)
    pressTab(editor, true)
    expect(cellPosition(editor)).toBe(originalCell)
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.firstChild?.childCount).toBe(2)
    if (type === 'taskList') expect(editor.state.doc.firstChild?.firstChild?.firstChild?.firstChild?.child(1).attrs.checked).toBe(true)
  })

  it('keeps a first list item in its cell when it cannot indent', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent('<table><tr><td><ul><li><p>only</p></li></ul></td><td><p>next</p></td></tr></table>'))
    let position = -1
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'only') position = pos })
    act(() => editor.commands.setTextSelection(position))
    const before = editor.getJSON()
    const originalCell = cellPosition(editor)
    pressTab(editor)
    expect(editor.getJSON()).toEqual(before)
    expect(cellPosition(editor)).toBe(originalCell)
  })

  it('still navigates ordinary cells with Tab and Shift-Tab', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent('<table><tr><td><p>first</p></td><td><p>next</p></td></tr></table>'))
    let position = -1
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'first') position = pos })
    act(() => editor.commands.setTextSelection(position))
    const originalCell = cellPosition(editor)
    pressTab(editor)
    expect(cellPosition(editor)).not.toBe(originalCell)
    pressTab(editor, true)
    expect(cellPosition(editor)).toBe(originalCell)
  })
})


describe('complex table serialization regressions', () => {
  it('preserves punctuation-adjacent bold without introducing a non-schema mark', async () => {
    const editor = await mountEditor()
    const boldParagraph = { type: 'paragraph', content: [
      { type: 'text', text: '重点。', marks: [{ type: 'bold' }] },
      { type: 'text', text: '接下来' },
    ] }
    act(() => editor.commands.setContent({ type: 'doc', content: [boldParagraph, { type: 'table', content: [{
      type: 'tableRow', content: [{ type: 'tableCell', content: [
        { type: 'bulletList', content: [{ type: 'listItem', content: [boldParagraph] }] },
      ] }],
    }] }] }))
    const before = editor.getJSON()
    const markdown = editor.getMarkdown()
    expect(markdown).toContain('<strong>重点。</strong>接下来')
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    expect(editor.getJSON()).toEqual(before)
  })

  it('preserves blank lines in a cell code block and following content', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({ type: 'doc', content: [{ type: 'table', content: [{
      type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'first\n\nsecond\n<third> & &#10;' }] }] },
        { type: 'tableCell', content: [paragraph('neighbor')] },
      ],
    }] }, paragraph('after table')] }))
    const before = editor.getJSON()
    for (let i = 0; i < 2; i++) {
      const markdown = editor.getMarkdown()
      expect(markdown).toContain('first&#10;&#10;second')
      act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
      expect(editor.getJSON()).toEqual(before)
    }
  })
})
