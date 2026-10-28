import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client';
import { openPath } from '@platform/tauri/opener';
import { Button } from '@shared/ui/button';

/**
 * Banner shown at the top of the work column right after a document export,
 * offering quick access to the exported file.
 */
export function MainLayoutExportNotice({
  recentExportPath,
  onDismiss,
}: {
  recentExportPath: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-x-0 top-0 z-50 flex h-[50px] items-center justify-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--card)_78%,transparent)] px-4 backdrop-blur-md">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-lg"
        onClick={() => {
          void product.revealInFileManager(recentExportPath).catch(() => {
            toast.error(t('memo.fileTree.openFailed'));
          });
        }}
      >
        {t('document.exportNotice.openFolder')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-lg"
        onClick={() => {
          void openPath(recentExportPath).catch(() => {
            toast.error(t('memo.fileTree.openFailed'));
          });
        }}
      >
        {t('memo.fileTree.openDefaultApp')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-lg"
        onClick={onDismiss}
        aria-label={t('document.exportNotice.close')}
        title={t('document.exportNotice.close')}
      >
        {t('document.exportNotice.close')}
      </Button>
    </div>
  );
}
