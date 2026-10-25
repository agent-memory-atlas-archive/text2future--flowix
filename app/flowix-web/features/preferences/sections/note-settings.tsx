'use client';

import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { SettingsTabGroup } from '@features/preferences/components/settings-tab-group';

type NoteSettingsTab = 'templates' | 'properties' | 'documentManagement';

class SectionErrorBoundary extends Component<{
  children: ReactNode;
  errorText: string;
  retryText: string;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[NoteSettingsSection] section failed to render:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center" role="alert">
          <p className="text-sm text-[var(--muted-foreground)]">{this.props.errorText}</p>
          <button
            type="button"
            className="text-sm text-[var(--primary)] hover:underline"
            onClick={() => this.setState({ hasError: false })}
          >
            {this.props.retryText}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const TemplatesSection = lazy(() =>
  import('@features/preferences/sections/templates').then((module) => ({ default: module.TemplatesSection })),
);
const DocumentPropertiesSection = lazy(() =>
  import('@features/preferences/sections/document-properties').then((module) => ({
    default: module.DocumentPropertiesSection,
  })),
);
const FileDisplayRulesSection = lazy(() =>
  import('@features/preferences/sections/file-display-rules').then((module) => ({
    default: module.FileDisplayRulesSection,
  })),
);

export function NoteSettingsSection() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<NoteSettingsTab>('templates');
  const tabs: { id: NoteSettingsTab; label: string }[] = [
    { id: 'templates', label: t('preferences.templates.title') },
    { id: 'properties', label: t('preferences.documentProperties.title') },
    { id: 'documentManagement', label: t('preferences.fileManagement.locationAndIndexTitle') },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-6">
      <SettingsTabGroup
        tabs={tabs}
        activeTab={activeTab}
        onActiveTabChange={(id) => setActiveTab(id as NoteSettingsTab)}
        ariaLabel={t('preferences.tabs.noteSettings')}
        listClassName="flex gap-6 border-b border-[var(--divider)]"
        tabClassName="relative -mb-px min-w-0 border-b-2 px-0.5 py-2.5 text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        activeTabClassName="border-[var(--primary)] text-[var(--primary)]"
        inactiveTabClassName="border-transparent text-[color-mix(in_oklch,var(--muted-foreground)_60%,transparent)]"
      >
        <div className={activeTab === 'properties' ? undefined : 'pt-2'}>
          <SectionErrorBoundary
            key={activeTab}
            errorText={t('preferences.noteSettings.loadFailed')}
            retryText={t('preferences.noteSettings.retry')}
          >
            <Suspense
              fallback={(
                <div className="flex min-h-0 flex-1 flex-col space-y-6" aria-busy="true">
                  <div className="flex flex-1 items-center justify-center" role="status" aria-label={t('preferences.general.loading')}>
                    <Loader2 className="size-6 flowix-spin text-[var(--muted-foreground)]" />
                    <span className="sr-only">{t('preferences.general.loading')}</span>
                  </div>
                </div>
              )}
            >
              {activeTab === 'templates' && <TemplatesSection hideSectionHeader />}
              {activeTab === 'properties' && <DocumentPropertiesSection hideSectionHeader />}
              {activeTab === 'documentManagement' && <FileDisplayRulesSection hideSectionHeader />}
            </Suspense>
          </SectionErrorBoundary>
        </div>
      </SettingsTabGroup>
    </div>
  );
}
