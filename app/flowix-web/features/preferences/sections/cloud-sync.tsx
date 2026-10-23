'use client';

import { useEffect, useState } from 'react';
import { Check, Cloud, Info, Loader2 } from 'lucide-react';

import googleLogo from '@/assets/google.svg';
import { errorMessage } from '@/lib/error-message';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { subscribe } from '@platform/tauri/event-bus';
import {
  cloud,
  type CloudProduct,
  type CloudOrder,
  type CloudSubscription,
  type CloudState,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { cn } from '@/lib/utils';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';
import { PiCloudModelsSection } from '@features/preferences/sections/pi-cloud-models-section';
import { useMembershipAccess } from '@features/preferences/public/membership';

function formatStorageCapacity(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let capacity = value;
  let unitIndex = 0;
  while (capacity >= 1024 && unitIndex < units.length - 1) {
    capacity /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(capacity) ? String(capacity) : capacity.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function formatMembershipBytes(value: number): string {
  return value === 0 ? '0 MB' : formatStorageCapacity(value);
}

function formatMembershipDate(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function CloudSyncSection() {
  const { t } = useI18n();
  const { state, loadError: stateLoadError, loading: loadingLoginState, applyState, membershipLoading, membershipError, refreshMembership } = useCloudAccountState();
  const [products, setProducts] = useState<CloudProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [productsLoadError, setProductsLoadError] = useState<string | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [orders, setOrders] = useState<CloudOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersLoadError, setOrdersLoadError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<CloudSubscription[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionsLoadError, setSubscriptionsLoadError] = useState<string | null>(null);
  const [cancelingSubscriptionId, setCancelingSubscriptionId] = useState<string | null>(null);
  const [checkingOrderId, setCheckingOrderId] = useState<string | null>(null);
  const [orderCheckFailedId, setOrderCheckFailedId] = useState<string | null>(null);
  const [resumingOrderId, setResumingOrderId] = useState<string | null>(null);

  const hasPendingOrder = orders.some((order) => order.status === 'pending');
  const storageExpiresAt = state?.membership?.storageExpiresAt ?? state?.membership?.expiresAt;
  const { active: hasMembership, lifetime: hasLifetimeMembership, loading: memberAccessLoading } = useMembershipAccess();
  const membershipProducts = products.filter((product) => {
    if (product.entitlement.features.membership !== true) return false;
    if (product.entitlement.features.lifetime === true) return product.billingType === 'one_time';
    return product.billingType === 'subscription'
      && product.entitlement.duration.unit === 'year'
      && product.entitlement.duration.count === 1;
  });
  const annualMembershipSubscription = subscriptions.find((subscription) =>
    subscription.isAnnualMembership
      && ['active', 'trialing', 'past_due'].includes(subscription.status)
  ) ?? null;

  const loadOrders = async () => {
    if (!state?.authenticated) {
      setOrders([]);
      setOrdersLoadError(null);
      return;
    }
    setOrdersLoading(true);
    setOrdersLoadError(null);
    try {
      setOrders(await cloud.listBillingOrders());
    } catch (error) {
      setOrdersLoadError(errorMessage(error));
    } finally {
      setOrdersLoading(false);
    }
  };

  const loadSubscriptions = async () => {
    if (!state?.authenticated) {
      setSubscriptions([]);
      setSubscriptionsLoadError(null);
      return;
    }
    setSubscriptionsLoading(true);
    setSubscriptionsLoadError(null);
    try {
      setSubscriptions(await cloud.listSubscriptions());
    } catch (error) {
      setSubscriptionsLoadError(errorMessage(error));
    } finally {
      setSubscriptionsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void cloud.listProducts().then((next) => {
      if (active) setProducts(next);
    }).catch((error) => {
      if (active) setProductsLoadError(errorMessage(error));
    }).finally(() => {
      if (active) setProductsLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!state?.authenticated) {
      setOrders([]);
      setOrdersLoadError(null);
      return () => { active = false; };
    }
    setOrdersLoading(true);
    setOrdersLoadError(null);
    void cloud.listBillingOrders().then((next) => {
      if (active) setOrders(next);
    }).catch((error) => {
      if (active) setOrdersLoadError(errorMessage(error));
    }).finally(() => {
      if (active) setOrdersLoading(false);
    });
    return () => { active = false; };
  }, [state?.authenticated, state?.account?.user.id]);

  useEffect(() => {
    let active = true;
    if (!state?.authenticated) {
      setSubscriptions([]);
      setSubscriptionsLoadError(null);
      return () => { active = false; };
    }
    setSubscriptionsLoading(true);
    setSubscriptionsLoadError(null);
    void cloud.listSubscriptions().then((next) => {
      if (active) setSubscriptions(next);
    }).catch((error) => {
      if (active) setSubscriptionsLoadError(errorMessage(error));
    }).finally(() => {
      if (active) setSubscriptionsLoading(false);
    });
    return () => { active = false; };
  }, [state?.authenticated, state?.account?.user.id]);

  const checkOrder = async (orderId: string) => {
    setCheckingOrderId(orderId);
    setOrderCheckFailedId(null);
    try {
      const result = await cloud.checkBillingOrder(orderId);
      await loadOrders();
      if (result.confirmed) {
        const refreshResult = await refreshMembership();
        if (refreshResult === 'refreshed') {
          toast.success(t('preferences.cloud.order.confirmed'));
        } else if (refreshResult === 'failed') {
          toast.error(t('preferences.cloud.order.refreshFailed'));
        }
      } else if (result.checkStatus === 'pending') {
        toast.info(t('preferences.cloud.order.notConfirmed'));
      } else if (result.checkStatus === 'processing') {
        toast.info(t('preferences.cloud.order.processing'));
      } else if (result.checkStatus === 'failed') {
        setOrderCheckFailedId(orderId);
        toast.error(t('preferences.cloud.order.syncFailed'));
      } else if (['unsupported', 'dead_letter'].includes(result.checkStatus)) {
        toast.error(t('preferences.cloud.order.needsReview'));
      } else if (result.checkStatus === 'unavailable') {
        toast.error(t('preferences.cloud.order.unavailable'));
      } else if (result.checkStatus === 'refunded') {
        toast.info(t('preferences.cloud.order.refunded'));
      } else {
        toast.error(t('preferences.cloud.order.unknownResult'));
      }
    } catch (error) {
      setOrderCheckFailedId(orderId);
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setCheckingOrderId(null);
    }
  };

  const resumeCheckout = async (order: CloudOrder) => {
    setResumingOrderId(order.id);
    try {
      const checkout = await cloud.createCheckout(order.productId);
      await openUrl(checkout.checkoutUrl);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      await loadOrders();
      setResumingOrderId(null);
    }
  };

  const cancelAnnualSubscription = async (subscription: CloudSubscription) => {
    if (!window.confirm(t('preferences.cloud.subscription.cancelConfirm'))) return;
    setCancelingSubscriptionId(subscription.id);
    try {
      await cloud.cancelSubscription(subscription.id);
      toast.success(t('preferences.cloud.subscription.cancelSuccess'));
      await loadSubscriptions();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setCancelingSubscriptionId(null);
    }
  };

  const run = async (task: () => Promise<CloudState>) => {
    setBusy(true);
    try {
      const next = await task();
      applyState(next);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const startGoogleSignIn = async () => {
    if (loadingLoginState || busy || state?.authenticated) return;
    setBusy(true);
    try {
      await cloud.startGoogleSignIn();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => subscribe<string>('cloud-google-auth-error', (message) => {
    toast.error(cloudSyncErrorMessage(message, t));
  }), [t]);

  return (
    <div className="space-y-5 pb-8">
      <SectionHeader title={t('preferences.cloud.title')} description={t('preferences.cloud.description')} />

      {(stateLoadError ?? state?.authError) && (
        <p className="break-words text-sm text-[var(--destructive)]">
          {stateLoadError ?? state?.authError}
        </p>
      )}

      {!state?.authenticated ? (
        <Button
          variant="outline"
          className="mx-auto flex h-10 w-[64%] gap-2 rounded-lg bg-[var(--card)]"
          disabled={loadingLoginState || busy}
          onClick={() => void startGoogleSignIn()}
        >
          <img src={googleLogo} alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
          {t('preferences.cloud.googleSignIn')}
        </Button>
      ) : (
        <>
          <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--muted)]">
                <Cloud className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-sm font-medium">
                    {state.account?.user.displayName}
                  </div>
                  {state.membership && <span className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-xs',
                    hasMembership
                      ? 'bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]'
                      : 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]',
                  )}>
                    {hasMembership
                      ? t(hasLifetimeMembership ? 'preferences.cloud.member.lifetimeBadge' : 'preferences.cloud.member.annualBadge')
                      : t('preferences.cloud.member.regular')}
                  </span>}
                  {membershipLoading && (
                    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-[var(--muted-foreground)]">
                      <Loader2 className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
                      {t('preferences.cloud.membershipLoading')}
                    </span>
                  )}
                </div>
                <div className="truncate text-sm text-[var(--muted-foreground)]">
                  {state.account?.user.email}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl text-sm"
                  disabled={busy}
                  onClick={() => void run(() => cloud.logout())}
                >
                  {t('preferences.cloud.logout')}
                </Button>
              </div>
            </div>

            <div className="space-y-3 border-t border-[var(--border)] pt-4">
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                <div className="text-sm font-medium">{t('preferences.cloud.membership')}</div>
                {state.membership && state.membership.quotaBytes > 0 && (
                  <div className="ml-auto flex flex-wrap items-center gap-x-2 text-sm text-[var(--muted-foreground)]">
                    <span>
                      {t('preferences.cloud.usage')} {formatMembershipBytes(state.membership.usedBytes)} / {formatMembershipBytes(state.membership.quotaBytes)}
                    </span>
                    {storageExpiresAt != null && (
                      <>
                        <span aria-hidden="true">｜</span>
                        <span>
                          {t('preferences.cloud.expires')}{' '}
                          {hasLifetimeMembership && new Date(storageExpiresAt).getUTCFullYear() >= 9999
                            ? t('preferences.cloud.lifetime')
                            : formatMembershipDate(storageExpiresAt)}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
              {membershipError && <div className="space-y-2">
                <p className="text-sm text-[var(--destructive)]">{t('preferences.cloud.membershipFailed')}: {membershipError}</p>
                <Button variant="outline" className="px-3" disabled={membershipLoading} onClick={() => void refreshMembership()}>
                  {t('preferences.cloud.retry')}
                </Button>
              </div>}
              {(subscriptionsLoading || subscriptionsLoadError || (
                annualMembershipSubscription && !annualMembershipSubscription.cancelAtPeriodEnd
              )) && (
                <div className="space-y-2">
                  {subscriptionsLoading ? (
                    <div aria-hidden="true" className="h-5 animate-pulse rounded bg-[var(--muted)]" />
                  ) : subscriptionsLoadError ? (
                    <div className="space-y-2">
                      <p className="break-words text-sm text-[var(--destructive)]">
                        {t('preferences.cloud.subscription.loadFailed')}: {subscriptionsLoadError}
                      </p>
                      <Button variant="outline" size="sm" className="rounded-lg" onClick={() => void loadSubscriptions()}>
                        {t('preferences.cloud.retry')}
                      </Button>
                    </div>
                  ) : annualMembershipSubscription && !annualMembershipSubscription.cancelAtPeriodEnd ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-[var(--muted-foreground)]">
                          {t('preferences.cloud.subscription.renewal', {
                            date: annualMembershipSubscription.currentPeriodEnd == null
                              ? t('preferences.cloud.subscription.periodEnd')
                              : formatMembershipDate(annualMembershipSubscription.currentPeriodEnd),
                          })}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        disabled={cancelingSubscriptionId !== null}
                        onClick={() => void cancelAnnualSubscription(annualMembershipSubscription)}
                      >
                        {cancelingSubscriptionId === annualMembershipSubscription.id
                          ? t('preferences.cloud.subscription.canceling')
                          : t('preferences.cloud.subscription.cancel')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          <PiCloudModelsSection authenticated />

          {(ordersLoading || ordersLoadError || orders.length > 0) && (
            <div className="space-y-3">
              {ordersLoading ? (
                <div aria-hidden="true" className="h-5 w-24 animate-pulse rounded bg-[var(--muted)]" />
              ) : (
                <div className="text-sm font-medium">{t('preferences.cloud.order.title')}</div>
              )}
              {ordersLoading ? (
                <div aria-hidden="true" className="h-20 animate-pulse rounded-xl bg-[var(--muted)]" />
              ) : (
                <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
                  {ordersLoadError ? (
                    <div className="space-y-2">
                      <p className="break-words text-sm text-[var(--destructive)]">{ordersLoadError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        disabled={ordersLoading}
                        onClick={() => void loadOrders()}
                      >
                        {t('preferences.cloud.retry')}
                      </Button>
                    </div>
                  ) : (
                    <ul className="divide-y divide-[var(--border)]">
                      {orders.map((order) => {
                        const checkable = ['pending', 'paid'].includes(order.status);
                        const statusLabel = order.status === 'pending'
                          ? t('preferences.cloud.order.status.pending')
                          : order.status === 'paid'
                          ? t('preferences.cloud.order.status.paid')
                          : order.status === 'expired'
                          ? t('preferences.cloud.order.status.expired')
                          : order.status === 'refunded'
                          ? t('preferences.cloud.order.status.refunded')
                          : t('preferences.cloud.order.status.unknown');

                        return (
                          <li key={order.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-[var(--foreground)]">{order.productName}</div>
                              <div className="mt-1 text-sm text-[var(--muted-foreground)]">
                                {new Date(order.createdAt).toLocaleString()} · {new Intl.NumberFormat(undefined, {
                                  style: 'currency', currency: order.currency.toUpperCase(),
                                }).format(order.amount / 100)}
                              </div>
                            </div>
                            {checkable && (
                              <Tooltip content={t('preferences.cloud.order.checkTooltip')}>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="rounded-lg"
                                  disabled={checkingOrderId !== null || resumingOrderId !== null}
                                  onClick={() => void checkOrder(order.id)}
                                >
                                  {checkingOrderId === order.id
                                    ? t('preferences.cloud.order.checking')
                                    : orderCheckFailedId === order.id
                                    ? t('preferences.cloud.retry')
                                    : t('preferences.cloud.order.check')}
                                </Button>
                              </Tooltip>
                            )}
                            {order.status === 'pending' && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="rounded-lg"
                                disabled={checkingOrderId !== null || resumingOrderId !== null}
                                onClick={() => void resumeCheckout(order)}
                              >
                                {resumingOrderId === order.id
                                  ? t('preferences.cloud.order.resumingPayment')
                                  : t('preferences.cloud.order.continuePayment')}
                              </Button>
                            )}
                            <span className={cn(
                              'rounded-md px-1.5 py-0.5 text-xs',
                              order.status === 'paid'
                                ? 'bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]'
                                : 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]',
                            )}>{statusLabel}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {!hasMembership && !memberAccessLoading && !membershipError && (
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium">{t('preferences.cloud.member.title')}</div>
              </div>
              {hasPendingOrder && !productsLoading && (
                <p role="status" className="text-sm text-[var(--muted-foreground)]">
                  {t('preferences.cloud.order.pendingCheckout')}
                </p>
              )}
              {productsLoadError && (
                <p className="break-words text-sm text-[var(--destructive)]">{productsLoadError}</p>
              )}
              {productsLoading ? (
                <div aria-hidden="true" className="h-48 animate-pulse rounded-xl bg-[var(--muted)]" />
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {membershipProducts.map((product) => {
                    const lifetime = product.entitlement.features.lifetime === true;
                    const storageCapacity = formatStorageCapacity(product.entitlement.storageBytes);
                    const [storagePrefix, storageSuffix] = t('preferences.cloud.totalStorage', {
                      capacity: storageCapacity,
                    }).split(storageCapacity);

                    return (
                      <div
                        key={product.id}
                        className="flex h-full min-h-[480px] flex-col rounded-xl border border-[var(--border)] bg-[var(--card)] p-2.5 pt-4 transition-colors hover:border-[var(--primary)]/40 sm:p-3 sm:pt-[18px]"
                      >
                        <div className="min-w-0">
                          <div className="text-[22px] font-semibold leading-7 tracking-tight text-[var(--foreground)]">
                            {lifetime
                              ? t('preferences.cloud.member.lifetimePlan')
                              : t('preferences.cloud.member.yearPlan')}
                          </div>
                        </div>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[var(--foreground)]" style={{ fontFamily: 'ui-monospace' }}>
                          <span className="text-[32px] font-normal leading-10 tracking-tight tabular-nums">
                            {new Intl.NumberFormat(undefined, {
                              style: 'currency', currency: product.price.currency.toUpperCase(),
                            }).format(product.price.amount / 100)}
                          </span>
                          {!lifetime && (
                            <span className="text-sm leading-5 text-[var(--muted-foreground)]">
                              {t('preferences.cloud.pricePeriod.yearly')}
                            </span>
                          )}
                        </div>
                        <div className="my-5 border-t border-[var(--border)]" />
                        <div className="mb-3 text-sm font-medium leading-5 text-[var(--foreground)]">
                          {t('preferences.cloud.plan.includes')}
                        </div>
                        <ul className="space-y-2.5 text-sm leading-5 text-[var(--muted-foreground)]">
                          <li className="flex items-start gap-1.5">
                            <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                            <span>
                              {storagePrefix}<span className="font-medium text-[var(--brand)]">{storageCapacity}</span>{storageSuffix}
                            </span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                            <span>{t('preferences.cloud.unlimitedSyncedNotebooks')}</span>
                          </li>
                          <li className="flex items-start gap-1.5">
                            <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                            <span>{t('preferences.cloud.maximumFileSize', { size: '5 MB' })}</span>
                          </li>
                          {(['memberThemes', 'piByok', 'localAgents', 'mcpCli', 'earlyAccess'] as const).map((benefit) => (
                            <li key={benefit} className="flex items-start gap-1.5">
                              <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                              <span>{t(`preferences.cloud.plan.benefit.${benefit}`)}</span>
                              {benefit === 'localAgents' && (
                                <div className="-ml-1.5">
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        type="button"
                                        aria-label={t('preferences.cloud.plan.benefit.localAgentsInfo')}
                                        className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                                      >
                                        <Info className="h-3 w-3" aria-hidden="true" />
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent side="top" align="center" className="max-w-[240px] px-3 py-2 text-sm leading-5">
                                      {t('preferences.cloud.plan.benefit.localAgentsInfo')}
                                    </PopoverContent>
                                  </Popover>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                        <div className="mt-auto pt-5">
                          <Button
                            size="lg"
                            className="h-10 w-full rounded-xl bg-[var(--brand)] text-base font-medium text-[var(--primary-foreground)] hover:bg-[color-mix(in_oklch,var(--brand)_90%,black)]"
                            disabled={busy || membershipLoading || memberAccessLoading || ordersLoading || ordersLoadError !== null || hasPendingOrder}
                            onClick={() => {
                              if (busy || membershipLoading || memberAccessLoading || ordersLoading || ordersLoadError !== null || hasPendingOrder) return;
                              setBusy(true);
                              void cloud.createCheckout(product.id)
                                .then((checkout) => openUrl(checkout.checkoutUrl))
                                .catch((error) => toast.error(cloudSyncErrorMessage(error, t)))
                                .finally(async () => {
                                  await loadOrders();
                                  setBusy(false);
                                });
                            }}
                          >
                            {busy ? t('preferences.cloud.working') : t('preferences.cloud.member.purchase')}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {!productsLoadError && membershipProducts.length === 0 && (
                    <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.cloud.member.unavailable')}</p>
                  )}
                </div>
              )}
            </div>
          )}


        </>
      )}
    </div>
  );
}
