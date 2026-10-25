'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  cloud,
  piModels,
  type PiProviderConfig,
} from '@platform/tauri/client';
import { cloudModelAccessErrorMessage } from '@platform/tauri/errors';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { refreshAgentModelCatalog } from '@features/agent/services/agent-catalog-service';
import { Button } from '@shared/ui/button';

const FLOWIX_CLOUD_SOURCE = 'flowix-cloud';

export function PiCloudModelsSection({ authenticated }: { authenticated: boolean }) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<PiProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const balanceRequest = useRef(0);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setProviders(await piModels.list());
    } catch (value) {
      setError(friendlyErrorMessage(value, t, 'errors.friendly.modelsRefresh'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void reload(); }, [reload]);

  const refreshBalance = useCallback(async (notifyError = false) => {
    const request = ++balanceRequest.current;
    if (!authenticated) {
      setBalance(null);
      setBalanceError(null);
      setBalanceLoading(false);
      return;
    }
    setBalanceLoading(true);
    try {
      const result = await cloud.getAiCreditBalance();
      if (request !== balanceRequest.current) return;
      setBalance(Math.ceil(result.balanceMicrocredits / 1_000_000));
      setBalanceError(null);
    } catch (value) {
      if (request !== balanceRequest.current) return;
      const message = friendlyErrorMessage(value, t, 'errors.friendly.balanceLoad');
      setBalanceError(message);
      if (notifyError) toast.error(message);
    } finally {
      if (request === balanceRequest.current) setBalanceLoading(false);
    }
  }, [authenticated, t]);

  useEffect(() => {
    void refreshBalance();
    return () => { balanceRequest.current += 1; };
  }, [refreshBalance, t]);

  const refreshBalanceAndModels = useCallback(async () => {
    setModelCatalogLoading(true);
    try {
      const refreshModels = async () => {
        await cloud.refreshPiModelProvider();
        await refreshAgentModelCatalog('pi');
      };
      const [, modelCatalogResult] = await Promise.allSettled([
        refreshBalance(true),
        refreshModels(),
      ]);
      if (modelCatalogResult.status === 'rejected') {
        toast.error(friendlyErrorMessage(modelCatalogResult.reason, t, 'errors.friendly.modelsRefresh'));
      }
    } finally {
      setModelCatalogLoading(false);
    }
  }, [refreshBalance, t]);

  const provider = providers.find((item) => item.source === FLOWIX_CLOUD_SOURCE);
  const connect = async () => {
    setBusy(true);
    try {
      await cloud.connectPiModelProvider();
      await reload();
      await refreshAgentModelCatalog('pi');
      toast.success(t('preferences.pi.cloudConnected'));
    } catch (value) {
      toast.error(cloudModelAccessErrorMessage(value, t, 'errors.friendly.cloudConnect'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-[var(--foreground)]">{t('preferences.pi.cloudTitle')}</div>
      <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        {error && <p className="text-xs text-[var(--destructive)]">{error}</p>}

        {authenticated && <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-[var(--foreground)]" title={balanceError ?? undefined}>
            {t('preferences.pi.cloudCreditsBalance')}: <span className="font-semibold">
              {balance === null
                ? balanceLoading ? t('preferences.pi.cloudCreditsLoading') : t('preferences.pi.cloudCreditsUnavailable')
                : `${balance.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} ${t('preferences.pi.cloudCreditsUnit')}`}
            </span>
          </div>
          <Button type="button" variant="ghost" className="h-8" disabled={balanceLoading || modelCatalogLoading} onClick={() => void refreshBalanceAndModels()}>
            {(balanceLoading || modelCatalogLoading) && <Loader2 className="mr-2 size-3.5 flowix-spin" />}
            {t('preferences.pi.cloudCreditsRefresh')}
          </Button>
        </div>}

        {!provider && <div className="flex justify-end">
          <Button type="button" variant="outline" className="h-8" disabled={!authenticated || loading || busy} onClick={() => void connect()}>
            {(loading || busy) && <Loader2 className="mr-2 size-3.5 flowix-spin" />}
            {t('preferences.pi.cloudConnect')}
          </Button>
        </div>}
      </section>
    </div>
  );
}
