'use client';

import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChevronRight, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Textarea } from '@shared/ui/textarea';
import { I18nProvider, useI18n, type AppLanguage } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { piModels, windows } from '@platform/tauri/client';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';

/** Shared exit-animation duration from `@shared/ui/dialog` (EXIT_ANIMATION_MS). */
const DIALOG_EXIT_MS = 320;

function SettingsToggleRow({
  label,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm">
      <span className="min-w-0 truncate text-[var(--foreground)]">{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={onToggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--card)] shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}

function PiSettingsDialogBody({ onRequestClose }: { onRequestClose: () => void }) {
  const { t } = useI18n();

  // System prompt — UI-only placeholder for now; not persisted anywhere.
  // IME-safe controlled pattern (see shared/ui/textarea.tsx): keep a draft while
  // composing so Chinese input is not duplicated, commit on composition end.
  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemPromptDraft, setSystemPromptDraft] = useState<string | null>(null);

  // Code mode — mirrors features/preferences/sections/pi.tsx.
  const codeMode = useAgentDataStore((state) => state.agents.pi.user.mode === 'code');
  const modeLoad = useAgentDataStore((state) => state.loadState.piMode);
  const modeLoaded = modeLoad.status === 'ready';
  const initializePiMode = useAgentDataStore((state) => state.initializePiMode);

  // Tool search — mirrors features/preferences/sections/pi.tsx.
  const [toolSearch, setToolSearch] = useState(false);
  const [featuresLoading, setFeaturesLoading] = useState(true);
  const [featuresSaving, setFeaturesSaving] = useState(false);
  const [featuresError, setFeaturesError] = useState<string | null>(null);

  useEffect(() => {
    void initializePiMode().catch(() => undefined);
  }, [initializePiMode]);

  useEffect(() => {
    let cancelled = false;
    void piModels.getFeatures()
      .then((value) => { if (!cancelled) setToolSearch(value.toolSearch); })
      .catch((error) => {
        if (!cancelled) setFeaturesError(friendlyErrorMessage(error, t, 'errors.friendly.piLoad'));
      })
      .finally(() => { if (!cancelled) setFeaturesLoading(false); });
    return () => { cancelled = true; };
  }, [t]);

  const toggleCodeMode = () => {
    if (!modeLoaded) return;
    useAgentDataStore.getState().setUserPreference('pi', { mode: codeMode ? 'writing' : 'code' });
  };

  const toggleToolSearch = async () => {
    const next = !toolSearch;
    setToolSearch(next);
    setFeaturesSaving(true);
    try {
      await piModels.saveFeatures({ toolSearch: next });
    } catch (error) {
      setToolSearch(!next);
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.piSave'));
    } finally {
      setFeaturesSaving(false);
    }
  };

  const openMcpPreferences = () => {
    onRequestClose();
    void windows.openPreferences('pi');
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('agent.tools.settings')}</DialogTitle>
      </DialogHeader>
      <div className="mt-2 space-y-4">
        <div className="space-y-1.5">
          <label
            htmlFor="pi-settings-system-prompt"
            className="text-sm font-medium text-[var(--foreground)]"
          >
            {t('preferences.pi.systemPrompt')}
          </label>
          <Textarea
            id="pi-settings-system-prompt"
            className="min-h-[96px] bg-[var(--muted)]"
            value={systemPromptDraft ?? systemPrompt}
            onChange={(event) => setSystemPromptDraft(event.target.value)}
            onCompositionStart={() => setSystemPromptDraft((draft) => draft ?? systemPrompt)}
            onCompositionEnd={(event) => {
              setSystemPromptDraft(null);
              setSystemPrompt(event.currentTarget.value);
            }}
            onBlur={() => {
              if (systemPromptDraft !== null) setSystemPrompt(systemPromptDraft);
              setSystemPromptDraft(null);
            }}
          />
        </div>

        <div className="space-y-2">
          {featuresError && (
            <p role="alert" className="text-xs text-[var(--destructive)]">{featuresError}</p>
          )}
          {modeLoad.status === 'loading' ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm">
              <span className="text-[var(--foreground)]">{t('preferences.pi.codeMode')}</span>
              <Loader2 className="size-4 flowix-spin text-[var(--muted-foreground)]" />
            </div>
          ) : (
            <SettingsToggleRow
              label={t('preferences.pi.codeMode')}
              checked={codeMode}
              disabled={!modeLoaded}
              onToggle={toggleCodeMode}
            />
          )}
          <SettingsToggleRow
            label={t('preferences.pi.toolSearch')}
            checked={toolSearch}
            disabled={featuresLoading || featuresSaving || Boolean(featuresError)}
            onToggle={() => void toggleToolSearch()}
          />
        </div>

        <button
          type="button"
          onClick={openMcpPreferences}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
        >
          <span className="min-w-0 truncate">{t('preferences.pi.mcp.title')}</span>
          <ChevronRight className="size-4 shrink-0 text-[var(--muted-foreground)]" />
        </button>
      </div>
    </>
  );
}

function PiSettingsDialogRoot({
  language,
  dispose,
}: {
  language: AppLanguage;
  dispose: () => void;
}) {
  const [open, setOpen] = useState(true);

  // Let the shared Dialog play its exit animation before tearing down the root.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(dispose, DIALOG_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, dispose]);

  return (
    <I18nProvider language={language}>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[420px] !max-w-[calc(100vw-2rem)]">
          <PiSettingsDialogBody onRequestClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </I18nProvider>
  );
}

/**
 * Imperatively mounts the Pi settings dialog from non-React callers (the empty
 * state controller). Mirrors `NotebookAgentSettingsDialogController`.
 */
export class PiSettingsDialogController {
  private container: HTMLDivElement | null = null;
  private root: Root | null = null;

  open(language: AppLanguage): void {
    this.close();
    const container = document.createElement('div');
    container.dataset.piSettingsDialog = 'true';
    document.body.append(container);
    this.container = container;
    this.root = createRoot(container);
    this.root.render(
      <PiSettingsDialogRoot language={language} dispose={() => this.close()} />,
    );
  }

  close(): void {
    this.root?.unmount();
    this.root = null;
    this.container?.remove();
    this.container = null;
  }
}
