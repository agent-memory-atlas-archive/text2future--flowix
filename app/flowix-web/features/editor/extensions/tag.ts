import { Mark, mergeAttributes } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { isValidTagPath } from '@/lib/tag-path'
import { forEachTextblock, updateTextblockDecorations, type DocumentRange } from './shared/textblock-ranges'

const TAG_REGEX = /(?<=^|\n|\s)#((?:(?:[-_]|[^/\s\p{P}])+\/)*(?:[-_]|[^/\s\p{P}])+)/gu

export function createTagDecorations(
  state: { doc: ProseMirrorNode },
  ranges: readonly DocumentRange[] = [{ from: 0, to: state.doc.content.size }],
): DecorationSet {
  const decorations: Decoration[] = []
  forEachTextblock(state.doc, ranges, (block, blockPos) => {
    if (block.type.name === 'codeBlock') return
    let plainText = ''
    const charToPM: number[] = []
    const appendSep = (ch: string) => {
      if (plainText.length === 0) return
      charToPM.push(-1)
      plainText += ch
    }
    const hasCodeMark = (
      node: { marks: ReadonlyArray<{ type: { name: string } }> },
    ) => node.marks.some((mark) => mark.type.name === 'code')

    block.descendants((node, relativePos) => {
      const pos = blockPos + 1 + relativePos
      if (node.isText && node.text) {
        if (hasCodeMark(node)) {
          appendSep('\n')
          return true
        }
        for (let index = 0; index < node.text.length; index += 1) {
          charToPM.push(pos + index)
        }
        plainText += node.text
      } else if (node.isBlock) {
        appendSep('\n')
        if (node.type.name === 'codeBlock') return false
      } else if (node.isLeaf) {
        appendSep(' ')
      }
      return true
    })

    for (const match of plainText.matchAll(TAG_REGEX)) {
      if (!isValidTagPath(match[1])) continue
      const fromChar = match.index!
      const toChar = fromChar + match[0].length
      const fromPM = charToPM[fromChar]
      const toPM = charToPM[toChar - 1] + 1
      if (fromPM < 0 || toPM <= 0) continue
      decorations.push(Decoration.inline(fromPM, toPM, { class: 'tag-node' }))
      // Split the live range at `#` so its following gap can be styled without
      // inserting a real space or making the text an atom.
      decorations.push(Decoration.inline(fromPM, fromPM + 1, {
        class: 'tag-node-prefix',
      }))
      decorations.push(Decoration.inline(fromPM + 1, toPM, {
        class: 'tag-node-content',
      }))
    }
  })
  return DecorationSet.create(state.doc, decorations)
}

export const tagDecorationPluginKey = new PluginKey<DecorationSet>('tag-decoration')

export function createTagDecorationPlugin() {
  return new Plugin({
    key: tagDecorationPluginKey,
    state: {
      init: (_, state) => createTagDecorations(state),
      apply: (transaction, value) => updateTextblockDecorations(
        transaction, value, (doc, ranges) => createTagDecorations({ doc }, ranges),
      ),
    },
    props: {
      decorations: (state) => tagDecorationPluginKey.getState(state) ?? DecorationSet.empty,
    },
  })
}

export const Tag = Mark.create({
  name: 'tag',

  parseHTML() {
    return [{ tag: 'span.tag-node' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'tag-node' }), 0]
  },

  addProseMirrorPlugins() {
    return [createTagDecorationPlugin()]
  },
})
