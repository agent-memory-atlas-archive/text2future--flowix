/*
MIT License

Copyright (c) 2025, Tiptap GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Adapted from @tiptap/extension-list ordered-list/utils.ts (MIT).
// Keep Flowix's permissive list continuation behavior without slicing text.
import type { MarkdownLexerConfiguration, MarkdownToken } from '@tiptap/core'
import { OrderedList } from '@tiptap/extension-list'
import { guardListMarkdownTokenizer } from './markdown-list-tokenizer'

// Tabs advance to the next four-column stop. Preserve residual indentation
// when a tab crosses the item's content boundary (e.g. nested code blocks).
function indentationWidth(value: string): number {
  let column = 0
  for (const character of value) column += character === '\t' ? 4 - column % 4 : 1
  return column
}

function removeIndent(line: string, target: number): string {
  let column = 0
  let index = 0
  while (index < line.length && column < target && /\s/u.test(line[index])) {
    column += line[index] === '\t' ? 4 - column % 4 : 1
    index += 1
  }
  return ' '.repeat(Math.max(0, column - target)) + line.slice(index)
}

const ORDERED_LIST_ITEM_REGEX = /^(\s*)(\d+)[.)]\s+(.*)$/

const INDENTED_LINE_REGEX = /^\s/

interface OrderedListItem {
  indent: number
  number: number
  contentLines: string[]
  raw: string
}

function isBlockContentLine(line: string): boolean {
  const trimmedLine = line.trimStart()

  return (
    /^[-+*]\s+/.test(trimmedLine) ||
    /^\d+\.\s+/.test(trimmedLine) ||
    /^>\s?/.test(trimmedLine) ||
    /^```/.test(trimmedLine) ||
    /^~~~/.test(trimmedLine)
  )
}

function splitItemContent(contentLines: string[]): {
  paragraphLines: string[]
  blockLines: string[]
} {
  const paragraphLines: string[] = []
  const blockLines: string[] = []
  let reachedBlockBoundary = false

  contentLines.forEach(line => {
    if (reachedBlockBoundary) {
      blockLines.push(line)
      return
    }

    if (line.trim() === '') {
      reachedBlockBoundary = true
      blockLines.push(line)
      return
    }

    if (paragraphLines.length > 0 && isBlockContentLine(line)) {
      reachedBlockBoundary = true
      blockLines.push(line)
      return
    }

    paragraphLines.push(line)
  })

  return {
    paragraphLines,
    blockLines,
  }
}

function collectOrderedListItems(lines: string[]): [OrderedListItem[], number] {
  const listItems: OrderedListItem[] = []
  let currentLineIndex = 0
  let consumed = 0

  while (currentLineIndex < lines.length) {
    const line = lines[currentLineIndex]
    const match = line.match(ORDERED_LIST_ITEM_REGEX)

    if (!match) {
      break
    }

    const [, indent, number, content] = match
    const indentLevel = indentationWidth(indent)
    const contentIndent = indentationWidth(line.slice(0, line.length - content.length))
    const itemContentLines = [content]
    let nextLineIndex = currentLineIndex + 1
    const itemLines = [line]
    let sawBlankLine = false
    while (nextLineIndex < lines.length) {
      const nextLine = lines[nextLineIndex]
      const nextMatch = nextLine.match(ORDERED_LIST_ITEM_REGEX)
      if (nextMatch) {
        break
      }
      if (nextLine.trim() === '') {
        itemLines.push(nextLine)
        itemContentLines.push('')
        sawBlankLine = true
        nextLineIndex += 1
      } else if (nextLine.match(INDENTED_LINE_REGEX)) {
        itemLines.push(nextLine)
        itemContentLines.push(removeIndent(nextLine, contentIndent))
        nextLineIndex += 1
      } else {
        if (sawBlankLine) {
          break
        }

        itemLines.push(nextLine)
        itemContentLines.push(nextLine)
        nextLineIndex += 1
      }
    }

    listItems.push({
      indent: indentLevel,
      number: parseInt(number, 10),
      contentLines: itemContentLines,
      raw: itemLines.join('\n'),
    })

    consumed = nextLineIndex
    currentLineIndex = nextLineIndex
  }

  return [listItems, consumed]
}

function buildNestedStructure(
  items: OrderedListItem[],
  baseIndent: number,
  lexer: MarkdownLexerConfiguration,
): MarkdownToken[] {
  const result: MarkdownToken[] = []
  let currentIndex = 0

  while (currentIndex < items.length) {
    const item = items[currentIndex]

    if (item.indent === baseIndent) {
      const { paragraphLines, blockLines } = splitItemContent(item.contentLines)
      const mainText = paragraphLines.join('\n').trim()

      const tokens = []
      if (mainText) {
        tokens.push({
          type: 'paragraph',
          raw: mainText,
          tokens: lexer.inlineTokens(mainText),
        })
      }

      const additionalContent = blockLines.join('\n').trim()
      if (additionalContent) {
        const blockTokens = lexer.blockTokens(additionalContent)
        tokens.push(...blockTokens)
      }
      let lookAheadIndex = currentIndex + 1
      const nestedItems = []

      while (lookAheadIndex < items.length && items[lookAheadIndex].indent > baseIndent) {
        nestedItems.push(items[lookAheadIndex])
        lookAheadIndex += 1
      }
      if (nestedItems.length > 0) {
        const nextIndent = Math.min(...nestedItems.map(nestedItem => nestedItem.indent))
        const nestedListItems = buildNestedStructure(nestedItems, nextIndent, lexer)
        tokens.push({
          type: 'list',
          ordered: true,
          start: nestedItems[0].number,
          items: nestedListItems,
          raw: nestedItems.map(nestedItem => nestedItem.raw).join('\n'),
        })
      }

      result.push({
        type: 'list_item',
        raw: item.raw,
        tokens,
      })
      currentIndex = lookAheadIndex
    } else {
      currentIndex += 1
    }
  }

  return result
}

/** Shared by the live editor and background Markdown parser. */
export const FlowixOrderedList = guardListMarkdownTokenizer(OrderedList.extend({
  markdownTokenizer: {
    ...OrderedList.config.markdownTokenizer!,
    tokenize(src, _tokens, lexer) {
      const lines = src.split('\n')
      const [items, consumed] = collectOrderedListItems(lines)
      if (!items.length) return undefined
      const nested = buildNestedStructure(items, items[0].indent, lexer)
      return {
        type: 'list', ordered: true, start: items[0].number,
        items: nested, raw: lines.slice(0, consumed).join('\n'),
      }
    },
  },
}), /^\s*\d{1,9}[.)]\s+/)
