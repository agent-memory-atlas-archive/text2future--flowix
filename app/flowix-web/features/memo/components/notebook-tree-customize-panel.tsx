import { useImperativeHandle, useState, type Ref } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { NotebookTreeCustomizeList } from './notebook-tree-customize-list';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { DialogHeader, DialogTitle } from '@shared/ui/dialog';
import type { NotebookTreeHiddenSection, NotebookTreeSection } from './use-notebook-tree-sections';

export interface NotebookTreeCustomizePanelHandle { open: (rect: DOMRect) => void }

export function NotebookTreeCustomizePanel({ ref, sectionOrder, hiddenSections, onChange }: {
  ref: Ref<NotebookTreeCustomizePanelHandle>;
  sectionOrder: NotebookTreeSection[];
  hiddenSections: NotebookTreeHiddenSection[];
  onChange: (order: NotebookTreeSection[], hidden: NotebookTreeHiddenSection[]) => void;
}) {
  const { t } = useI18n();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizeAnchorRect, setCustomizeAnchorRect] = useState<DOMRect | null>(null);
  useImperativeHandle(ref, () => ({ open(anchorRect: DOMRect) {
    setCustomizeAnchorRect(anchorRect);
    setCustomizeOpen(true);
  } }), []);
  return (
      <Popover open={customizeOpen} onOpenChange={setCustomizeOpen} anchorRect={customizeAnchorRect}>
        <PopoverContent side="bottom" align="start" sideOffset={0} alignToAnchorOrigin keepParentMenuOpen className="w-[190px] max-w-[calc(100vw-16px)] rounded-2xl p-[5px] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader className="mb-0 flex min-h-8 flex-row items-center justify-between px-1">
            <button type="button" aria-label="返回上一级菜单" title="返回上一级菜单" onClick={() => setCustomizeOpen(false)} className="inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="min-w-0 truncate text-xs leading-[1.2]">{t('memo.fileTree.customizeDisplay')}</span>
            </button>
            <DialogTitle className="sr-only">{t('memo.fileTree.customizeDisplay')}</DialogTitle>
          </DialogHeader>
          <NotebookTreeCustomizeList sectionOrder={sectionOrder} hiddenSections={hiddenSections} onChange={onChange} />
        </PopoverContent>
      </Popover>
  );
}
