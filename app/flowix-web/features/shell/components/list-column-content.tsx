'use client';

import type { ReactNode } from 'react';

import { MemoListViewTabs, type MemoListViewTab } from '@features/memo/components/memo-list-view-tabs';
import { useI18n } from '@/lib/i18n';
import { ListSurfaceLoadingState } from '@shared/ui/list-surface';

interface ListColumnContentProps {
  activeView: MemoListViewTab;
  onViewChange: (view: MemoListViewTab) => void;
  navigationDrawerOpen: boolean;
  onToggleNavigationDrawer: () => void;
  conversationLoading: boolean;
  children: ReactNode;
}

/** Stable ListColumn view switcher and its replaceable list surfaces. */
export function ListColumnContent({
  activeView,
  onViewChange,
  navigationDrawerOpen,
  onToggleNavigationDrawer,
  conversationLoading,
  children,
}: ListColumnContentProps) {
  const { t } = useI18n();

  return (
    <div className="relative h-full min-h-0 bg-[var(--list-bg)]">
      <div className="absolute left-3 top-0 z-30">
        <MemoListViewTabs
          activeTab={activeView}
          onChange={onViewChange}
          navigationDrawerEnabled
          navigationDrawerOpen={navigationDrawerOpen}
          onToggleNavigationDrawer={onToggleNavigationDrawer}
        />
      </div>
      <div className="absolute inset-0">{children}</div>
      {conversationLoading && (
        <ListSurfaceLoadingState
          label={t('status.agent.loadingConversations')}
          className="pointer-events-none absolute inset-0 z-20"
        />
      )}
    </div>
  );
}
