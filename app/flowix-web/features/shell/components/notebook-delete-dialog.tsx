'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';

interface NotebookDeleteDialogProps {
  /** When non-null, the dialog is open and confirming will delete this notebook. */
  target: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: (deleteLocalFiles: boolean) => void;
}

/**
 * Confirmation dialog for deleting a notebook.
 *
 * Local notebook files are kept unless the user explicitly checks the option.
 */
export function NotebookDeleteDialog({ target, onCancel, onConfirm }: NotebookDeleteDialogProps) {
  const { t } = useI18n();
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('notebook.delete.title')}</DialogTitle>
          <DialogDescription>{t('notebook.delete.description')}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-[var(--foreground)]">
            <FlowixCheckbox
              checked={deleteLocalFiles}
              aria-label={t('notebook.delete.deleteLocalFiles')}
              onCheckedChange={setDeleteLocalFiles}
            />
            <span className="cursor-pointer" onClick={() => setDeleteLocalFiles((checked) => !checked)}>{t('notebook.delete.deleteLocalFiles')}</span>
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(deleteLocalFiles)}
              className="h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90"
            >
              {t('dialog.delete')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
