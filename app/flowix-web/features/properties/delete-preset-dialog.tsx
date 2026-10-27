'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { PropertyFieldConfig } from './types';

interface DeletePresetDialogProps {
  /** When non-null, the dialog is open and confirming will delete this preset. */
  preset: PropertyFieldConfig | null;
  /** Number of tables that reference the field; shown in the description. */
  tableCount: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A preset deletion removes its note property from every note and table.
 */
export function DeletePresetDialog({ preset, tableCount, busy = false, onCancel, onConfirm }: DeletePresetDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={!!preset} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('preferences.documentProperties.deleteChoiceTitle').replace('{key}', preset?.key ?? '')}</DialogTitle>
          <DialogDescription>{t('preferences.documentProperties.deleteDescription').replace('{count}', String(tableCount))}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex h-[38px] flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--destructive)] bg-[var(--destructive)] px-3 py-0 text-center text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-sm text-white">{t('preferences.documentProperties.deleteConfirmAction')}</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="inline-flex h-[38px] items-center justify-center rounded-lg px-3 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('preferences.documentProperties.cancel')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
