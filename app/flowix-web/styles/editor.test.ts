import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { afterEach, expect, it } from 'vitest';

const editorCss = readFileSync(resolve('app/flowix-web/styles/editor.css'), 'utf8');

afterEach(() => {
  document.body.replaceChildren();
});

it('indents document paragraphs without affecting headings, nested blocks, or conversations', () => {
  document.body.innerHTML = `
    <div class="markdown-editor">
      <div class="editor-document-body">
        <div class="tiptap ProseMirror">
          <h1 id="heading">标题</h1>
          <p id="body">正文第一行<br>正文第二行</p>
          <ul><li><p id="list">列表</p></li></ul>
          <ul data-type="taskList"><li><p id="task">任务</p></li></ul>
          <blockquote><p id="quote">引用</p></blockquote>
          <pre id="code"><code>代码</code></pre>
          <table><tbody><tr><td><p id="table">表格</p></td></tr></tbody></table>
          <section class="agent-thread-card">
            <div class="agent-thread-card__message"><p id="message">消息</p></div>
            <div class="tiptap ProseMirror agent-composer__input-content"><p id="composer">输入</p></div>
          </section>
        </div>
      </div>
    </div>
    <div class="tiptap"><p id="other-editor">其他编辑器</p></div>
    <div class="markdown-preview"><p id="preview">Markdown 预览</p></div>
  `;
  const indentationSelectors: string[] = [];
  parse(editorCss).walkRules((rule) => {
    rule.walkDecls('text-indent', (declaration) => {
      if (declaration.value.includes('--editor-first-line-indent')) indentationSelectors.push(rule.selector);
    });
  });
  expect(indentationSelectors.length).toBeGreaterThan(0);

  const indentedNodes = [...document.body.querySelectorAll('[id]')]
    .filter((node) => indentationSelectors.some((selector) => node.matches(selector)));

  expect(indentedNodes.map((node) => node.id)).toEqual(['body']);
});
