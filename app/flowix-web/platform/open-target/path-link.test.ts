import { describe, expect, it } from 'vitest';
import { buildNoteOpenLink, buildNoteOpenLinkFromPath } from './path-link';

describe('path deep links', () => {
  it('encodes notebook, nested path, and heading without an ID', () => {
    const link = buildNoteOpenLink('My Vault', 'Projects/Plan.md', 'Goals');
    expect(link).toBe('flowix://open?book=My+Vault&file=Projects%2FPlan.md&heading=Goals');
    expect(link).not.toContain('memo/');
  });

  it('distinguishes a literal # in the filename from a heading', () => {
    expect(buildNoteOpenLink('A', 'Plan#Goals.md')).toBe('flowix://open?book=A&file=Plan%23Goals.md&heading=');
  });

  it('uses the exact notebook root and refuses ambiguous names', () => {
    const books = [
      { name: 'Root', path: 'C:/Notes' },
      { name: 'Nested', path: 'C:/Notes/Book' },
    ];
    expect(buildNoteOpenLinkFromPath('C:/Notes/Book/Plan.md', books)).toBe('flowix://open?book=Nested&file=Plan.md');
    expect(buildNoteOpenLinkFromPath('c:/notes/book/Plan.md', books)).toBe('flowix://open?book=Nested&file=Plan.md');
    expect(buildNoteOpenLinkFromPath('C:/Notes/Book/Plan.md', [...books, { name: 'Nested', path: 'D:/Other' }])).toBeNull();
  });
});
