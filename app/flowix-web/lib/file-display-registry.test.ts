import { expect, it } from 'vitest';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath, findFileDisplayPath, findFileDisplayId } from './file-display-registry';
it('rejects stale rename events without creating a second path for a displayId', () => {
  const file = ensureFileDisplayIdentity('/identity-test/A.md');
  expect(rebaseFileDisplayPath(file.path, '/identity-test/B.md', file.displayId)).toBe(true);
  expect(rebaseFileDisplayPath('/identity-test/B.md', '/identity-test/C.md', file.displayId)).toBe(true);
  expect(rebaseFileDisplayPath(file.path, '/identity-test/B.md', file.displayId)).toBe(false);
  expect(findFileDisplayPath(file.displayId)).toBe('/identity-test/C.md');
  expect(findFileDisplayId('/identity-test/B.md')).toBe(null);
  expect(findFileDisplayId('/identity-test/A.md')).toBe(null);
});
it('does not steal another live file identity on a destination collision', () => {
  const first = ensureFileDisplayIdentity('/identity-collision/A.md');
  const second = ensureFileDisplayIdentity('/identity-collision/B.md');
  expect(rebaseFileDisplayPath(first.path, second.path, first.displayId)).toBe(false);
  expect(findFileDisplayId(first.path)).toBe(first.displayId);
  expect(findFileDisplayId(second.path)).toBe(second.displayId);
});
