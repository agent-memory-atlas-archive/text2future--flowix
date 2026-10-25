'use client';

import { Dialog, DialogContent } from '@shared/ui/dialog';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { ProductIntroContent } from '@features/product-intro/product-intro-content';

export interface ProductIntroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 产品介绍弹窗 —— 内容全部来自 ProductIntroContent, 这里只负责弹窗外壳。 */
export function ProductIntroDialog({ open, onOpenChange }: ProductIntroDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-none !rounded-2xl !border !border-[var(--border-popup)] !bg-[var(--card)] !p-0 shadow-[0_16px_64px_-12px_rgb(0_0_0_/_0.35)] w-[calc(100vw-2rem)] sm:w-[60vw] h-[min(84vh,900px)] overflow-hidden">
        <OverlayScrollbar className="h-full w-full" scrollerClassName="h-full">
          <ProductIntroContent />
        </OverlayScrollbar>
      </DialogContent>
    </Dialog>
  );
}
