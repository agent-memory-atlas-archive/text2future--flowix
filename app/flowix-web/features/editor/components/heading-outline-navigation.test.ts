import { describe, expect, it } from 'vitest'
import {
  extractHeadings,
  filterHeadingsForOutline,
  getNavigationActiveElement,
  calculateHeadingOutlinePopoverPosition,
  type HeadingItem,
} from './heading-outline-navigation'

describe('extractHeadings', () => {
  it('extracts H1-H4 in document order', () => {
    const root = document.createElement('div')
    root.innerHTML = '<h1>Title</h1><p>Text</p><h3>Section</h3><h4>Detail</h4>'

    expect(extractHeadings(root).map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'Title' },
      { level: 3, text: 'Section' },
      { level: 4, text: 'Detail' },
    ])
  })

  it('ignores headings inside embedded editor nodes', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="agent-thread-card"><h2>Agent heading</h2></div>
      <div class="frontmatter-property-node"><h3>Property heading</h3></div>
      <h2>Document heading</h2>
    `

    expect(extractHeadings(root).map(({ text }) => text)).toEqual(['Document heading'])
  })

  it('does not include H5-H6', () => {
    const root = document.createElement('div')
    root.innerHTML = '<h1>Included</h1><h5>Ignored</h5><h6>Ignored</h6>'

    expect(extractHeadings(root).map(({ text }) => text)).toEqual(['Included'])
  })
})

describe('filterHeadingsForOutline', () => {
  const heading = (level: 1 | 2 | 3 | 4, index: number): HeadingItem => ({
    element: document.createElement(`h${level}`),
    level,
    text: `${level}-${index}`,
  })

  it('keeps all headings when there are at most 30', () => {
    const headings = Array.from({ length: 30 }, (_, index) => heading(4, index))

    expect(filterHeadingsForOutline(headings)).toBe(headings)
  })

  it('omits H4 before considering H3', () => {
    const headings = [
      ...Array.from({ length: 10 }, (_, index) => heading(1, index)),
      ...Array.from({ length: 10 }, (_, index) => heading(2, index)),
      ...Array.from({ length: 5 }, (_, index) => heading(3, index)),
      ...Array.from({ length: 10 }, (_, index) => heading(4, index)),
    ]

    const visible = filterHeadingsForOutline(headings)

    expect(visible).toHaveLength(25)
    expect(visible.every(({ level }) => level !== 4)).toBe(true)
    expect(visible.some(({ level }) => level === 3)).toBe(true)
  })

  it('omits H3 after H4 when the outline is still too long', () => {
    const headings = [
      ...Array.from({ length: 10 }, (_, index) => heading(1, index)),
      ...Array.from({ length: 10 }, (_, index) => heading(2, index)),
      ...Array.from({ length: 15 }, (_, index) => heading(3, index)),
      ...Array.from({ length: 5 }, (_, index) => heading(4, index)),
    ]

    const visible = filterHeadingsForOutline(headings)

    expect(visible).toHaveLength(20)
    expect(visible.every(({ level }) => level === 1 || level === 2)).toBe(true)
  })

  it('retains H1 and H2 even when they alone exceed the limit', () => {
    const headings = Array.from({ length: 31 }, (_, index) => heading(index % 2 === 0 ? 1 : 2, index))

    const visible = filterHeadingsForOutline(headings)

    expect(visible).toHaveLength(31)
    expect(visible).toEqual(headings)
  })

  it('falls back to the nearest visible heading when the active heading is hidden', () => {
    const h2 = heading(2, 0)
    const h3 = heading(3, 1)
    const h4 = heading(4, 2)
    const allHeadings = [h2, h3, h4]

    expect(getNavigationActiveElement(allHeadings, [h2], h4.element)).toBe(h2.element)
  })
})

describe('calculateHeadingOutlinePopoverPosition', () => {
  it('keeps the popup inside the current editor surface', () => {
    const position = calculateHeadingOutlinePopoverPosition(
      { left: 0, right: 600, top: 50, bottom: 850, width: 600, height: 800 },
      253,
      400,
      1000,
      900,
    )

    expect(position.left).toBe(339)
    expect(position.top).toBe(96)
    expect(position.maxWidth).toBe(253)
    expect(position.maxHeight).toBe(720)
  })

  it('repositions independently when the browser column owns the editor', () => {
    const position = calculateHeadingOutlinePopoverPosition(
      { left: 600, right: 1000, top: 50, bottom: 850, width: 400, height: 800 },
      253,
      400,
      1000,
      900,
    )

    expect(position.left).toBe(739)
    expect(position.top).toBe(96)
    expect(position.maxWidth).toBe(253)
  })
})
