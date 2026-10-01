'use client';

import { useI18n } from '@/lib/i18n';
import { SectionHeader } from './primitives';
import { FileManagementSection } from './file-management';

export function FileDisplayRulesSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SectionHeader title={t('preferences.fileDisplayRules.title')} />
      <FileManagementSection />
    </div>
  );
}
