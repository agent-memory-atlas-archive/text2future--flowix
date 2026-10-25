'use client';

import { useEffect, useState } from 'react';
import { Input } from '@shared/ui/input';
import { Button } from '@shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import {
  getNotebookIconOption,
  NotebookIcon,
} from '@features/memo/components/notebook-icon';
import {
  NOTEBOOK_CREATE_PAGE_GUTTER_CLASS,
  NotebookCreateFooter,
  NotebookCreateForm,
} from '@features/memo/components/notebook-create-form';
import { NotebookIconPicker } from '@features/memo/components/notebook-icon-picker';
import type { Notebook } from '@features/memo/store/note-store';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { CloudNotebook } from '@platform/tauri/client';
import {
  ArrowLeft,
  Check,
  CloudDownload,
  Loader2,
} from 'lucide-react';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { isMac } from '@features/shortcuts';
import { OnboardingTitlebarMac } from '@features/onboarding/onboarding-titlebar-mac';
import { useNotebookTemplates } from '@features/onboarding/notebook-templates';
import { NotebookTemplatePicker } from '@features/onboarding/notebook-template-picker';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPath: string;
  newNotebookDefaultPath: string;
  newNotebookIcon: string | null;
  onNewNotebookIconChange: (icon: string | null) => void;
  newNotebookTemplateId: string | null;
  onNewNotebookTemplateIdChange: (templateId: string | null) => void;
  isCreatingNotebook: boolean;
  cloudSyncAvailable: boolean;
  createMode: 'create' | 'cloud';
  remoteNotebooks: CloudNotebook[];
  remoteNotebooksLoading: boolean;
  remoteNotebookSyncingId: string | null;
  onOpenRemoteNotebooks: () => void;
  onBackToCreate: () => void;
  onSelectRemoteNotebook: (notebook: CloudNotebook) => void;
  onSelectDirectory: () => Promise<void>;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  editingNotebook: Notebook | null;
  editNotebookName: string;
  onEditNotebookNameChange: (name: string) => void;
  editNotebookIcon: string | null;
  onEditNotebookIconChange: (icon: string | null) => void;
  editNotebookCloudSync: boolean;
  onEditNotebookCloudSyncChange: (enabled: boolean) => void;
  onEditNotebookCloudSyncUnavailable: () => void;
  editSaving: boolean;
  editNotebookCloudSyncChanged: boolean;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
}

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

function NotebookCloudSyncToggle({
  checked,
  available,
  disabled = false,
  onChange,
  onUnavailableClick,
}: {
  checked: boolean;
  available: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  onUnavailableClick?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{t('notebook.cloudSync.title')}</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          {available
            ? t('notebook.cloudSync.description')
            : t('notebook.cloudSync.unavailable')}
        </div>
      </div>
      {!available && onUnavailableClick ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-lg"
          onClick={onUnavailableClick}
        >
          {t('preferences.cloud.accountSettings')}
        </Button>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={t('notebook.cloudSync.title')}
          disabled={!available || disabled}
          onClick={() => onChange(!checked)}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            checked ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--card)] shadow-sm transition-transform',
              checked ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      )}
    </div>
  );
}

