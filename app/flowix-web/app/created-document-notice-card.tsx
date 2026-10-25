import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { ChevronRight, Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import { dismissCreatedDocumentNotice, openCreatedDocumentNotice, type CreatedDocumentNotice } from './created-document-notices';

interface Props {
  notice: CreatedDocumentNotice;
  notebookName?: string;
  hidden: boolean;
  style: CSSProperties;
  onHeight: (id: string, height: number | null) => void;
}

export function CreatedDocumentNoticeCard({ notice, notebookName: registeredNotebookName, hidden, style, onHeight }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const card = ref.current!;
    const measure = () => onHeight(notice.id, card.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => { observer.disconnect(); onHeight(notice.id, null); };
  }, [notice.id, onHeight]);
  const filename = notice.path.split(/[\\/]/).pop() || notice.path;
  const path = notice.path.replace(/\\/g, '/');
  const notebookRoot = notice.notebookPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = path.startsWith(`${notebookRoot}/`) ? path.slice(notebookRoot.length + 1) : filename;
  const segments = relative.split('/');
  const documentName = (segments.pop() || filename).replace(/\.md$/i, '');
  const subfolder = segments.join(' / ');
  const notebookName = registeredNotebookName
    || notebookRoot.split('/').pop()
    || notice.notebookPath;
  return <section ref={ref} data-notice-id={notice.id} aria-hidden={hidden} inert={hidden}
    style={style} className="created-document-notice-card group pointer-events-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
    <button type="button" aria-label={t('createdDocuments.dismiss', { name: filename })} onClick={() => dismissCreatedDocumentNotice(notice.id)} className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] opacity-0 shadow-sm transition-opacity hover:text-[var(--foreground)] focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"><X size={12} /></button>
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p title={subfolder ? `${notebookName} / ${subfolder}` : notebookName} className="flex min-w-0 items-center gap-0.5 truncate text-xs text-[var(--muted-foreground)]">
          <span className="shrink-0">{notebookName}</span>
          {subfolder && <><ChevronRight size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{subfolder}</span></>}
        </p>
        <p title={documentName} className="mt-0.5 line-clamp-2 break-words text-sm font-medium leading-5">{documentName}</p>
      </div>
      <Button type="button" variant="outline" disabled={notice.busy} onClick={() => void openCreatedDocumentNotice(notice.id)} className="h-8 shrink-0 px-3 bg-white text-neutral-800 hover:bg-neutral-50 active:bg-neutral-100 dark:bg-white dark:text-neutral-800 dark:hover:bg-neutral-50">
        {notice.busy ? <Loader2 size={13} className="flowix-spin" /> : null}{notice.busy ? t('createdDocuments.opening') : t('createdDocuments.open')}
      </Button>
    </div>
    {notice.error && <p role="alert" className="mt-3 break-words text-xs text-destructive">{t('createdDocuments.failed')} {notice.error}</p>}
  </section>;
}
