import type { MemoItem } from '@/types/memo-item';
import { isPluginArtifactRendererId, type PluginArtifactRendererId } from './plugin-renderer-ids';

export type { PluginArtifactRendererId } from './plugin-renderer-ids';

export interface PluginNoteInfo {
  pluginId: string;
  noteType: string;
  renderer: PluginArtifactRendererId | null;
}

export function normalizePluginId(value: unknown): string | null {
  const id = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).id
      : null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function normalizePluginArtifactRenderer(value: unknown): PluginArtifactRendererId | null {
  const renderer = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).renderer
      : null;
  if (typeof renderer !== 'string') return null;
  return isPluginArtifactRendererId(renderer) ? renderer : null;
}

export function getPluginNoteInfo(memo: MemoItem | null | undefined): PluginNoteInfo | null {
  if (!memo) return null;
  const noteType = memo.properties?.flowix_note_type;
  const pluginId = normalizePluginId(memo.properties?.flowix_plugin);
  if (!memo.properties?.flowix_artifact) return null;
  if (typeof noteType !== 'string' || !pluginId) return null;
  if (!noteType.trim()) return null;
  return {
    noteType,
    pluginId,
    renderer: normalizePluginArtifactRenderer(memo.properties?.flowix_artifact),
  };
}
