import { canonicalPath } from '@/lib/path';
import type { NoteColor } from '@/types/note-item';

export interface NoteMetadata {
  icon: string | null;
  colors: NoteColor[];
  favorited: boolean;
}

export interface NoteMetadataSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'deleted';
  value: NoteMetadata | null;
  revision: number;
}

const EMPTY: NoteMetadataSnapshot = { status: 'pending', value: null, revision: 0 };
const sameValue = (left: NoteMetadata | null, right: NoteMetadata | null) => left === right || Boolean(left && right
  && left.icon === right.icon && left.favorited === right.favorited
  && left.colors.length === right.colors.length && left.colors.every((color, index) => color === right.colors[index]));

/** One metadata projection per file, independent of list queries and tree layout.
 * Revisions order local observations: a query cannot overwrite events received
 * after that query started. Missing index data never means an authored clear.
 */
export class NoteMetadataProjection {
  private clock = 0;
  private floor = 0;
  private entries = new Map<string, NoteMetadataSnapshot>();
  private observers = new Map<string, Set<() => void>>();
  private listeners = new Set<() => void>();
  private reads = new Map<string, number>();

  retainRead(path: string) {
    const key = canonicalPath(path);
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return () => {
      const count = (this.reads.get(key) ?? 1) - 1;
      if (count) this.reads.set(key, count);
      else this.reads.delete(key);
    };
  }

  checkpoint = () => this.clock;
  get = (path: string): NoteMetadataSnapshot => this.entries.get(canonicalPath(path)) ?? EMPTY;
  paths = () => [...this.entries.keys()];
  observedPaths = () => [...this.observers.keys()];

  subscribe = (path: string, listener: () => void) => {
    const key = canonicalPath(path);
    const listeners = this.observers.get(key) ?? new Set();
    listeners.add(listener);
    this.observers.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.observers.delete(key);
    };
  };

  subscribeAll = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private put(path: string, status: NoteMetadataSnapshot['status'], value: NoteMetadata | null) {
    const key = canonicalPath(path);
    const previous = this.get(key);
    const snapshot = { status, value, revision: ++this.clock };
    this.entries.delete(key);
    this.entries.set(key, snapshot);
    // Keep mounted consumers; bound metadata retained from previously visited files.
    if (this.entries.size > 5000) {
      for (const candidate of this.entries.keys()) {
        if (!this.observers.has(candidate) && !this.reads.has(candidate) && candidate !== key) {
          this.entries.delete(candidate);
          // Bulk tree/list reads also carry checkpoints. An eviction must not
          // erase their freshness barrier and admit a pre-eviction snapshot.
          this.floor = this.clock;
        }
        if (this.entries.size <= 5000) break;
      }
    }
    if (previous.status !== status || !sameValue(previous.value, value)) {
      for (const listener of this.observers.get(key) ?? []) listener();
      for (const listener of this.listeners) listener();
    }
    return snapshot;
  }

  update(path: string, value: NoteMetadata) { return this.put(path, 'ready', value); }

  mergeSnapshot(path: string, value: NoteMetadata | null | undefined, checkpoint: number) {
    const previous = this.get(path);
    if (checkpoint < this.floor || previous.revision > checkpoint) return previous;
    if (!value && previous.status === 'deleted') return previous;
    return value ? this.update(path, value)
      : this.put(path, previous.value ? 'stale' : 'pending', previous.value);
  }

  invalidate(path: string) {
    const previous = this.get(path);
    return this.put(path, previous.status === 'deleted' ? 'deleted' : previous.value ? 'stale' : 'pending', previous.value);
  }

  deletePrefix(path: string) {
    const key = canonicalPath(path);
    for (const candidate of new Set([key, ...this.entries.keys(), ...this.observers.keys(), ...this.reads.keys()])) {
      if (candidate === key || candidate.startsWith(`${key}/`)) this.put(candidate, 'deleted', null);
    }
  }

  clear() {
    this.entries.clear();
    this.floor = ++this.clock;
    for (const listeners of this.observers.values()) for (const listener of listeners) listener();
    for (const listener of this.listeners) listener();
  }
}
