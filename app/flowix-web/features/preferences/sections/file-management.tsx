import { useEffect, useRef, useState } from 'react';
import { files, notebooks, type NotebookViewPreferences } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import { isMarkdownFilePath } from '@features/editor/code-file';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';
import { useNoteStore } from '@features/memo/store/note-store';
import { FIELD_TITLE_CLASS, SectionHeader } from '@features/preferences/sections/primitives';

type NotebookOption = Awaited<ReturnType<typeof notebooks.getAll>>[number];
type NotebookSettingsTreeEntry = Awaited<ReturnType<typeof files.getNotebookSettingsTree>>[number];
type SettingsTreeEntry = NotebookSettingsTreeEntry & { depth: number };

function pathLeafName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function isAttachmentsFolder(path: string): boolean {
  return path.split('/').some((segment) => segment.toLocaleLowerCase() === 'attachments');
}

async function collectSettingsTree(notebookPath: string): Promise<NotebookSettingsTreeEntry[]> {
  return files.getNotebookSettingsTree(notebookPath);
}

export function FileManagementSection() {
  const { t } = useI18n();
  const selectedNotebookId = useNoteStore((state) => state.selectedNotebookId);
  const [notebookOptions, setNotebookOptions] = useState<NotebookOption[]>([]);
  const [notebookPath, setNotebookPath] = useState('');
  const [preferences, setPreferences] = useState<NotebookViewPreferences | null>(null);
  const [settingsTreeEntries, setSettingsTreeEntries] = useState<NotebookSettingsTreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingFolderSettings, setSavingFolderSettings] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const preferencesRef = useRef<NotebookViewPreferences | null>(null);
  const notebookPathRef = useRef(notebookPath);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCountRef = useRef(0);
  const folderSettingsPendingRef = useRef(0);
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
    setSettingsTreeEntries([]);
    setPendingPaths([]);
    if (!notebookPath) return () => { active = false; };
    setLoading(true);
    void Promise.all([
      files.getNotebookViewPreferences(notebookPath),
      collectSettingsTree(notebookPath),
    ]).then(([nextPreferences, nextTreeEntries]) => {
      if (!active) return;
      preferencesRef.current = nextPreferences;
      setPreferences(nextPreferences);
      setSettingsTreeEntries(nextTreeEntries);
    }).catch(() => {
      if (active) toast.error(t('preferences.fileManagement.loadFailed'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notebookPath, t]);

  const toggleTreeDisplay = (entry: SettingsTreeEntry) => {
    const current = preferencesRef.current;
    const path = entry.relativePath;
    if (!current || entry.locked || !path) return;
    const included = current.fileManagement?.includedPaths ?? [];
    const hiddenPaths = current.fileManagement?.hiddenPaths ?? [];
    let nextIncluded = included;
    let nextHiddenPaths = hiddenPaths;
    if (entry.hidden) {
      if (hiddenPaths.includes(path)) {
        nextHiddenPaths = hiddenPaths.filter((item) => item !== path);
        if (entry.defaultHidden && !included.includes(path)) nextIncluded = [...included, path];
      } else if (entry.defaultHidden && !included.includes(path)) {
        nextIncluded = [...included, path];
      }
    } else if (entry.defaultHidden) {
      const includedByAncestor = path.split('/').slice(0, -1).some((_, index, segments) =>
        included.includes(segments.slice(0, index + 1).join('/')),
      );
      if (included.includes(path)) nextIncluded = included.filter((item) => item !== path);
      if ((!included.includes(path) || includedByAncestor) && !hiddenPaths.includes(path)) {
        nextHiddenPaths = [...hiddenPaths, path];
      }
    } else if (!hiddenPaths.includes(path)) {
      nextHiddenPaths = [...hiddenPaths, path];
    }
    const nextPreferences = {
      ...current,
      fileManagement: { ...current.fileManagement, includedPaths: nextIncluded, hiddenPaths: nextHiddenPaths },
    };
    const targetNotebook = notebookPath;
    const generation = viewGenerationRef.current;
    preferencesRef.current = nextPreferences;
    setPreferences(nextPreferences);
    setPendingPaths((paths) => [...paths, path]);
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
          const [latest, nextTreeEntries] = await Promise.all([
            files.getNotebookViewPreferences(targetNotebook),
            collectSettingsTree(targetNotebook),
          ]);
          if (viewGenerationRef.current === refreshGeneration && pendingCountRef.current === 0) {
            preferencesRef.current = latest;
            setPreferences(latest);
            setSettingsTreeEntries(nextTreeEntries);
          }
        } catch {
          toast.error(t('preferences.fileManagement.loadFailed'));
        }
      }
    }).finally(() => {
      if (viewGenerationRef.current === generation) {
        setPendingPaths((paths) => paths.filter((item) => item !== path));
      }
    });
  };

  const updateNotebookPreferences = (patch: Partial<NotebookViewPreferences>) => {
    const current = preferencesRef.current;
    if (!current) return;
    const nextPreferences: NotebookViewPreferences = {
      ...current,
      ...patch,
      fileManagement: {
        ...current.fileManagement,
        ...(patch.fileManagement ?? {}),
      },
    };
    const targetNotebook = notebookPath;
    const generation = viewGenerationRef.current;
    preferencesRef.current = nextPreferences;
    setPreferences(nextPreferences);
    folderSettingsPendingRef.current += 1;
    pendingCountRef.current += 1;
    setSavingFolderSettings(true);
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
          const [latest, nextTreeEntries] = await Promise.all([
            files.getNotebookViewPreferences(targetNotebook),
            collectSettingsTree(targetNotebook),
          ]);
          if (viewGenerationRef.current === refreshGeneration && pendingCountRef.current === 0) {
            preferencesRef.current = latest;
            setPreferences(latest);
            setSettingsTreeEntries(nextTreeEntries);
          }
        } catch {
          toast.error(t('preferences.fileManagement.loadFailed'));
        }
      }
    }).finally(() => {
      if (viewGenerationRef.current === generation) {
        folderSettingsPendingRef.current = Math.max(0, folderSettingsPendingRef.current - 1);
        setSavingFolderSettings(folderSettingsPendingRef.current > 0);
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

  const excludedIndexPaths = preferences?.fileManagement?.excludedIndexPaths ?? [];
  const notebookDirectoryName = pathLeafName(notebookPath) || t('preferences.fileManagement.notebookRoot');
  const isIndexExcluded = (relativePath: string) => excludedIndexPaths.some((excludedPath) =>
    excludedPath === '' || relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`),
  );
  const updateIndexExclusion = (relativePath: string, excluded: boolean) => {
    if (!preferences) return;
    const currentExcluded = preferences.fileManagement?.excludedIndexPaths ?? [];
    const nextExcluded = excluded
      ? [...currentExcluded.filter((path) => path !== relativePath), relativePath]
      : currentExcluded.filter((path) => path !== relativePath);
    updateNotebookPreferences({
      fileManagement: { ...preferences.fileManagement, excludedIndexPaths: nextExcluded },
    });
  };

  const treeEntries = new Map<string, SettingsTreeEntry>();
  for (const file of settingsTreeEntries) {
    const depth = file.relativePath.split('/').filter(Boolean).length;
    treeEntries.set(file.relativePath, { ...file, depth });
  }
  const sortedTreeEntries = [...treeEntries.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true, sensitivity: 'base' }),
  );

  return <section className="space-y-4">
    <SectionHeader
      title={t('preferences.fileManagement.locationAndIndexTitle')}
      description={t('preferences.fileManagement.locationAndIndexDescription')}
    />
    <div className="flex items-center gap-3 text-sm">
      <span className="w-16 shrink-0 font-medium">{t('preferences.fileManagement.notebook')}</span>
      <div className="min-w-0 flex-1">
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
    </div>
    <div>
      <h4 className={FIELD_TITLE_CLASS}>{t('preferences.fileManagement.rulesTitle')}</h4>
      {preferences?.refreshPending && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
        <span>{t('preferences.fileManagement.refreshFailed')}</span>
        <button type="button" disabled={retrying || pendingPaths.length > 0} onClick={() => { void retryRefresh(); }} className="shrink-0 text-[var(--brand)] disabled:opacity-50">{t('preferences.fileManagement.retry')}</button>
      </div>}
      {loading ? <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.fileManagement.loading')}</p>
        : sortedTreeEntries.length === 0 ? <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.fileManagement.empty')}</p>
          : <div className="mt-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 [scrollbar-gutter:stable] text-xs font-medium text-[var(--muted-foreground)]">
              <span className="min-w-0 flex-1">{t('preferences.fileManagement.treeColumn')}</span>
              <span className="w-16 text-center">{t('preferences.fileManagement.typeColumn')}</span>
              <span className="w-20 truncate text-center" title={t('preferences.fileManagement.noteLocationTitle')}>{t('preferences.fileManagement.noteLocationTitle')}</span>
              <span className="w-16 text-center">{t('preferences.fileManagement.indexColumn')}</span>
              <span className="w-16 text-center">{t('preferences.fileManagement.hiddenColumn')}</span>
            </div>
            <div className="max-h-96 overflow-y-auto px-1 py-1.5 [scrollbar-gutter:stable]">
              <div className="space-y-0.5">
              {[{ relativePath: '', isDirectory: true, locked: false, hidden: false, defaultHidden: false, collapsed: false, depth: 0 }, ...sortedTreeEntries].map((entry) => {
                const excluded = isIndexExcluded(entry.relativePath);
                const ancestors = entry.relativePath.split('/').slice(0, -1).map((_, index, segments) =>
                  segments.slice(0, index + 1).join('/'),
                );
                const parentExcluded = excludedIndexPaths.includes('') || ancestors.some((parent) => excludedIndexPaths.includes(parent));
                const isFlowixDirectory = entry.relativePath === '.flowix' || entry.relativePath.startsWith('.flowix/');
                const isRootAgents = entry.relativePath === 'AGENTS.md';
                const isAttachments = isAttachmentsFolder(entry.relativePath);
                const locationDisabled = entry.locked || Boolean(entry.hidden) || isAttachments;
                const isDefaultLocation = !locationDisabled && (preferences?.defaultCreateFolder ?? '') === entry.relativePath;
                const typeLabel = entry.locked ? 'preferences.fileManagement.internal' : entry.isDirectory ? 'preferences.fileManagement.folder' : 'preferences.fileManagement.file';
                return <div key={`tree-${entry.relativePath || 'root'}`} className="flex h-8 items-center gap-2 rounded-lg pr-2 text-sm hover:bg-[var(--muted)]">
                  <div className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingLeft: 8 + entry.depth * 16 }}>
                    {entry.isDirectory
                      ? <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                      : isMarkdownFilePath(entry.relativePath)
                        ? <NotebookTreeFileIcon className="notebook-file-tree__default-file-icon h-[18px] w-[18px] shrink-0 text-[var(--muted-foreground)]" />
                        : <NotebookTreeResourceIcon path={entry.relativePath} className="h-[18px] w-[18px] shrink-0" />}
                    <span className="min-w-0 truncate">{entry.relativePath ? pathLeafName(entry.relativePath) : notebookDirectoryName}</span>
                  </div>
                  <span className="w-16 truncate text-center text-xs text-[var(--muted-foreground)]">{t(typeLabel)}</span>
                  <div className="flex w-20 justify-center">
                    {entry.isDirectory && !entry.hidden && !entry.defaultHidden && !entry.locked && <input type="checkbox" aria-label={`${t('preferences.fileManagement.noteLocationTitle')}: ${entry.relativePath || notebookDirectoryName}`} className="h-4 w-4 accent-[var(--brand)]" checked={isDefaultLocation} disabled={!preferences || locationDisabled || savingFolderSettings} onChange={() => updateNotebookPreferences({ defaultCreateFolder: isDefaultLocation ? null : entry.relativePath || null })} />}
                  </div>
                  <div className="flex w-16 justify-center">
                    {!isFlowixDirectory && (isRootAgents || (!entry.defaultHidden && entry.isDirectory)) && <input type="checkbox" aria-label={`${t('preferences.fileManagement.noteIndexTitle')}: ${entry.relativePath || notebookDirectoryName}`} className="h-4 w-4 accent-[var(--brand)]" checked={!excluded} disabled={!preferences || entry.locked || savingFolderSettings || (entry.relativePath !== '' && parentExcluded)} onChange={(event) => updateIndexExclusion(entry.relativePath, !event.currentTarget.checked)} />}
                  </div>
                  <div className="flex w-16 justify-center">
                    {!isFlowixDirectory && <input type="checkbox" aria-label={`${t('preferences.fileManagement.hiddenColumn')}: ${entry.relativePath || notebookDirectoryName}`} className="h-4 w-4 accent-[var(--brand)]" checked={!entry.hidden} disabled={!preferences || entry.locked || !entry.relativePath || pendingPaths.includes(entry.relativePath)} onChange={() => toggleTreeDisplay(entry)} />}
                  </div>
                </div>;
              })}
              </div>
            </div>
          </div>}
    </div>
  </section>;
}
