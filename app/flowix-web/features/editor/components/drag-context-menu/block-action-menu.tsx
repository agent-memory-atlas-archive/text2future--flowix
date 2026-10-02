import { Fragment, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Kbd } from '@shared/ui/shortcut-kbd'
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator'
import { useSelectedItemScroll } from '@features/editor/extensions/shared/use-selected-item-scroll'
import type { BlockMenuAction } from '@features/editor/components/drag-context-menu/block-menu-actions'

interface BlockActionMenuProps {
  actions: BlockMenuAction[]
  selectedIndex: number
  mouseHoverEnabled: boolean
  menuRef: (node: HTMLDivElement | null) => void
  style: CSSProperties
  onHover: (index: number) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  ariaLabel?: string
}

export function BlockActionMenu({
  actions,
  selectedIndex,
  mouseHoverEnabled,
  menuRef,
  style,
  onHover,
  onKeyDown,
  ariaLabel = 'Block actions',
}: BlockActionMenuProps) {
  const { scrollerRef, itemRefs } = useSelectedItemScroll({
    items: actions,
    selectedIndex,
  })

  const handleItemMouseMove = (
    event: MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.movementX === 0 && event.movementY === 0) return
    onHover(index)
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      className="fixed z-[150] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      style={{ ...style, outline: 'none' }}
    >
      <div ref={scrollerRef}>
        {actions.map((action, index) => {
          return (
            <Fragment key={action.id}>
              {index > 0 && actions[index - 1]?.group !== action.group && (
                <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
              )}
              <button
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                type="button"
                role={action.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={action.checked}
                onMouseMove={(event) => handleItemMouseMove(event, index)}
                onClick={action.onSelect}
                className={`group relative flex h-7 min-h-7 w-full items-center justify-start gap-3 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] transition-colors${mouseHoverEnabled ? ' hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]' : ''}${index === selectedIndex ? ' bg-[var(--brand)] text-[var(--primary-foreground)]' : ''}`}
                style={{ outline: 'none', boxShadow: 'none' }}
              >
                {action.icon}
                <span className="min-w-0 flex-1">{action.label}</span>
                {action.shortcut && (
                  <Kbd
                    chord={action.shortcut}
                    className={`shrink-0 ${index === selectedIndex ? 'text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]'}`}
                  />
                )}
                {action.trailingIcon && (
                  <span
                    className={`ml-auto shrink-0 ${index === selectedIndex ? 'text-[var(--primary-foreground)]' : 'text-[var(--brand)] group-hover:text-[var(--primary-foreground)]'}`}
                  >
                    {action.trailingIcon}
                  </span>
                )}
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
