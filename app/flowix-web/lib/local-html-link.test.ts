import { describe, expect, it } from 'vitest';
import { resolveLocalHtmlLink } from './local-html-link';

const resolve = (href: string, source = '/book/导览 #1%.html', baseHref: string | null = null) =>
  resolveLocalHtmlLink({ href, baseHref }, source);

describe('local HTML link resolution', () => {
  it('resolves regular relative URLs and encoded filenames from the original HTML file', () => {
    expect(resolve('../docs/笔记%20%23%25.md#标题')).toEqual({ kind: 'file', path: '/docs/笔记 #%.md', anchor: '标题' });
    expect(resolve('report.pdf')).toMatchObject({ kind: 'file', path: '/book/report.pdf' });
    expect(resolve('file:///outside/a%20b.json')).toMatchObject({ kind: 'file', path: '/outside/a b.json' });
  });
  it('honors local and remote HTML base URLs', () => {
    expect(resolve('readme.md', undefined, '../docs/')).toMatchObject({ path: '/docs/readme.md' });
    expect(resolve('page?q=1#part', undefined, 'https://example.com/docs/')).toEqual({ kind: 'web', url: 'https://example.com/docs/page?q=1#part' });
    expect(resolve('#section', undefined, 'https://example.com/')).toMatchObject({ kind: 'web', url: 'https://example.com/#section' });
  });
  it('handles Windows drives, UNC and asset protocol paths without double decoding', () => {
    expect(resolve('a%2520b.md', 'C:\\Notes\\index.html')).toMatchObject({ path: 'C:/Notes/a%20b.md' });
    expect(resolve('a.pdf', '\\\\server\\share\\index.html')).toMatchObject({ path: '//server/share/a.pdf' });
    expect(resolve('asset://localhost/Users/me/a%20b.md')).toMatchObject({ path: '/Users/me/a b.md' });
    expect(resolve('http://asset.localhost/C%3A%5CNotes%5Ca.pdf')).toMatchObject({ path: 'C:\\Notes\\a.pdf' });
  });
  it('allows navigation protocols and rejects executable or malformed URLs', () => {
    expect(resolve('https://example.com/a')).toMatchObject({ kind: 'web' });
    expect(resolve('flowix://open?notebookId=b&relativePath=a.md')).toMatchObject({ kind: 'flowix' });
    expect(resolve('mailto:a@example.com')).toMatchObject({ kind: 'external' });
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///bad%ZZ.md', 'java\nscript:alert(1)']) {
      expect(() => resolve(href)).toThrow();
    }
  });
});
