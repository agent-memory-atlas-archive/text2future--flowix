import type { I18nKey, I18nParams } from '@/lib/i18n';
import { errorMessage } from './error-message';

import { createLogger } from '@/lib/logger';
const logger = createLogger('lib/friendly-error-message');
type Translate = (key: I18nKey, params?: I18nParams) => string;

/** Keep diagnostics in logs and show only localized, actionable copy in the UI. */
export function friendlyErrorMessage(error: unknown, t: Translate, fallback: I18nKey): string {
  logger.warn('friendly message fallback', { fallback, error });
  // These operations may have committed before a later step failed
  if (['errors.friendly.tableCreateLink', 'errors.friendly.taskCreate', 'errors.friendly.mediaAdd',
    'errors.friendly.presetSync', 'errors.friendly.collectionPartial', 'errors.friendly.historyRestoredRefresh'].includes(fallback)) {
    return t(fallback);
  }
  const message = errorMessage(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const details = `${code} ${message}`;
  if (['errors.friendly.connectionTest', 'errors.friendly.modelsDiscover'].includes(fallback)
    && /\b(?:AUTH_FAILED|INVALID_API_KEY)\b|\b(?:HTTP|status|API error)\s*401\b|invalid api.?key|authentication failed/i.test(details)) {
    return t('errors.friendly.invalidKey');
  }
  if (/\b(?:ETIMEDOUT|TIMEOUT|TIMED_OUT)\b|\btimed? out\b/i.test(details)) {
    return t('errors.friendly.timeout');
  }
  if (/\b(?:RATE_LIMITED|BILLING_RATE_LIMITED|rate_limited)\b|\b(?:HTTP|status|cloud API error)\s*429\b/i.test(details)) {
    return t('errors.friendly.rateLimited');
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|NETWORK_ERROR)\b|failed to fetch|network request failed|error sending request|network is unreachable/i.test(details)) {
    return t('errors.friendly.network');
  }
  return t(fallback);
}
