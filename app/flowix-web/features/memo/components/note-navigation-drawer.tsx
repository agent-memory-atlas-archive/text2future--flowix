'use client';

import { useCallback, useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { Notebook } from '@features/memo/store/note-store';
import { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';

export type NoteNavigationDrawerPhase = 'closed' | 'open' | 'closing';

interface NoteNavigationDrawerProps {
  phase: NoteNavigationDrawerPhase;
  selectedNotebook: Notebook | null;
  onOpenPreferences: (tab?: string) => void;
  activePluginId: string | null;
  onOpenPlugin: (plugin: PluginDescriptor) => void | Promise<void>;
  onRequestClose: () => void;
  onCloseComplete: () => void;
  onCompanionSurfaceEnter?: () => void;
  onCompanionSurfaceLeave?: () => void;
}

/**
 * The note navigation is an overlay. The drawer owns presentation and reports
 * transition completion; the parent owns the shared phase so sibling surfaces
 * can move in sync.
 */
export function NoteNavigationDrawer({
  phase,
  selectedNotebook,
  onOpenPreferences,
  activePluginId,
  onOpenPlugin,
  onRequestClose,
  onCloseComplete,
  onCompanionSurfaceEnter,
  onCompanionSurfaceLeave,
}: NoteNavigationDrawerProps) {
  const { t } = useI18n();
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (phase === 'open') {
      drawerRef.current?.focus();
    }
  }, [phase]);

  const closeWithAnimation = useCallback(() => {
    if (phase !== 'open') return;
    onRequestClose();
  }, [onRequestClose, phase]);

  const handleTransitionEnd = useCallback((event: React.TransitionEvent<HTMLElement>) => {
    if (phase !== 'closing' || event.target !== event.currentTarget) return;
    if (event.propertyName === 'transform') onCloseComplete();
  }, [onCloseComplete, phase]);

  useEffect(() => {
    if (phase !== 'open') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeWithAnimation();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeWithAnimation, phase]);

  const handleOpenPlugin = useCallback(async (plugin: PluginDescriptor) => {
    await onOpenPlugin(plugin);
    closeWithAnimation();
  }, [closeWithAnimation, onOpenPlugin]);

  return (
    <div
      className={cn(
        // Keep the drawer above the message interaction layer (z-index 70)
        // while leaving higher-level popovers/dialogs available above it.
        'absolute inset-0 z-[100] overflow-hidden',
        phase === 'open' ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={phase === 'closed'}
    >
      <button
        type="button"
        aria-label={t('memo.navigation.closeDrawer')}
        tabIndex={phase === 'open' ? 0 : -1}
        onClick={closeWithAnimation}
        className={cn(
          'absolute inset-0 h-full w-full cursor-default bg-transparent transition-opacity duration-150',
          phase === 'open' ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        tabIndex={-1}
        aria-label={t('memo.navigation.notebookNavigation')}
        aria-modal="true"
        className={cn(
          'relative m-1 h-[calc(100%-0.5rem)] w-[var(--flowix-note-navigation-drawer-width)] min-w-0 overflow-hidden rounded-xl',
          'border border-[var(--border-popup)] bg-[var(--card)] text-[var(--agent-foreground)]',
          'transition-transform flowix-note-navigation-motion',
          phase === 'open' ? 'translate-x-0' : '-translate-x-[calc(100%+0.5rem)]',
          // Keep the navigation drawer shadow at a softened weight (24% -> 16%).
          phase === 'open' && 'shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.16)]',
        )}
        onTransitionEnd={handleTransitionEnd}
        onMouseEnter={onCompanionSurfaceEnter}
        onMouseLeave={onCompanionSurfaceLeave}
      >
        <NoteNavigationPanel
          selectedNotebook={selectedNotebook}
          onTogglePanel={closeWithAnimation}
          onOpenPreferences={onOpenPreferences}
          activePluginId={activePluginId}
          onOpenPlugin={handleOpenPlugin}
          transparentSurface
        />
      </aside>
    </div>
  );
}
