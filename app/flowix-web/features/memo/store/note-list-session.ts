/** Owns response ordering and local changes for one browsing query.
 * A refresh starts a new session; loading another page preserves its overlay.
 * Replaying the overlay also prevents an older page record from undoing an edit
 * or resurrecting a deleted row. No per-request journal or pruning is needed.
 */
export class NoteListSession<Change> {
  private request = 0;
  private queryRequest: number | null = null;
  private readonly overlay = new Map<string, Change>();

  constructor(private readonly key: (change: Change) => string) {}

  beginQuery(): number {
    this.overlay.clear();
    this.queryRequest = ++this.request;
    return this.queryRequest;
  }

  get loadingQuery(): boolean { return this.queryRequest !== null; }
  finishQuery(request: number): void {
    if (this.queryRequest === request) this.queryRequest = null;
  }
  nextPage(): number { return ++this.request; }
  invalidate(): void { this.request += 1; this.queryRequest = null; }
  isCurrent(request: number): boolean { return request === this.request; }

  remember(change: Change): void {
    const key = this.key(change);
    // Preserve event order when a path is updated again after another change.
    this.overlay.delete(key);
    this.overlay.set(key, change);
  }

  changes(): Iterable<Change> { return this.overlay.values(); }
}
