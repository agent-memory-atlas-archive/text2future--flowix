'use client';

import {
  useState,
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

import { useI18n, type I18nKey } from '@/lib/i18n';
import type { MemoListViewTab } from '@features/memo/components/memo-list-view-tabs';
import { NotebookTreeVisibilityList } from '@features/memo/components/notebook-tree-visibility-list';

const DISMISSED_KEY = 'flowix:list-column-guide:dismissed:v1';

function wasDismissed() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

const PAGES = [
  {
    view: 'folders',
    title: 'memo.guide.fileTree.title',
    subtitle: undefined,
    description: 'memo.guide.fileTree.description',
  },
  {
    view: 'folders',
    title: 'memo.guide.modules.title',
    subtitle: 'memo.guide.modules.subtitle',
    description: undefined,
  },
  {
    view: 'cards',
    title: 'memo.guide.notes.title',
    subtitle: undefined,
    description: 'memo.guide.notes.description',
  },
] satisfies ReadonlyArray<{
  view: MemoListViewTab;
  title: I18nKey;
  subtitle?: I18nKey;
  description?: I18nKey;
}>;

function actionButtonHandlers(action: () => void) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.isPrimary === false || event.button !== 0) return;
      action();
    },
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0) action();
    },
  };
}

export function ListColumnGuideCard({
  activeView,
  onViewChange,
}: {
  activeView: MemoListViewTab;
  onViewChange: (view: MemoListViewTab) => void;
}) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [pageIndex, setPageIndex] = useState(() => PAGES.findIndex(({ view }) => view === activeView));
  useEffect(() => {
    if (activeView === 'conversations') return;
    setPageIndex((index) => PAGES[index]?.view === activeView
      ? index
      : PAGES.findIndex(({ view }) => view === activeView));
  }, [activeView]);
  const page = PAGES[pageIndex];
  const canStart = pageIndex === PAGES.length - 1;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Keep the guide dismissible when storage is unavailable.
    }
    setDismissed(true);
  };

  const selectPage = (index: number) => {
    setPageIndex(index);
    onViewChange(PAGES[index].view);
  };

  const goToNextPage = () => {
    if (canStart) {
      dismiss();
      return;
    }
    selectPage(pageIndex + 1);
  };

  if (dismissed || !page || activeView === 'conversations') return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-3">
      <section
        aria-label={t('memo.guide.ariaLabel')}
        className="pointer-events-auto w-full max-w-[360px] rounded-2xl border border-[var(--border-popup)] bg-[color-mix(in_oklch,var(--card)_96%,transparent)] p-3.5 backdrop-blur-xl"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-5 tracking-[-0.02em] text-[var(--foreground)]">
              {t(page.title)}
            </h2>
            {page.subtitle && (
              <p className="mt-0.5 text-xs leading-4 text-[var(--muted-foreground)]">
                {t(page.subtitle)}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={t('memo.guide.close')}
            title={t('memo.guide.close')}
            {...actionButtonHandlers(dismiss)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div aria-live="polite" aria-atomic="true" className="min-h-[36px]">
          {pageIndex === 1 ? <NotebookTreeVisibilityList /> : page.description && <p className="text-sm leading-5 text-[var(--foreground)]">
            {t(page.description)}
          </p>}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <div
            role="group"
            aria-label={t('memo.guide.pageStatus', { current: pageIndex + 1, total: PAGES.length })}
            className="flex items-center gap-1.5"
          >
            {PAGES.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                aria-label={t('memo.guide.goToPage', { page: index + 1 })}
                aria-current={index === pageIndex ? 'step' : undefined}
                {...actionButtonHandlers(() => selectPage(index))}
                className="group inline-flex h-5 items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              >
                <span className={`h-1.5 rounded-full transition-all ${index === pageIndex ? 'w-4 bg-[var(--primary)]' : 'w-1.5 bg-[color-mix(in_oklch,var(--foreground)_20%,transparent)] group-hover:bg-[var(--primary)]'}`} />
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {pageIndex > 0 && (
              <button
                type="button"
                {...actionButtonHandlers(() => selectPage(pageIndex - 1))}
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                {t('memo.guide.previous')}
              </button>
            )}
            <button
              type="button"
              {...actionButtonHandlers(goToNextPage)}
              className="inline-flex h-8 items-center rounded-lg bg-[var(--primary)] px-3 text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]"
            >
              {t(canStart ? 'memo.guide.done' : 'memo.guide.next')}
              {!canStart && <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
