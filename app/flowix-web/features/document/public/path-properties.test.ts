import { expect, it, vi } from 'vitest';
import { patchDocumentProperties, setDocumentProperties } from './path-properties';
import { ensureFileDisplayIdentity, reconcileFileDisplays } from '@/lib/file-display-registry';
import { documentIdentityFromFile } from '../store/document-identity';
import { applyLoadedContent, getBuffer } from '../store/buffer-registry';
import { recordDocumentEdit } from '../store/document-session-service';
const mocks = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }));
vi.mock('../use-cases/document-operations', () => ({ documentContentOperations: () => ({ write: mocks.write }) }));
vi.mock('../use-cases/memo-document-operations', () => ({ memoDocumentOperations: { read: mocks.read } }));

it('preserves body bytes, comments and unrelated YAML while setting colors', () => {
  const body = '# Title\r\n\r\nunchanged  \r\n';
  const result = patchDocumentProperties('---\n# keep comment\nstatus: draft\n---\n' + body, { flowix_colors: ['blue'] });
  expect(result).toContain('# keep comment');
  expect(result).toContain('status: draft');
  expect(result.endsWith(body)).toBe(true);
  expect(result).not.toContain('flowix_key');
});

it('rejects malformed YAML instead of overwriting it', () => {
  expect(() => patchDocumentProperties('---\nstatus: [broken\n---\nbody', { flowix_favorited: true })).toThrow();
});

it('saves properties with unsaved body edits through the same document buffer', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/note.md'));
  reconcileFileDisplays([{ path: identity.path }]);
  applyLoadedContent(identity, identity.path, '# Initial\n', { setAsCurrent: false });
  recordDocumentEdit(identity, '# Latest unsaved body\n');
  mocks.write.mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
  expect(await setDocumentProperties(identity.path, { flowix_colors: ['green'] }, 'cache123')).toBe(true);
  const request = mocks.write.mock.calls[0][0];
  expect(request.path).toBe(identity.path);
  expect(request.content).toContain('# Latest unsaved body');
  expect(request.content).toContain('green');
  expect(request.content).not.toContain('flowix_key');
  expect(request.expectedContent).toBe('# Initial\n');
  expect(request.memoId).toBe('cache123');
  expect(getBuffer(identity)?.content).toBe(request.content);
});

it('updates an empty frontmatter block and does not displace a UTF-8 BOM into the body', () => {
  expect(patchDocumentProperties('---\n---\nbody', { flowix_favorited: true }).match(/---/g)).toHaveLength(2);
  expect(patchDocumentProperties('\uFEFFbody', { flowix_favorited: true })).not.toContain('\uFEFF');
  expect(patchDocumentProperties('body\n---\nstatus: prose\n---\n', { flowix_favorited: true })).toContain('body\n---\nstatus: prose\n---\n');
});
