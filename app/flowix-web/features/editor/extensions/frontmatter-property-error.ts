import { type I18nKey, type I18nParams } from '@/lib/i18n';
import { FrontmatterPropertyError } from '@features/document/properties/frontmatter-model';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** Single source of truth for surfacing frontmatter validation failures. */
export function describeFrontmatterPropertyError(error: unknown, t: Translate): string {
  if (!(error instanceof FrontmatterPropertyError)) {
    return error instanceof Error ? error.message : String(error);
  }
  switch (error.code) {
    case 'empty-key':
      return t('document.properties.emptyKey');
    case 'duplicate-key':
      return t('document.properties.duplicateKey');
    case 'reserved-key':
      return t('document.properties.picker.reservedKeyError', { key: 'flowix_property_types' });
    case 'invalid-tag':
      return t('document.properties.invalidTag');
    case 'invalid-color':
      return t('document.properties.invalidColor');
    default:
      return error.message;
  }
}
