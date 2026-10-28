import { useI18n } from '@/lib/i18n';
import { boot } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { useWorkspaceStartupStore } from '@/lib/store/workspace-startup-store';

interface NativeStartupStatus {
  phase: string;
  stage: string;
  step: string;
  error: string | null;
}

interface WorkspaceStartupStatus {
  status: string;
  error: string | null;
}

/**
 * Full-viewport failure overlay for native and workspace startup errors,
 * with the corresponding retry actions. Kept outside the business barrier so
 * it renders even while the rest of the layout is inert.
 */
export function MainLayoutStartupFailureOverlay({
  startupStatus,
  workspaceStartup,
}: {
  startupStatus: NativeStartupStatus;
  workspaceStartup: WorkspaceStartupStatus;
}) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[var(--frame-bg)]">
      {startupStatus.phase === 'failed' ? (
        <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center text-sm text-[var(--muted-foreground)]" role="alert">
          {t(startupStatus.stage === 'workspacePreparation'
            ? 'memo.navigation.workspacePreparationFailed'
            : 'memo.navigation.startupMigrationFailed')}
          {startupStatus.error && <span className="max-h-40 overflow-auto break-words">{startupStatus.error}</span>}
          <Button size="sm" className="rounded-lg" onClick={() => {
            void boot.retryStartup().then(() => window.location.reload()).catch((error) => {
              useWorkspaceStartupStore.setState({ nativeError: String(error) });
            });
          }}>{t('error.retry')}</Button>
        </div>
      ) : (
        <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center" role="alert">
          <span className="text-sm text-[var(--muted-foreground)]">{t(workspaceStartup.status === 'failed'
            ? 'memo.navigation.workspacePreparationFailed'
            : 'memo.list.loadFailed')}</span>
          {workspaceStartup.error && <span className="max-h-40 overflow-auto break-words text-sm text-[var(--muted-foreground)]">{workspaceStartup.error}</span>}
          <Button size="sm" className="rounded-lg" onClick={() => window.location.reload()}>{t('error.retry')}</Button>
        </div>
      )}
    </div>
  );
}
