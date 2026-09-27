'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import standardIcon from '@/assets/editor-font-icons/standard.svg';
import serifIcon from '@/assets/editor-font-icons/serif.svg';
import wenkaiIcon from '@/assets/editor-font-icons/wenkai.svg';
import {
  beginTypographyFontSelection,
  commitTypographyFontSelection,
  ensureDownloadedFontRegistered,
  useTypographyFontId,
} from '@features/preferences/public/font-api';
import type { FontDownloadProgress } from '@platform/tauri/client/general';
import { subscribe } from '@platform/tauri/event-bus';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

const FONT_CHOICES = [
  { mode: 'standard', icon: standardIcon },
  { mode: 'serif', icon: serifIcon },
  { mode: 'wenkai', icon: wenkaiIcon },
] as const;

type DocumentEditorFontMode = (typeof FONT_CHOICES)[number]['mode'];

export function useEditorFontSwitch() {
  const { t } = useI18n();
  const fontId = useTypographyFontId();
  const fontMode: DocumentEditorFontMode = fontId === 'noto-serif-sc' ? 'serif' : fontId === 'lxgw-wenkai' ? 'wenkai' : 'standard';
  const [downloadingMode, setDownloadingMode] = useState<'serif' | 'wenkai' | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const requestId = useRef(0);
  const downloadingFontId = useRef<string | null>(null);

  useEffect(() => subscribe<FontDownloadProgress>('font-download-progress', (progress) => {
    if (progress.fontId === downloadingFontId.current) {
      setPercent(progress.percent);
    }
  }), []);

  useEffect(() => () => {
    requestId.current += 1;
    downloadingFontId.current = null;
  }, []);

  async function selectFontMode(mode: DocumentEditorFontMode) {
    const request = ++requestId.current;
    const fontId = mode === 'standard' ? 'inter' : mode === 'serif' ? 'noto-serif-sc' : 'lxgw-wenkai';
    downloadingFontId.current = mode === 'standard' ? null : fontId;
    setDownloadingMode(mode === 'standard' ? null : mode);
    setPercent(null);
    try {
      const selectionId = await beginTypographyFontSelection();
      if (requestId.current !== request) return;
      if (mode !== 'standard') await ensureDownloadedFontRegistered(fontId);
      if (requestId.current !== request) return;
      await commitTypographyFontSelection(selectionId, fontId);
    } catch (error) {
      if (requestId.current !== request) return;
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('preferences.format.fontDownloadFailed', { message }));
    } finally {
      if (requestId.current === request) {
        downloadingFontId.current = null;
        setDownloadingMode(null);
        setPercent(null);
      }
    }
  }

  return { fontMode, downloadingMode, percent, selectFontMode };
}

export function EditorFontSwitcher({
  fontMode,
  downloadingMode,
  percent,
  onSelect,
}: {
  fontMode: DocumentEditorFontMode;
  downloadingMode: 'serif' | 'wenkai' | null;
  percent: number | null;
  onSelect: (mode: DocumentEditorFontMode) => void;
}) {
  const { t } = useI18n();
  const selectedMode = fontMode;

  return (
    <div className="mb-1">
      <div className="flex justify-center gap-1" role="group" aria-label={t('document.font.label')}>
        {FONT_CHOICES.map(({ mode, icon }) => {
          const active = selectedMode === mode;
          const isLoading = downloadingMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              disabled={isLoading}
              onClick={() => onSelect(mode)}
              className={`group flex h-[58px] w-[58px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg text-[11px] leading-tight transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] ${active ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
            >
              {isLoading
                ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-[var(--brand)]" />
                : <img
                    aria-hidden="true"
                    src={icon}
                    alt=""
                    className="h-6 w-6 shrink-0 dark:invert"
                  />}
              <span className="max-w-full truncate tabular-nums">
                {isLoading
                  ? percent == null ? '…' : `${percent}%`
                  : t(mode === 'standard' ? 'document.font.standard' : mode === 'serif' ? 'document.font.serif' : 'document.font.wenkai')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
