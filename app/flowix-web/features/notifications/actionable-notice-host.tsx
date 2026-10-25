'use client';

import { useSyncExternalStore } from 'react';
import { AlertCircle, AlertTriangle, Info, Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import {
  dismissActionableNotice,
  getActionableNotices,
  runActionableNoticeAction,
  subscribeActionableNotices,
} from './actionable-notice-store';

const EMPTY_NOTICES: ReturnType<typeof getActionableNotices> = [];

export function ActionableNoticeHost() {
  const { t } = useI18n();
  const notices = useSyncExternalStore(
    subscribeActionableNotices,
    getActionableNotices,
    () => EMPTY_NOTICES,
  );
  if (notices.length === 0) return null;

  return (
    // 注意: 这个宿主既是定位盒也是 overflow-y-auto 滚动裁剪盒。
    // 卡片用的是 shadow-xl (底部扩散可达 ~40px), 若容器没有足够内边距,
    // 阴影会落在 padding box 之外被直接裁掉。所以这里留一圈内边距:
    //   - p-4 (16px) 给左右/顶部阴影留空间;
    //   - pb-8 (32px) 底部再多给一些, 因为投影向下偏移最明显;
    //   - top-4 + pt-4 = 32px, 让卡片视觉顶边仍停在原来的 top-8 位置。
    <div
      className="pointer-events-none fixed left-1/2 top-4 z-[var(--layer-notice)] flex max-h-[calc(100vh-4rem)] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2 overflow-y-auto p-4 pb-8"
      data-actionable-notice-host
      role="region"
      aria-label={t('notifications.actionable.region')}
    >
      {notices.map((notice, index) => {
        const Icon = notice.tone === 'error' ? AlertCircle : notice.tone === 'warning' ? AlertTriangle : Info;
        const working = notice.busyActionId !== null && notice.busyActionId !== undefined;
        return (
          <section
            key={notice.id}
            role={notice.tone === 'neutral' ? 'status' : 'alert'}
            aria-live={index === 0 && notice.tone !== 'neutral' ? 'assertive' : 'polite'}
            className={`pointer-events-auto w-full ${notice.width === 'wide' ? '' : notice.width === 'narrow' ? 'max-w-[24rem]' : 'max-w-[36rem]'} animate-in slide-in-from-top-2 fade-in duration-[var(--floating-motion-fast)] rounded-xl border bg-[var(--card)] px-4 py-3 text-sm text-[var(--foreground)] [box-shadow:var(--floating-shadow-actionable)] ${notice.tone === 'error' ? 'border-destructive/30' : notice.tone === 'warning' ? 'border-[color-mix(in_oklch,var(--warning)_30%,transparent)]' : 'border-[var(--border)]'}`}
          >
            <div className="flex items-center gap-3">
              {notice.leadingIcon === 'loading' || working
                ? <Loader2 className="h-4 w-4 shrink-0 flowix-spin text-[var(--primary)]" aria-hidden="true" />
                : <Icon className={`h-4 w-4 shrink-0 ${notice.tone === 'error' ? 'text-destructive' : notice.tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--muted-foreground)]'}`} aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <strong className="block font-semibold">{notice.title}</strong>
                {/* 副文案最多 1 行, 超出省略。 */}
                {notice.message && <p className="mt-1 line-clamp-1 whitespace-pre-line break-words text-[var(--muted-foreground)]">{notice.message}</p>}
                {notice.actionError && <p className="mt-1 break-words text-destructive">{notice.actionError}</p>}
              </div>
              {/* 动作按钮固定放在右侧, 垂直居中于整条通知。 */}
              {notice.actions.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-center">
                  {notice.actions.map((action) => (
                    <Button
                      key={action.id}
                      type="button"
                      size="sm"
                      variant={action.variant ?? 'default'}
                      className="rounded-lg"
                      disabled={working}
                      onClick={() => void runActionableNoticeAction(notice.id, action.id)}
                    >
                      {working && notice.busyActionId === action.id
                        ? t('notifications.actionable.working')
                        : action.label}
                    </Button>
                  ))}
                </div>
              )}
              {notice.dismissible && !notice.actions.some((action) => action.id === 'hide') && (
                <button
                  type="button"
                  className="-mr-1 grid h-7 w-7 shrink-0 place-items-center self-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  disabled={working}
                  onClick={() => dismissActionableNotice(notice.id)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
