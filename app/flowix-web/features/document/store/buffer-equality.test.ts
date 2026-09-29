import { describe, expect, it } from 'vitest';

import { isContentSemanticallyEqual, isDocumentContentEqual } from './buffer-equality';

describe('document buffer semantic equality', () => {
  it('ignores line endings when frontmatter field order is unchanged', () => {
    const left = '---\r\nflowix_key: abc12345\r\nstatus: draft\r\n---\r\nbody\r\n';
    const right = '---\nflowix_key: abc12345\nstatus: draft\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(true);
  });

  it('recognizes frontmatter after leading blank lines', () => {
    const withBlankLines = '\n  \n---\nflowix_key: abc12345\nstatus: draft\n---\nbody\n';
    const canonical = '---\nflowix_key: abc12345\nstatus: draft\n---\nbody\n';
    expect(isContentSemanticallyEqual(withBlankLines, canonical)).toBe(true);
  });

  it('treats frontmatter field order as a real edit', () => {
    const left = '---\nflowix_key: abc12345\nstatus: draft\npriority: high\n---\nbody\n';
    const right = '---\nflowix_key: abc12345\npriority: high\nstatus: draft\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });

  it('treats a tags change as a real edit', () => {
    const left = '---\nflowix_key: abc12345\ntags: [product]\n---\nbody\n';
    const right = '---\nflowix_key: abc12345\ntags: [design]\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });

  it('does not discard changes in invalid YAML', () => {
    const left = '---\ntags: [product\n---\nbody\n';
    const right = '---\ntags: [design\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });

  it('keeps code and plain-text whitespace byte-sensitive', () => {
    const identity = {
      kind: 'md' as const,
      path: '/project/src/main.ts',
      displayId: 'display:test-main-ts',
    };
    expect(isDocumentContentEqual(identity, 'const value = 1;\n', 'const value = 1;')).toBe(false);
    expect(isDocumentContentEqual(identity, '\nconst value = 1;', 'const value = 1;')).toBe(false);
  });

  it('retains semantic comparison for external Markdown', () => {
    const identity = {
      kind: 'md' as const,
      path: '/notes/readme.md',
      displayId: 'display:test-readme-md',
    };
    expect(isDocumentContentEqual(identity, 'body\n', 'body')).toBe(true);
  });

  it('ignores a legacy BOM displaced behind frontmatter', () => {
    const legacy = '---\nflowix_key: abc12345\n---\n\uFEFFbody\n';
    const repaired = '---\nflowix_key: abc12345\n---\nbody\n';
    expect(isContentSemanticallyEqual(legacy, repaired)).toBe(true);
  });
});
