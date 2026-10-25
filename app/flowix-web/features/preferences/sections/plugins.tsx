'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FolderOpen, Power, RefreshCw, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import { dialogs, plugins, type PluginDescriptor, type PluginDiagnostic } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { SectionHeader } from './primitives';
import { useI18n } from '@/lib/i18n';

export function PluginsSection() {
  const { t } = useI18n();
  const [items, setItems] = useState<PluginDescriptor[]>([]);
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostic[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await plugins.catalog();
      setItems(snapshot.plugins);
      setDiagnostics(snapshot.diagnostics);
      setError(null);
    } catch (loadError) {
      setError(friendlyErrorMessage(loadError, t, 'errors.friendly.pluginLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const install = async () => {
    const source = await dialogs.selectDirectory();
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const candidate = await plugins.validate(source);
      const capabilitySummary = candidate.permissions.length > 0
        ? t('preferences.plugins.capabilities', { capabilities: candidate.permissions.join('、') })
        : '';
      if (!window.confirm(t('preferences.plugins.installConfirm', {
        name: candidate.manifest.name,
        capabilities: capabilitySummary,
      }))) return;
      await plugins.install(source);
      await load();
    } catch (installError) {
      setError(friendlyErrorMessage(installError, t, 'errors.friendly.pluginInstall'));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (plugin: PluginDescriptor) => {
    setBusy(true);
    setError(null);
    try {
      await plugins.setEnabled(plugin.manifest.id, !plugin.enabled);
      await load();
    } catch (toggleError) {
      setError(friendlyErrorMessage(toggleError, t, plugin.enabled ? 'errors.friendly.pluginDisable' : 'errors.friendly.pluginEnable'));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (plugin: PluginDescriptor) => {
    if (plugin.isSystem || !window.confirm(t('preferences.plugins.uninstallConfirm', { name: plugin.manifest.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.uninstall(plugin.manifest.id);
      await load();
    } catch (uninstallError) {
      setError(friendlyErrorMessage(uninstallError, t, 'errors.friendly.pluginRemove'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('preferences.plugins.title')}
        description={t('preferences.plugins.description')}
      />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void install()}>
          <FolderOpen className="mr-1.5 h-4 w-4" />{t('preferences.plugins.install')}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" />{t('preferences.plugins.refresh')}
        </Button>
      </div>
      {error && <p className="rounded-md bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] p-3 text-xs text-[var(--destructive)]">{error}</p>}
      {loading && items.length === 0 && !error && (
        <p className="flex h-24 items-center justify-center text-sm text-[var(--muted-foreground)]" role="status" aria-busy="true">
          {t('preferences.plugins.loading')}
        </p>
      )}
      {!loading && items.length === 0 && !error && (
        <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.plugins.empty')}</p>
      )}
      <div className="space-y-2" aria-busy={loading}>
        {items.map((plugin) => (
          <div key={plugin.manifest.id} className="flex items-center justify-between rounded-lg border border-[var(--divider)] bg-[var(--card)] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
                <span className="truncate">{plugin.manifest.name}</span>
                {plugin.isSystem && <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">{t('preferences.plugins.builtIn')}</span>}
                {!plugin.enabled && <span className="rounded bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-1.5 py-0.5 text-[10px] text-[var(--warning)]">{t('preferences.plugins.disabled')}</span>}
                {plugin.integrityStatus === 'verified'
                  ? <span className="flex items-center gap-1 rounded bg-[color-mix(in_oklch,var(--success)_10%,transparent)] px-1.5 py-0.5 text-[10px] text-[var(--success)]" title={t('preferences.plugins.integrityVerifiedHint')}><ShieldCheck className="h-3 w-3" />{t('preferences.plugins.integrityVerified')}</span>
                  : <span className="flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]" title={t('preferences.plugins.integrityMissingHint')}><ShieldQuestion className="h-3 w-3" />{t('preferences.plugins.integrityMissing')}</span>}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]">{plugin.manifest.id} · v{plugin.manifest.version}</p>
              <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">{t('preferences.plugins.capabilityLabel', { capabilities: plugin.permissions.join('、') })}</p>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" disabled={busy || (plugin.isSystem && plugin.enabled)} onClick={() => void setEnabled(plugin)} aria-label={plugin.enabled ? t('preferences.plugins.disable') : t('preferences.plugins.enable')} title={plugin.enabled ? t('preferences.plugins.disable') : t('preferences.plugins.enable')}>
                <Power className={`h-4 w-4 ${plugin.enabled ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'}`} />
              </Button>
              {!plugin.isSystem && <Button variant="ghost" size="icon" disabled={busy} onClick={() => void uninstall(plugin)} aria-label={t('preferences.plugins.uninstall')} title={t('preferences.plugins.uninstall')} className="text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--destructive)]"><Trash2 className="h-4 w-4" /></Button>}
            </div>
          </div>
        ))}
      </div>
      {diagnostics.some((item) => item.status === 'invalid') && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-[var(--warning)]"><AlertTriangle className="h-4 w-4" />{t('preferences.plugins.invalidTitle')}</h3>
          {diagnostics.filter((item) => item.status === 'invalid').map((item) => (
            <div key={item.path} className="rounded-lg border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] p-3">
              <p className="truncate text-xs text-[var(--foreground)]">{item.path}</p>
              <p className="mt-1 text-xs text-[var(--warning)]">{item.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
