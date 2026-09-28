import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistRecoveryDraft, clearRecoveryDraftThrough, flushRecoveryOperations, rebaseRecoveryDraftPath, readRecoveryDraft } from './recovery-draft-store';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath } from '@/lib/file-display-registry';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), list: vi.fn(), clearThrough: vi.fn() }));
vi.mock('@platform/tauri/client/recovery', () => ({ recoveryDrafts: mocks }));
let seq = 0;
function input(revision = 1) {
  const path = '/checkpoint-' + ++seq + '.md';
  return { identity: { kind: 'md' as const, memoId: null, ...ensureFileDisplayIdentity(path) }, originalPath: path,
    revision, content: 'draft', baseContent: 'base', reason: 'autosave' as const,
    title: { draft: 'new title', filename: 'old.md', revision } };
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('bounded recovery checkpoints', () => {
  beforeEach(() => {
    mocks.read.mockReset().mockResolvedValue(null); mocks.list.mockReset().mockResolvedValue([]);
    mocks.write.mockReset().mockResolvedValue(true); mocks.clearThrough.mockReset().mockResolvedValue(true);
  });
  it('retains only the active snapshot and the latest of 300 drafts, without a migration scan', async () => {
    let finish!: (value: boolean) => void;
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = input(); const done = persistRecoveryDraft(first); await tick();
    for (let revision = 2; revision <= 300; revision++) void persistRecoveryDraft({ ...first, revision, content: String(revision) });
    expect(mocks.write).toHaveBeenCalledTimes(1); finish(true); expect(await done).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.write.mock.calls[1][1]).toMatchObject({ revision: 300, content: '300', title: first.title });
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
    expect(await flushRecoveryOperations()).toBe(true);
  });
  it('does not resurrect a checkpoint already covered by a canonical save', async () => {
    let finish!: (value: boolean) => void;
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = input(); const done = persistRecoveryDraft(first); await tick();
    void persistRecoveryDraft({ ...first, revision: 2 });
    const cleared = clearRecoveryDraftThrough(first.identity, 2);
    finish(true); await Promise.all([done, cleared]);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.clearThrough.mock.calls[0][1]).toBe(2);
  });
  it('migrates a protected title and writes queued content to the confirmed new path', async () => {
    const disk = new Map<string, unknown>(); let finish!: (value: boolean) => void;
    mocks.read.mockImplementation(async key => disk.get(key) ?? null);
    mocks.write.mockImplementation(async (key, value) => { disk.set(key, value); return true; });
    mocks.clearThrough.mockImplementation(async key => { disk.delete(key); return true; });
    const first = input(); await persistRecoveryDraft(first);
    mocks.write.mockImplementationOnce((key, value) => new Promise(resolve => {
      finish = valueResult => { disk.set(key, value); resolve(valueResult); };
    }));
    const done = persistRecoveryDraft({ ...first, revision: 2 }); await tick();
    void persistRecoveryDraft({ ...first, revision: 3, content: 'latest' });
    const next = first.identity.path.replace('.md', '-renamed.md');
    rebaseRecoveryDraftPath(first.identity, next);
    rebaseFileDisplayPath(first.identity.path, next, first.identity.displayId);
    finish(true); await done; await flushRecoveryOperations();
    const restored = await readRecoveryDraft({ ...first.identity, path: next });
    expect(restored).toMatchObject({ originalPath: next, revision: 3, content: 'latest', title: first.title });
    expect([...disk.values()]).toHaveLength(1);
  });
});
