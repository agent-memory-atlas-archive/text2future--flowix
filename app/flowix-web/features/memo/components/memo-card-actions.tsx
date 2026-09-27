'use client';

import { Check } from 'lucide-react';
import {
  CopyIcon,
  FolderOpenIcon,
  LinkSimpleIcon,
  PushPin,
  SquareSplitHorizontalIcon,
  StackSimpleIcon,
  TrashSimpleIcon,
} from '@phosphor-icons/react';
import { useContext } from 'react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client';
import { memoDocumentOperations } from '@features/document/public/file-operations-api';
import { useI18n, translate, type AppLanguage, type I18nKey } from '@/lib/i18n';
import {
  ContextMenuContext,
} from '@shared/ui/context-menu';
import {
  DropdownMenuContext,
} from '@shared/ui/dropdown-menu';
import {
  MEMO_COLORS,
  MEMO_COLOR_HEX,
  useMemoStore,
} from '@features/memo/store/memo-store';
import type { MemoItem, MemoColor } from '@/types/memo-item';
import { resolveMemoSessionPath } from '@features/memo/use-cases/open-memo-session';

// Minimal contract every shadcn-style item primitive in this app satisfies:
// it accepts an onClick, a className, and renders children. Both
// `DropdownMenuItem` and `ContextMenuItem` match this, so we can render the
// same actions inside either menu without forking the JSX.
export interface MenuItemComponent {
  (props: {
    onClick?: () => void;
    className?: string;
    children: React.ReactNode;
  }): React.ReactElement | null;
}

interface MemoCardActionsProps {
  memo: MemoItem;
  /** Use the tree item's authoritative path when this menu is rendered there. */
  filePath?: string;
  onFavoriteToggle: (memo: MemoItem) => void;
  onDelete: (memo: MemoItem) => void;
  onColorsChange?: (memo: MemoItem, colors: MemoColor[]) => void;
  /**
   * Opens the memo in the browser column. Optional because the menu is also
   * rendered where a split target makes no sense; the item hides when absent.
   */
  onOpenInSplit?: (memo: MemoItem) => void;
  Item: MenuItemComponent;
}

const ITEM_BASE =
  "h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]";
const POPUP_DIVIDER_CLASS = 'mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60';

// Inline color grid that lives at the top of the memo card right-click menu.
// Visually matches the popup above the document titlebar (same swatch order,
// same transparent "no color" cell, same 28px height and 6px gap, same check
// overlay for the active color). Like the titlebar picker, the row is width
// constrained by the menu so swatches shrink horizontally instead of overflowing.
// Clicking any swatch
// (including the no-color cell) calls `onChange` and closes the surrounding
// menu — the picker is single-shot, not a sticky submenu.
const COLOR_LABEL_KEYS: Record<MemoColor, I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

export function getMemoColorLabel(color: MemoColor, language: AppLanguage): string {
  return translate(language, COLOR_LABEL_KEYS[color]);
}

// Close-on-select helper used by the inline color row. The row is rendered
// inside either a `ContextMenuContent` or `DropdownMenuContent`; both expose
// a `setOpen` setter on their context. Picking whichever is active keeps the
// component menu-agnostic — callers don't need to wire a close callback.
function useCloseActiveMenu(): () => void {
  const ctxMenu = useContext(ContextMenuContext);
  const dropMenu = useContext(DropdownMenuContext);
  return () => {
    if (ctxMenu) ctxMenu.setOpen(false);
    else if (dropMenu) dropMenu.setOpen(false);
  };
}

// Clipboard helper. Mirrors `useDocumentCommands::writeClipboardText` so the
// "copy link" / "copy full text" actions behave identically when invoked
// from the memo card right-click menu vs. the document titlebar menu.
async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

interface MemoCardColorRowProps {
  colors: MemoColor[];
  onChange: (next: MemoColor[]) => void;
}

