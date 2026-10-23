import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { StableCaret } from '../../app/flowix-web/features/editor/extensions/stable-caret';
import '../../app/flowix-web/styles/editor.css';

const report = document.querySelector('#indent-layout-result');
const root = document.documentElement;
const cases = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function near(actual, expected, message) {
  check(Math.abs(actual - expected) < 1, `${message}: expected ${expected}, got ${actual}`);
}
function characterLeft(node) {
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  return range.getBoundingClientRect().left;
}

const host = document.createElement('div');
host.className = 'markdown-editor';
host.innerHTML = '<div class="editor-content"><div class="editor-document-body"></div></div>';
document.body.append(host);
const editor = new Editor({
  element: host.querySelector('.editor-document-body'),
  extensions: [StarterKit, Placeholder.configure({ placeholder: '输入正文' }), StableCaret],
  content: '<p></p>',
});

async function run() {
  try {
    editor.view.focus();
    await settle();
    const caret = host.querySelector('.stable-editor-caret--document');
    check(caret && !caret.hidden, 'The production stable caret must be visible');

    // Short paragraphs retain their dimensions when text-indent changes. This
    // catches stale overlay coordinates that a ResizeObserver alone cannot see.
    for (const content of ['<p></p>', '<p>正文</p>']) {
      editor.commands.setContent(content);
      editor.commands.setTextSelection(1);
      root.style.setProperty('--editor-first-line-indent', '0em');
      await settle();
      const before = editor.view.coordsAtPos(1).left;
      const documentBefore = JSON.stringify(editor.getJSON());
      root.style.setProperty('--editor-first-line-indent', '2em');
      await settle();
      const after = editor.view.coordsAtPos(1).left;
      near(after - before, 32, `First-line displacement for ${content}`);
      near(caret.getBoundingClientRect().left, after, `Stable caret after changing indentation for ${content}`);
      check(JSON.stringify(editor.getJSON()) === documentBefore, 'Changing indentation must preserve document content');
      root.style.setProperty('--editor-first-line-indent', '0em');
      await settle();
      near(caret.getBoundingClientRect().left, before, 'Stable caret after removing indentation');
    }
    cases.push('empty/text paragraph caret updates without resizing');

    root.style.setProperty('--editor-first-line-indent', '2em');
    editor.commands.setContent('<p>正文</p>');
    editor.commands.setTextSelection(3);
    check(editor.commands.keyboardShortcut('Enter'), 'Enter must create a paragraph');
    check(editor.state.doc.childCount === 2, 'Enter must produce two paragraphs');
    await settle();
    const emptyParagraphLeft = editor.view.dom.lastElementChild.getBoundingClientRect().left;
    const insertionLeft = editor.view.coordsAtPos(editor.state.selection.head).left;
    near(insertionLeft - emptyParagraphLeft, 32, 'New empty paragraph must start at the indent');
    near(caret.getBoundingClientRect().left, insertionLeft, 'Caret must follow Enter into the new paragraph');
    editor.commands.insertContent('下一行');
    check(editor.commands.keyboardShortcut('Shift-Enter'), 'Shift+Enter must insert a hard break');
    editor.commands.insertContent('软换行');
    await settle();
    const paragraph = editor.view.dom.lastElementChild;
    check(paragraph.tagName === 'P' && paragraph.querySelector('br'), 'Soft break must remain inside the paragraph');
    near(characterLeft(paragraph.firstChild) - characterLeft(paragraph.lastChild), 32,
      'Only the first line of a paragraph should be indented');
    cases.push('Enter creates indented paragraphs; Shift+Enter keeps subsequent lines flush');

    root.style.setProperty('--editor-font-size', '22px');
    await settle();
    near(characterLeft(paragraph.firstChild) - characterLeft(paragraph.lastChild), 44, 'Indentation must follow font size');
    cases.push('2em scales with font size');

    editor.commands.setContent('<p>　原有空格</p><h2>标题</h2><ul><li><p>列表</p></li></ul><blockquote><p>引用</p></blockquote>');
    await settle();
    for (const element of editor.view.dom.querySelectorAll('h2, li p, blockquote p')) {
      near(parseFloat(getComputedStyle(element).textIndent), 0, 'Nested blocks and headings must not inherit body indentation');
    }
    const saved = JSON.stringify(editor.getJSON());
    root.style.setProperty('--editor-first-line-indent', '0em');
    await settle();
    check(JSON.stringify(editor.getJSON()) === saved, 'Existing spaces must survive changing the display preference');
    cases.push('nested blocks excluded; original spaces preserved');
    report.textContent = JSON.stringify({ ok: true, cases });
  } catch (error) {
    report.textContent = JSON.stringify({ ok: false, error: error.stack ?? String(error), cases });
  } finally {
    editor.destroy();
  }
}
void run();
