import { describe, expect, it } from 'vitest';
import { canonicalUrl, contentIdentityKey } from './workspace-content-identity';

describe('workspace content identity', () => {
  it('normalizes web URLs without collapsing the scheme separator', () => {
    expect(canonicalUrl('  HTTPS://Example.com/docs  ')).toBe('https://example.com/docs');
    expect(contentIdentityKey({ kind: 'web', url: 'https://example.com/docs' })).toBe(
      'web:https://example.com/docs',
    );
  });

  it('uses the same path identity for notebook notes and external files', () => {
    expect(contentIdentityKey({ kind: 'external', path: '/notes/same-id.md' })).toBe(
      'file:/notes/same-id.md',
    );
    expect(contentIdentityKey({ kind: 'media', path: '/notes/same-id.md' })).toBe(
      'file:/notes/same-id.md',
    );
  });
});