function MemoCardColorRow({ colors, onChange }: MemoCardColorRowProps) {
  const { t, language } = useI18n();
  const closeActiveMenu = useCloseActiveMenu();
  const selected = new Set(colors);

  const apply = (next: Set<MemoColor>) => {
    onChange(MEMO_COLORS.filter((c) => next.has(c)));
    closeActiveMenu();
  };

  const toggle = (c: MemoColor) => {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    apply(next);
  };

  const clear = () => apply(new Set());

  return (
    <div
      role="group"
      aria-label={t('document.color.button')}
      className="flex h-7 w-full items-center gap-1 px-2"
    >
      <button
        type="button"
        aria-label={t('document.color.noColorTooltip')}
        aria-pressed={colors.length === 0}
        title={t('document.color.clear')}
        onClick={clear}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        className={cn(
          'relative h-4 w-7 rounded-md border bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
          colors.length === 0
            ? 'border-[var(--muted-foreground)]'
            : 'border-[var(--border)] hover:border-[var(--muted-foreground)]',
        )}
      />
      {MEMO_COLORS.map((c) => {
        const isSelected = selected.has(c);
        return (
          <button
            key={c}
            type="button"
            aria-label={getMemoColorLabel(c, language)}
            aria-pressed={isSelected}
            onClick={() => toggle(c)}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              'relative h-4 w-7 rounded-md transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
              isSelected ? 'opacity-100' : 'opacity-50',
            )}
            style={{ backgroundColor: MEMO_COLOR_HEX[c] }}
          >
            {isSelected && (
              <Check
                aria-hidden="true"
                strokeWidth={3}
                className="pointer-events-none absolute inset-0 m-auto h-2.5 w-2.5 text-white opacity-70"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function MemoCardActions({
  memo,
  filePath,
  onFavoriteToggle,
  onDelete,
  onColorsChange,
  onOpenInSplit,
  Item,
}: MemoCardActionsProps) {
  const { t } = useI18n();

  // Resolve the on-disk path the same way `openMemoSession` does, so the
  // memo-card menu's "copy link" / "copy full text" target the same file
  // the titlebar's commands would when the memo is actively open.
  const resolvePath = () => {
    const notebook = useMemoStore.getState().selectedNotebook;
    return resolveMemoSessionPath(memo, notebook);
  };

  const handleCopyLink = async () => {
    const path = resolvePath();
    if (!path) return;
    try {
      await writeClipboardText(path);
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      console.warn('[MemoCardActions] copy link failed', error);
      toast.error(t('document.command.copyFailed'));
    }
  };

  const handleCopyFullText = async () => {
    const path = resolvePath();
    if (!path) return;
    try {
      const content = await memoDocumentOperations.read({ path, scopePath: null, memoId: memo.id });
      await writeClipboardText(content ?? '');
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      console.warn('[MemoCardActions] copy full text failed', error);
      toast.error(t('document.command.copyFailed'));
    }
  };

  const handleRevealInFileManager = () => {
    const path = filePath ?? resolvePath();
    if (!path) return;
    void product.revealInFileManager(path).catch((error) => {
      console.warn('[MemoCardActions] reveal in file manager failed', error);
      toast.error(t('memo.fileTree.openFailed'));
    });
  };

  // Properties are owned by the application-level host. Requesting them must
  // not navigate the work column or change the currently-open memo.
  const handleOpenProperties = () => {
    window.dispatchEvent(
      new CustomEvent('flowix:open-note-properties', {
        detail: { memoId: memo.id },
      }),
    );
  };

  return (
    <>
      {onOpenInSplit && (
        <>
          <Item onClick={() => onOpenInSplit(memo)} className={ITEM_BASE}>
            <SquareSplitHorizontalIcon className="w-4 h-4 mr-2" /> {t('memo.action.openInSplit')}
          </Item>
        </>
      )}
      <Item onClick={() => onFavoriteToggle(memo)} className={ITEM_BASE}>
        {memo.favorited ? (
          <>
            <PushPin weight="fill" className="w-4 h-4 mr-2" /> {t('memo.action.unpin')}
          </>
        ) : (
          <>
            <PushPin className="w-4 h-4 mr-2" /> {t('memo.action.pin')}
          </>
        )}
      </Item>
      <Item onClick={handleOpenProperties} className={ITEM_BASE}>
        <StackSimpleIcon className="w-4 h-4 mr-2" /> {t('document.action.properties')}
      </Item>
      <Item onClick={handleCopyLink} className={ITEM_BASE}>
        <LinkSimpleIcon className="w-4 h-4 mr-2" /> {t('document.action.copyLink')}
      </Item>
      <Item onClick={handleCopyFullText} className={ITEM_BASE}>
        <CopyIcon className="w-4 h-4 mr-2" /> {t('document.action.copyFullText')}
      </Item>
      <Item onClick={handleRevealInFileManager} className={ITEM_BASE}>
        <FolderOpenIcon className="w-4 h-4 mr-2" /> {t('memo.fileTree.reveal')}
      </Item>
      <div role="separator" aria-hidden="true" className={POPUP_DIVIDER_CLASS} />
      {onColorsChange && (
        <MemoCardColorRow
          colors={memo.colors}
          onChange={(next) => onColorsChange(memo, next)}
        />
      )}
      <div role="separator" aria-hidden="true" className={POPUP_DIVIDER_CLASS} />
      <Item
        onClick={() => onDelete(memo)}
        className={cn(ITEM_BASE, 'hover:bg-transparent hover:text-[var(--destructive)]')}
      >
        <TrashSimpleIcon className="w-4 h-4 mr-2" /> {t('memo.action.delete')}
      </Item>
    </>
  );
}
