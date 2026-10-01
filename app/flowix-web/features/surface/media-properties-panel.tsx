'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { mediaResources, type MediaResource } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';

interface PropertyDraft {
  id: string;
  key: string;
  value: string;
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('[') && trimmed.endsWith(']'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function draftsFromResource(resource: MediaResource): PropertyDraft[] {
  return Object.entries(resource.properties).map(([key, value], index) => ({
    id: `${key}-${index}`,
    key,
    value: displayValue(value),
  }));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp);
}

export function MediaPropertiesPanel({
  filePath,
  notebookPath,
  onClose,
}: {
  filePath: string;
  notebookPath: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const kind = resourceKindFromPath(filePath);
  const [resource, setResource] = useState<MediaResource | null>(null);
  const [rows, setRows] = useState<PropertyDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const rowsRef = useRef<PropertyDraft[]>([]);
  const resourceRef = useRef<MediaResource | null>(null);
  const editVersionRef = useRef(0);
  const failedVersionRef = useRef<number | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    resourceRef.current = resource;
  }, [resource]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResource(null);
    resourceRef.current = null;
    setRows([]);
    rowsRef.current = [];
    setDirty(false);
    editVersionRef.current = 0;
    failedVersionRef.current = null;
    void mediaResources.get(filePath, notebookPath).then((response) => {
      if (cancelled) return;
      const nextRows = draftsFromResource(response.resource);
      setResource(response.resource);
      setRows(nextRows);
      rowsRef.current = nextRows;
      resourceRef.current = response.resource;
      setDirty(false);
      setLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, notebookPath]);

  const markDirty = () => {
    editVersionRef.current += 1;
    failedVersionRef.current = null;
    setDirty(true);
  };

  const updateRow = (id: string, patch: Partial<PropertyDraft>) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    markDirty();
  };

  const save = useCallback(async () => {
    const currentResource = resourceRef.current;
    if (!currentResource || saving) return false;
    const versionAtSave = editVersionRef.current;
    const properties: Record<string, unknown> = {};
    for (const row of rowsRef.current) {
      const key = row.key.trim();
      if (key) properties[key] = parseValue(row.value);
    }
    setSaving(true);
    try {
      const response = await mediaResources.update(
        filePath,
        notebookPath,
        currentResource.id,
        properties,
        currentResource.propertiesRevision,
      );
      resourceRef.current = response.resource;
      setResource(response.resource);
      if (versionAtSave === editVersionRef.current) {
        failedVersionRef.current = null;
        setDirty(false);
      }
      return true;
    } catch (reason) {
      failedVersionRef.current = versionAtSave;
      const message = reason instanceof Error ? reason.message : String(reason);
      toast.error(message.includes('properties changed')
        ? t('media.properties.conflict')
        : message || t('media.properties.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [filePath, notebookPath, saving, t]);

  useEffect(() => {
    if (!dirty || !resource || saving || failedVersionRef.current === editVersionRef.current) return;
    const timer = window.setTimeout(() => {
      void save();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [dirty, resource, rows, saving, save]);

  const close = async () => {
    if (dirty && !saving && failedVersionRef.current !== editVersionRef.current) {
      const saved = await save();
      if (!saved) return;
    }
    onClose();
  };

  if (kind !== 'image' && kind !== 'video') return null;

  return (
    <aside className="flex h-full w-[300px] min-w-[260px] shrink-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]">
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-xs font-semibold">{kind === 'image' ? t('media.properties.imageTitle') : t('media.properties.title')}</span>
        <button type="button" onClick={() => void close()} aria-label={t('media.properties.close')} className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[var(--muted-foreground)]">{t('media.properties.loading')}</div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--destructive)]">{error}</div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
            {resource && (
              <div className="space-y-0.5 border-b border-[var(--border)] pb-4 pt-1">
                <div className="grid grid-cols-[90px_minmax(0,1fr)] items-start gap-2 py-1.5 text-xs"><span className="text-[var(--muted-foreground)]">{t('media.properties.size')}</span><span className="tabular-nums">{formatSize(resource.sizeBytes)}</span></div>
                <div className="grid grid-cols-[90px_minmax(0,1fr)] items-start gap-2 py-1.5 text-xs"><span className="text-[var(--muted-foreground)]">{t('media.properties.modified')}</span><span>{formatDate(resource.modifiedMs)}</span></div>
                <div className="grid grid-cols-[90px_minmax(0,1fr)] items-start gap-2 py-1.5 text-xs"><span className="text-[var(--muted-foreground)]">{t('media.properties.location')}</span><span className="break-all text-[var(--muted-foreground)]" title={filePath}>{resource.relativePath}</span></div>
              </div>
            )}
            <div className="flex items-center justify-between pb-2 pt-5">
              <span className="text-xs font-medium text-[var(--muted-foreground)]">{t('media.properties.custom')}</span>
              {saving && <span className="text-[11px] text-[var(--muted-foreground)]">{t('media.properties.saving')}</span>}
            </div>
            <div className="space-y-1">
              {rows.map((row) => (
                <div key={row.id} className="group grid grid-cols-[90px_minmax(0,1fr)_22px] items-start gap-2 rounded-md py-1 hover:bg-[var(--muted)]/40">
                  <input
                    value={row.key}
                    onChange={(event) => updateRow(row.id, { key: event.target.value })}
                    placeholder={t('media.properties.key')}
                    className="h-7 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-xs text-[var(--muted-foreground)] outline-none hover:border-[var(--border)] focus-visible:border-[var(--primary)] focus-visible:bg-[var(--background)]"
                    aria-label={t('media.properties.key')}
                  />
                  <textarea
                    value={row.value}
                    onChange={(event) => updateRow(row.id, { value: event.target.value })}
                    placeholder={t('media.properties.value')}
                    rows={1}
                    className="min-h-7 min-w-0 resize-y rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none hover:border-[var(--border)] focus-visible:border-[var(--primary)] focus-visible:bg-[var(--background)]"
                    aria-label={row.key || t('media.properties.value')}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setRows((current) => current.filter((candidate) => candidate.id !== row.id));
                      markDirty();
                    }}
                    className="flex h-7 w-[22px] items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 hover:text-[var(--destructive)] focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={t('media.properties.remove')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {rows.length === 0 && (
              <div className="py-3 text-xs text-[var(--muted-foreground)]">
                {t('media.properties.empty')}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setRows((current) => [...current, { id: `new-${Date.now()}`, key: '', value: '' }]);
                markDirty();
              }}
              className="mt-2 inline-flex h-7 items-center gap-1 rounded-full bg-[var(--muted)] px-2.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('media.properties.add')}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
