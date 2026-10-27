'use client';

import { useEffect, useRef } from 'react';

import { subscribeUncaughtErrors } from '@/lib/global-error';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

/** 同一个错误连续抛出时只提示一次，避免一个坏循环刷屏。 */
const DUPLICATE_WINDOW_MS = 3_000;

/**
 * 把全局未捕获错误变成用户可见的提示。
 *
 * 挂载在 I18nProvider 内、AppToaster 旁边；错误详情只进日志，
 * 提示文案固定走 i18n，不把原始 message 直接打给用户。
 */
export function GlobalErrorToaster(): null {
  const { t } = useI18n();
  const lastRef = useRef<{ message: string; at: number }>({ message: '', at: 0 });

  useEffect(() => subscribeUncaughtErrors((report) => {
    const now = Date.now();
    const last = lastRef.current;
    if (last.message === report.message && now - last.at < DUPLICATE_WINDOW_MS) return;
    lastRef.current = { message: report.message, at: now };
    toast.error(t('error.unexpected'));
  }), [t]);

  return null;
}