export function NotebookDialogs({
  createOpen,
  onCreateOpenChange,
  newNotebookName,
  onNewNotebookNameChange,
  newNotebookPath,
  newNotebookDefaultPath,
  newNotebookIcon,
  onNewNotebookIconChange,
  newNotebookTemplateId,
  onNewNotebookTemplateIdChange,
  isCreatingNotebook,
  cloudSyncAvailable,
  createMode,
  remoteNotebooks,
  remoteNotebooksLoading,
  remoteNotebookSyncingId,
  onBackToCreate,
  onSelectRemoteNotebook,
  onSelectDirectory,
  onConfirmCreate,
  onCancelCreate,
  editOpen,
  onEditOpenChange,
  editingNotebook,
  editNotebookName,
  onEditNotebookNameChange,
  editNotebookIcon,
  onEditNotebookIconChange,
  editNotebookCloudSync,
  onEditNotebookCloudSyncChange,
  onEditNotebookCloudSyncUnavailable,
  editSaving,
  editNotebookCloudSyncChanged,
  onConfirmEdit,
  onCancelEdit,
}: NotebookDialogsProps) {
  const { t } = useI18n();
  const experimental = useExperimentalMode();
  const {
    templates: notebookTemplates,
    status: notebookTemplateStatus,
    retry: retryNotebookTemplates,
  } = useNotebookTemplates(createOpen && createMode === 'create');
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false);

  useEffect(() => {
    if (createOpen && createMode === 'create') setIsTemplatePickerOpen(false);
  }, [createMode, createOpen]);

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent
          showCloseButton={false}
          aria-busy={isCreatingNotebook}
          aria-labelledby={createMode === 'create' ? 'flowix-create-notebook-form-title' : undefined}
          className="!fixed !inset-0 !z-[130] !flex !h-dvh !max-h-none !w-full !max-w-none !flex-col !overflow-hidden !rounded-none !bg-[var(--frame-bg)] !p-0 !text-[var(--foreground)] !shadow-none [--onboarding-ink:var(--foreground)] [--onboarding-subtle:var(--muted-foreground)] [--onboarding-panel:color-mix(in_oklch,var(--card)_96%,var(--background))] [--onboarding-line:color-mix(in_oklch,var(--border)_78%,transparent)] [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--ring)] [&_button:focus-visible]:outline-offset-[3px]"
        >
          {isMac() && <OnboardingTitlebarMac />}
          <WindowsTitlebarControls reserveSpace />
          <main className={cn(
            'relative z-[1] flex min-h-0 w-full flex-1 flex-col overflow-hidden',
            createMode === 'create'
              ? `${NOTEBOOK_CREATE_PAGE_GUTTER_CLASS} pb-[clamp(22px,3vw,44px)] max-[760px]:pb-[26px]`
              : 'p-0',
          )}>
            <div className={cn(
              'mx-auto flex min-h-0 w-full flex-1 flex-col overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              createMode === 'create' ? 'max-w-[680px]' : 'max-w-[780px] pb-[104px]',
            )}>
              <section className={`w-full py-[clamp(11px,1.33vw,16px)] pb-4 ${createMode === 'create' ? 'flex min-h-full flex-col justify-center' : ''}`}>
                {createMode === 'cloud' ? (
                  <>
                    <div className="max-w-full">
                      <button
                        type="button"
                        onClick={onBackToCreate}
                        className="mb-[15px] inline-flex items-center gap-[7px] p-0 text-xs text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)]"
                        aria-label={t('notebook.cloudImport.back')}
                        title={t('notebook.cloudImport.back')}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        {t('notebook.cloudImport.back')}
                      </button>
                      <h1 className="text-[clamp(23px,3.33vw,44px)] font-light leading-[0.98] tracking-[-0.065em] text-[var(--onboarding-ink)]">{t('notebook.cloudImport.title')}</h1>
                    </div>
                    <div className="mt-[22px] w-full max-w-[780px]">
                      {remoteNotebooksLoading ? (
                        <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                          <Loader2 className="h-4 w-4 flowix-spin" />
                          {t('notebook.cloudImport.loading')}
                        </div>
                      ) : remoteNotebooks.length === 0 ? (
                        <div className="flex min-h-[180px] items-center justify-center text-sm text-[var(--muted-foreground)]">
                          {t('notebook.cloudImport.empty')}
                        </div>
                      ) : (
                        <div className="max-h-[min(55vh,560px)] space-y-2 overflow-y-auto pr-1">
                          {remoteNotebooks.map((notebook) => {
                            const syncing = remoteNotebookSyncingId === notebook.id;
                            return (
                              <div
                                key={notebook.id}
                                className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5"
                              >
                                <NotebookIcon
                                  name={notebook.name}
                                  icon={notebook.icon ?? undefined}
                                  className="h-8 w-8 shrink-0 rounded-md bg-[var(--muted)] text-xs font-semibold"
                                />
                                <span className="min-w-0 flex-1 truncate text-sm">{notebook.name}</span>
                                {notebook.synced ? (
                                  <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--muted-foreground)]">
                                    <Check className="h-3.5 w-3.5" />
                                    {t('notebook.cloudImport.synced')}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={remoteNotebookSyncingId !== null}
                                    onClick={() => onSelectRemoteNotebook(notebook)}
                                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {syncing ? (
                                      <Loader2 className="h-4 w-4 flowix-spin" />
                                    ) : (
                                      <CloudDownload className="h-4 w-4" />
                                    )}
                                    {t('notebook.cloudImport.sync')}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <NotebookCreateForm
                    title="新建笔记本"
                    formId="flowix-create-notebook-form"
                    name={newNotebookName}
                    onNameChange={onNewNotebookNameChange}
                    nameLabel={t('notebook.create.namePlaceholder')}
                    namePlaceholder={t('notebook.create.namePlaceholder')}
                    pathLabel={t('notebook.create.pathLabel')}
                    path={newNotebookPath || newNotebookDefaultPath}
                    pathPlaceholder={t('notebook.create.pathPlaceholder')}
                    directoryButtonLabel={t('notebook.create.selectDirectory')}
                    onSelectDirectory={() => void onSelectDirectory()}
                    icon={newNotebookIcon}
                    onIconChange={onNewNotebookIconChange}
                    templates={notebookTemplates}
                    selectedTemplateId={newNotebookTemplateId}
                    onSelectTemplate={() => setIsTemplatePickerOpen(true)}
                    disabled={isCreatingNotebook}
                    onSubmit={onConfirmCreate}
                  />
                )}
              </section>
            </div>
            {createMode === 'create' ? (
              <NotebookCreateFooter
                formId="flowix-create-notebook-form"
                disabled={!newNotebookName.trim()}
                isBusy={isCreatingNotebook}
                cancelLabel={t('notebook.create.cancel')}
                onCancel={onCancelCreate}
              />
            ) : (
              <div className="absolute bottom-0 left-0 z-[4] m-0 flex min-h-20 w-full items-center justify-end border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] px-[clamp(28px,6vw,96px)] pb-[calc(16px+env(safe-area-inset-bottom))] pt-4 max-[600px]:flex-wrap max-[600px]:gap-2 max-[600px]:px-5 max-[600px]:pb-[calc(12px+env(safe-area-inset-bottom))] max-[600px]:pt-3">
                <div className="mx-auto flex w-full max-w-[780px] items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onCancelCreate}
                    disabled={isCreatingNotebook}
                    className="inline-flex h-8 min-h-8 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-transparent px-[15px] text-xs font-medium text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:opacity-50"
                  >
                    {t('notebook.create.cancel')}
                  </button>
                </div>
              </div>
            )}
            {createMode === 'create' && isTemplatePickerOpen && (
              <NotebookTemplatePicker
                templates={notebookTemplates}
                status={notebookTemplateStatus}
                retry={retryNotebookTemplates}
                initialTemplateId={newNotebookTemplateId}
                onCancel={() => setIsTemplatePickerOpen(false)}
                onComplete={(templateId) => {
                  onNewNotebookTemplateIdChange(templateId);
                  setIsTemplatePickerOpen(false);
                }}
              />
            )}
          </main>
        </DialogContent>
      </Dialog>
      <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
        <DialogContent className="w-[390px] !max-w-[calc(100vw-2rem)]" aria-busy={editSaving}>
          <DialogHeader>
            <DialogTitle>{t("notebook.edit.title")}</DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <div className="min-w-0 space-y-3">
              <Input
                placeholder={t("notebook.edit.namePlaceholder")}
                value={editNotebookName}
                disabled={editSaving}
                onChange={(event) => onEditNotebookNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onConfirmEdit();
                }}
                autoFocus
                className="h-10"
              />
              <NotebookIconPicker
                value={editNotebookIcon}
                notebookName={editNotebookName}
                onChange={onEditNotebookIconChange}
                disabled={editSaving}
              />
              <div className="space-y-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {t("notebook.edit.pathLabel")}
                </div>
                <div
                  className="flex h-10 w-full items-center truncate rounded-lg border border-input bg-[var(--muted)] px-3 text-sm text-[var(--muted-foreground)] select-all"
                  title={editingNotebook?.path ?? ''}
                >
                  {editingNotebook?.path ?? ''}
                </div>
              </div>
              {experimental && (
                <NotebookCloudSyncToggle
                  checked={editNotebookCloudSync}
                  available={cloudSyncAvailable}
                  disabled={editSaving}
                  onChange={onEditNotebookCloudSyncChange}
                  onUnavailableClick={onEditNotebookCloudSyncUnavailable}
                />
              )}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            {editingNotebook ? (
              <button
                type="button"
                disabled={editSaving}
                onClick={() => {
                  if (!editingNotebook) return;
                  const target = editingNotebook;
                  // 复用 main-layout 已有的 NotebookDeleteDialog:
                  // 先关掉当前弹窗, 再派发全局事件打开删除确认。
                  onCancelEdit();
                  window.dispatchEvent(
                    new CustomEvent<Notebook>('flowix:request-delete-notebook', { detail: target })
                  );
                }}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] hover:bg-transparent hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
              >
                {t("notebook.edit.remove")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={editSaving}
                className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("notebook.edit.cancel")}
              </button>
              <button
                type="button"
                onClick={onConfirmEdit}
                className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                disabled={
                  editSaving ||
                  !editNotebookName.trim() ||
                  (editNotebookName.trim() === editingNotebook?.name &&
                    (editNotebookIcon ?? '') === (normalizeNotebookIconId(editingNotebook?.icon) ?? '') &&
                    !editNotebookCloudSyncChanged)
                }
              >
                {editSaving && <Loader2 className="mr-1.5 inline-block h-3.5 w-3.5 flowix-spin" />}
                {editSaving ? t("notebook.edit.saving") : t("notebook.edit.confirm")}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
