import type { RefObject } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ContentIcon } from '@features/content/public/content-api';

type CollectionTitleKind = 'table' | 'work_documents';

export function CollectionTitle({
  kind,
  title,
  inputLabel,
  renameLabel,
  renameHint,
  editing,
  draft,
  setDraft,
  inputRef,
  captureCaret,
  beginEdit,
  commit,
  cancel,
  disabled = false,
  busy = false,
}: {
  kind: CollectionTitleKind;
  title: string;
  inputLabel: string;
  renameLabel: string;
  renameHint: string;
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  captureCaret: (element: HTMLElement, x: number, y: number) => void;
  beginEdit: () => void;
  commit: (value: string) => void | Promise<void>;
  cancel: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const content = kind === 'table' ? { kind: 'multidimensional-table' as const } : { kind: 'work-documents' as const };
  const unavailable = disabled || busy;

  return <div className="multidimensional-table__view-title flex min-w-0 max-w-[40%] shrink-0 -translate-x-[2px] items-center gap-1.5" title={title}>
    <ContentIcon content={content} className="h-5 w-5 shrink-0" />
    {editing ? <input
      ref={inputRef}
      aria-label={inputLabel}
      value={draft}
      disabled={unavailable}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => { void commit(event.currentTarget.value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
      className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded px-0.5 py-1 [field-sizing:content] border-0 bg-[var(--muted)] text-sm font-medium leading-none text-[var(--foreground)] outline-none"
    /> : <button
      type="button"
      onDoubleClick={(event) => {
        if (unavailable) return;
        event.preventDefault();
        captureCaret(event.currentTarget, event.clientX, event.clientY);
        beginEdit();
      }}
      aria-label={`${renameLabel}：${title}`}
      title={`${renameHint}：${title}`}
      disabled={unavailable}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          beginEdit();
        }
      }}
      className="min-w-[2em] flex-[0_1_auto] truncate rounded px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
    >{title}</button>}
    {busy && <span role="status" aria-label={t('memo.fileTree.renaming')} className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]">
      <LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
    </span>}
  </div>;
}
