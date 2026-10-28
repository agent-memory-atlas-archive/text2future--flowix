'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import folderIcon from '@/assets/folder-outline.svg?raw';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';

export type MemoListViewTab = 'cards' | 'folders' | 'conversations';

interface MemoListViewTabsProps {
  activeTab: MemoListViewTab;
  onChange: (tab: MemoListViewTab) => void;
  /** The active cards tab doubles as the entry point for the note navigation drawer. */
  navigationDrawerEnabled?: boolean;
  navigationDrawerOpen?: boolean;
  onToggleNavigationDrawer?: () => void;
}

type TabIconProps = {
  className?: string;
  weight: 'regular' | 'fill';
};

const TABS: ReadonlyArray<{
  value: MemoListViewTab;
  labelKey: I18nKey;
  icon: (props: TabIconProps) => ReactNode;
  dimmed?: boolean;
}> = [
  {
    value: 'folders',
    labelKey: 'memo.list.viewFolders',
    icon: ({ className }) => (
      <span className={cn(className, 'inline-flex items-center justify-center')}>
        <span
          className="block h-full w-full"
          dangerouslySetInnerHTML={{ __html: folderIcon }}
        />
      </span>
    ),
  },
  {
    value: 'cards',
    labelKey: 'memo.list.viewCards',
    icon: ({ className }) => <NotebookTreeFileIcon className={className} />,
  },
];

function TabIcon({
  icon,
  className,
  weight,
  dimmed = true,
}: {
  icon: (props: TabIconProps) => ReactNode;
  className?: string;
  weight: 'regular' | 'fill';
  dimmed?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'memo-list-view-tab-icon flex h-4 w-4 shrink-0 items-center justify-center',
        dimmed && 'opacity-50',
        className,
      )}
    >
      {icon({ className: 'h-full w-full', weight })}
    </span>
  );
}

export function MemoListViewTabs({
  activeTab,
  onChange,
  navigationDrawerEnabled = false,
  navigationDrawerOpen = false,
  onToggleNavigationDrawer,
}: MemoListViewTabsProps) {
  const { t } = useI18n();
  const [indicatorTab, setIndicatorTab] = useState<MemoListViewTab>(activeTab);

  useEffect(() => {
    if (indicatorTab === activeTab) return;
    const frame = window.requestAnimationFrame(() => {
      setIndicatorTab(activeTab);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, indicatorTab]);

  const handleChange = (tab: MemoListViewTab) => {
    onChange(tab);
  };

  return (
    <div
      data-memo-list-view-tabs
      role="tablist"
      aria-label={t('memo.navigation.menuTitle')}
      className="relative flex h-[30px] shrink-0 items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] p-0.5"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0.5 top-1/2 h-6 w-6 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-sm transition-transform duration-200 ease-out"
        style={{
          transform: `translateX(${TABS.findIndex((tab) => tab.value === indicatorTab) * 26}px) translateY(-50%)`,
        }}
      />
      {TABS.map(({ value, labelKey, icon: IconComponent, dimmed }) => {
        const active = activeTab === value;
        const label = t(labelKey);
        const opensNavigation =
          value === 'cards' &&
          active &&
          navigationDrawerEnabled &&
          Boolean(onToggleNavigationDrawer);
        const buttonLabel = opensNavigation
          ? navigationDrawerOpen
            ? t('memo.navigation.closeDrawer')
            : t('memo.navigation.menuTitle')
          : label;
        const activate = () => {
          if (opensNavigation) {
            onToggleNavigationDrawer?.();
            return;
          }
          handleChange(value);
        };
        return (
          <Tooltip
            key={value}
            content={value === 'cards' ? label : buttonLabel}
            side="bottom"
            sideOffset={4}
          >
            <button
              type="button"
              role="tab"
              data-memo-list-view-tab={value}
              aria-selected={active}
              aria-label={buttonLabel}
              aria-expanded={opensNavigation ? navigationDrawerOpen : undefined}
              title={buttonLabel}
              onPointerDown={(event) => {
                // Leaving an edited BrowserColumn synchronously blurs and
                // serializes its editor during the ancestor pointerdown. Run
                // the tab intent before that focus transition can rerender the
                // trigger and swallow the later click event.
                if (event.isPrimary === false || event.button !== 0) return;
                activate();
              }}
              onClick={(event) => {
                // Pointer activation already ran on pointerdown. A detail of 0
                // is the keyboard/assistive-technology click path.
                if (event.detail === 0) activate();
              }}
              className={cn(
                'group relative z-[1] flex h-6 w-6 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
                active
                  ? 'text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
              )}
            >
              {opensNavigation ? (
                <span className="relative block h-4 w-4" aria-hidden="true">
                  {navigationDrawerOpen ? (
                    <ChevronLeft
                      className="absolute inset-0 h-4 w-4"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <>
                      <TabIcon
                        icon={IconComponent}
                        weight={active ? 'fill' : 'regular'}
                        dimmed={active ? false : dimmed}
                        className="absolute inset-0 opacity-90 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <ChevronRight
                        className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                        strokeWidth={2.5}
                      />
                    </>
                  )}
                </span>
              ) : (
                <TabIcon icon={IconComponent} weight={active ? 'fill' : 'regular'} dimmed={active ? false : dimmed} className={active ? 'opacity-90' : undefined} />
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
