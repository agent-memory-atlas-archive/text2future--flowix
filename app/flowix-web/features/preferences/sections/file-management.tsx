import { useEffect, useRef, useState } from 'react';
import { files, notebooks, type NotebookViewPreferences } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import { useNoteStore } from '@features/memo/store/note-store';

type NotebookOption = Awaited<ReturnType<typeof notebooks.getAll>>[number];
type Candidate = { relativePath: string; isDirectory: boolean; locked: boolean };

export function FileManagementSection() {
  const { t } = useI18n();
  const selectedNotebookId = useNoteStore((state) => state.selectedNotebookId);
  const [notebookOptions, setNotebookOptions] = useState<NotebookOption[]>([]);
  const [notebookPath, setNotebookPath] = useState('');
  const [preferences, setPreferences] = useState<NotebookViewPreferences | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const preferencesRef = useRef<NotebookViewPreferences | null>(null);
  const notebookPathRef = useRef(notebookPath);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCountRef = useRef(0);
  const viewGenerationRef = useRef(0);
  notebookPathRef.current = notebookPath;

  useEffect(() => {
    let active = true;
    viewGenerationRef.current += 1;
    pendingCountRef.current = 0;
    void notebooks.getAll().then((items) => {
      if (!active) return;
      setNotebookOptions(items);
      setNotebookPath((current) => current
        || items.find((notebook) => notebook.id === selectedNotebookId)?.path
        || items[0]?.path
        || '');
    }).catch(() => toast.error(t('preferences.fileManagement.loadFailed')));
    return () => { active = false; };
  }, [selectedNotebookId, t]);

  useEffect(() => {
    let active = true;
    preferencesRef.current = null;
    setPreferences(null);
    setCandidates([]);
    setPendingPaths([]);
    if (!notebookPath) return () => { active = false; };
    setLoading(true);
    void Promise.all([
      files.getNotebookViewPreferences(notebookPath),
      files.getFileManagementCandidates(notebookPath),
    ]).then(([nextPreferences, nextCandidates]) => {
      if (!active) return;
      preferencesRef.current = nextPreferences;
      setPreferences(nextPreferences);
      setCandidates(nextCandidates);
    }).catch(() => {
      if (active) toast.error(t('preferences.fileManagement.loadFailed'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notebookPath, t]);

  const toggle = (candidate: Candidate) => {
    const current = preferencesRef.current;
    if (!current || candidate.locked) return;
    const included = current.fileManagement?.includedPaths ?? [];
    const nextIncluded = included.includes(candidate.relativePath)
      ? included.filter((path) => path !== candidate.relativePath)
      : [...included, candidate.relativePath];
    const nextPreferences = {
      ...current,
      fileManagement: { ...current.fileManagement, includedPaths: nextIncluded },
    };
    const targetNotebook = notebookPath;
    const generation = viewGenerationRef.current;
    preferencesRef.current = nextPreferences;
    setPreferences(nextPreferences);
    setPendingPaths((paths) => [...paths, candidate.relativePath]);
    pendingCountRef.current += 1;
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
      await files.setNotebookViewPreferences(targetNotebook, nextPreferences);
    }).catch(() => {
      toast.error(t('preferences.fileManagement.saveFailed'));
    }).then(async () => {
      if (notebookPathRef.current !== targetNotebook) return;
      if (viewGenerationRef.current === generation) pendingCountRef.current -= 1;
      if (pendingCountRef.current === 0) {
        const refreshGeneration = viewGenerationRef.current;
        try {
          const [latest, nextCandidates] = await Promise.all([
            files.getNotebookViewPreferences(targetNotebook),
            files.getFileManagementCandidates(targetNotebook),
          ]);
          if (viewGenerationRef.current === refreshGeneration && pendingCountRef.current === 0) {
            preferencesRef.current = latest;
            setPreferences(latest);
            setCandidates(nextCandidates);
          }
        } catch {
          toast.error(t('preferences.fileManagement.loadFailed'));
        }
      }
    }).finally(() => {
      if (viewGenerationRef.current === generation) {
        setPendingPaths((paths) => paths.filter((path) => path !== candidate.relativePath));
      }
    });
  };

  const retryRefresh = async () => {
    if (!notebookPath || retrying || pendingPaths.length > 0) return;
    const target = notebookPath;
    setRetrying(true);
    try {
      const latest = await files.getNotebookViewPreferences(target);
      if (notebookPathRef.current === target) {
        preferencesRef.current = latest;
        setPreferences(latest);
        if (latest.refreshPending) toast.error(t('preferences.fileManagement.refreshFailed'));
      }
    } catch {
      toast.error(t('preferences.fileManagement.refreshFailed'));
    } finally {
      setRetrying(false);
    }
  };

  return <section className="space-y-4">
    <p className="text-sm leading-6 text-[var(--muted-foreground)]">{t('preferences.fileManagement.description')}</p>
    {preferences?.refreshPending && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
      <span>{t('preferences.fileManagement.refreshFailed')}</span>
      <button type="button" disabled={retrying || pendingPaths.length > 0} onClick={() => { void retryRefresh(); }} className="shrink-0 text-[var(--brand)] disabled:opacity-50">{t('preferences.fileManagement.retry')}</button>
    </div>}
    <div className="space-y-2 text-sm">
      <span className="font-medium">{t('preferences.fileManagement.notebook')}</span>
      <Select value={notebookPath} onValueChange={setNotebookPath} disabled={notebookOptions.length === 0}>
        <SelectTrigger className="h-9 w-full bg-[var(--background)]">
          <span className="min-w-0 truncate text-left">
            {notebookOptions.find((notebook) => notebook.path === notebookPath)?.name ?? t('preferences.fileManagement.notebook')}
          </span>
        </SelectTrigger>
        <SelectContent align="start" fitViewport maxHeight={240} className="flowix-preferences-select-content max-w-[calc(100vw-1rem)]">
          {notebookOptions.map((notebook) => <SelectItem key={notebook.id} value={notebook.path}>{notebook.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    {loading ? <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.fileManagement.loading')}</p>
      : candidates.length === 0 ? <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.fileManagement.empty')}</p>
      : <div className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-[var(--border)] p-2">
        {candidates.map((candidate) => {
          const ignored = candidate.locked || !preferences?.fileManagement?.includedPaths.includes(candidate.relativePath);
          return <label key={candidate.relativePath} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-[var(--muted)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--brand)]"
              checked={ignored}
              disabled={candidate.locked || pendingPaths.includes(candidate.relativePath)}
              onChange={() => toggle(candidate)}
            />
            <span className="min-w-0 flex-1 break-all">{candidate.relativePath}</span>
            <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{t(candidate.locked ? 'preferences.fileManagement.internal' : candidate.isDirectory ? 'preferences.fileManagement.folder' : 'preferences.fileManagement.file')}</span>
          </label>;
        })}
      </div>}
  </section>;
}
