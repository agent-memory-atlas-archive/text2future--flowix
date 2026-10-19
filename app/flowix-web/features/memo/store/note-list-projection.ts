import { noteListItemKey, type NoteListItem } from '@/types/note-item';
import { displayTitleFromFilename } from '@/lib/utils';

export type NoteListChange =
  | { kind: 'entry'; notebookId: string; relativePath: string; memo: NoteListItem | null }
  | { kind: 'move'; notebookId: string; relativePath: string; destination: string; directory: boolean };

const key = (notebookId: string, path: string) => `${notebookId}\u0000${path}`;

// IPC values are acyclic JSON. Object property order is not display data.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => sameJson(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(name => Object.prototype.hasOwnProperty.call(right, name) && sameJson(left[name], right[name]));
}

function sameCard(a: NoteListItem, b: NoteListItem): boolean {
  return a.notebookId === b.notebookId && a.relativePath === b.relativePath
    && a.filename === b.filename && a.title === b.title && a.preview === b.preview
    && a.thumbnail === b.thumbnail && a.icon === b.icon && a.favorited === b.favorited
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt
    && sameJson(a.tags, b.tags) && sameJson(a.todos, b.todos) && sameJson(a.agents, b.agents)
    && sameJson(a.colors, b.colors) && sameJson(a.properties, b.properties);
}

/** Reconcile a loaded window in backend order. Ordinary entry updates use a
 * path lookup rather than scanning the entire window for every overlay entry.
 * Only directory operations scan descendants. Unseen IDs are never inserted.
 */
export function applyNoteListChanges(
  notes: NoteListItem[],
  changes: Iterable<NoteListChange>,
  matches: (note: NoteListItem) => boolean,
): NoteListItem[] {
  const batch = Array.from(changes);
  if (!batch.length) return notes;
  // A normal card edit needs one lookup and only allocates when it changes.
  const single = batch.length === 1 ? batch[0] : null;
  if (single?.kind === 'entry' && single.memo && single.memo.relativePath === single.relativePath) {
    const index = notes.findIndex(note => note.notebookId === single.notebookId && note.relativePath === single.relativePath);
    if (index < 0) return notes;
    const current = notes[index];
    const memo = current.renderKey && !single.memo.renderKey
      ? { ...single.memo, renderKey: current.renderKey }
      : single.memo;
    if (!matches(memo)) return notes.filter((_, position) => position !== index);
    if (sameCard(current, memo)) return notes;
    const next = notes.slice();
    next[index] = memo;
    return next;
  }
  const slots: (NoteListItem | null)[] = [...notes];
  const positions = new Map(notes.map((note, index) => [key(note.notebookId, note.relativePath), index]));
  const drop = (index: number) => {
    const note = slots[index];
    if (note) positions.delete(key(note.notebookId, note.relativePath));
    slots[index] = null;
  };
  const put = (index: number, note: NoteListItem) => {
    const destination = key(note.notebookId, note.relativePath);
    const duplicate = positions.get(destination);
    if (duplicate !== undefined && duplicate !== index) {
      drop(Math.max(index, duplicate));
      index = Math.min(index, duplicate);
    }
    const previous = slots[index];
    if (previous?.renderKey && !note.renderKey) {
      note = { ...note, renderKey: previous.renderKey };
    }
    if (previous && sameCard(previous, note)) return;
    drop(index);
    slots[index] = note;
    positions.set(destination, index);
  };

  for (const change of batch) {
    const source = key(change.notebookId, change.relativePath);
    if (change.kind === 'move') {
      const candidates = Array.from(positions.entries()).filter(([path]) => path === source
        || (change.directory && path.startsWith(`${source}/`)));
      for (const [, index] of candidates) {
        const note = slots[index];
        if (!note) continue;
        const relativePath = change.destination + note.relativePath.slice(change.relativePath.length);
        const filename = relativePath.split('/').pop() || relativePath;
        put(index, {
          ...note,
          renderKey: note.renderKey ?? noteListItemKey(note),
          relativePath,
          filename,
          title: displayTitleFromFilename(filename),
        });
      }
    } else if (change.memo) {
      const index = positions.get(source) ?? positions.get(key(change.notebookId, change.memo.relativePath));
      if (index === undefined) continue;
      if (matches(change.memo)) put(index, change.memo);
      else drop(index);
    } else {
      const exact = positions.get(source);
      if (exact !== undefined) drop(exact);
      else {
        for (const [path, index] of positions) {
          if (path.startsWith(`${source}/`)) drop(index);
        }
      }
    }
  }
  const next = slots.filter((note): note is NoteListItem => note !== null);
  return next.length === notes.length && next.every((note, index) => note === notes[index]) ? notes : next;
}
