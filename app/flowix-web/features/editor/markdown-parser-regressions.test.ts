import { Editor, type JSONContent } from '@tiptap/core';
import { OrderedList, TaskList } from '@tiptap/extension-list';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMarkdownEditorExtensions } from './markdown-editor-extensions';
import { createMarkdownParserExtensions } from './markdown-parser-extensions';
import { FLOWIX_AGENT_THREAD_CARD_MARKER } from '@features/agent/thread-card/agent-thread-card-markdown';

type Request = { id: number; markdown: string };
type Reply = { ok: boolean; document?: JSONContent; error?: string };
let receive: (event: MessageEvent<Request>) => void;
let reply: Reply;
const editors: Editor[] = [];

beforeAll(async () => {
  vi.stubGlobal('self', {
    addEventListener: (_type: string, callback: typeof receive) => { receive = callback; },
    postMessage: (value: Reply) => { reply = value; },
  });
  await import('./markdown-parser.worker');
});

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));
afterAll(() => vi.unstubAllGlobals());

function parseInWorker(markdown: string): JSONContent {
  reply = { ok: false };
  receive({ data: { id: 1, markdown } } as MessageEvent<Request>);
  expect(reply.ok, reply.error).toBe(true);
  return reply.document!;
}

function createEditor(content: string | JSONContent): Editor {
  const editor = new Editor({
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'main-third',
      getPlaceholder: () => '',
    }),
    content,
    contentType: typeof content === 'string' ? 'markdown' : 'json',
  });
  editors.push(editor);
  return editor;
}

const cardMetadata = JSON.stringify({
  version: 1,
  threadId: 'thread-1',
  agentType: 'codex',
  collapsed: false,
  fullscreen: false,
});

describe('worker parses content that previously forced the browser parser', () => {
  it('registers guarded list tokenizers instead of the stock ones', () => {
    const extensions = createMarkdownParserExtensions();
    const ordered = extensions.filter(extension => extension.name === 'orderedList');
    const task = extensions.filter(extension => extension.name === 'taskList');
    // Registering both the stock and the guarded extension runs the expensive
    // tokenizer twice, which is slower than not guarding at all.
    expect(ordered).toHaveLength(1);
    expect(task).toHaveLength(1);
    expect(ordered[0]).not.toBe(OrderedList);
    expect(task[0]).not.toBe(TaskList);
  });

  it('keeps a new-form Agent Thread Card as a node', () => {
    const document = parseInWorker(
      `Before\n\n<!-- ${FLOWIX_AGENT_THREAD_CARD_MARKER} ${cardMetadata} -->\n\nAfter`,
    );
    const card = document.content?.find(node => node.type === 'agentThreadCard');
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).toContain('thread-1');
  });

  it('keeps a legacy Agent Thread Card as a node', () => {
    const document = parseInWorker(
      'Before\n\n::agent-thread-card{threadId="thread-legacy" agentType="codex"}\n\nAfter',
    );
    const card = document.content?.find(node => node.type === 'agentThreadCard');
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).toContain('thread-legacy');
  });

  it.each([
    ['block html', 'Before\n\n<div>keep me</div>\n\nAfter'],
    ['inline html', 'a <span class="x">keep</span> b'],
    ['hard break', 'line one\n<br>\nline two'],
    ['void html', 'Before\n\n<img src="a.png" alt="pic">\n\nAfter'],
    ['html comment', 'Before\n\n<!-- secret -->\n\nAfter'],
    ['html table', 'Before\n\n<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>\n\nAfter'],
  ])('parses raw HTML (%s) instead of rejecting the note', (_name, source) => {
    const workerDocument = parseInWorker(source);
    expect(createEditor(workerDocument).getJSON()).toEqual(createEditor(source).getJSON());
  });

  it('still parses flowix reference markers', () => {
    const document = parseInWorker([
      'Before',
      '',
      '<!-- flowix:table-reference {"version":1,"path":"a.md"} -->',
      '',
      '<!-- flowix:media-library-reference {"version":1,"path":"a.png"} -->',
      '',
      'After',
    ].join('\n'));
    const types = (document.content ?? []).map(node => node.type);
    expect(types).toContain('tableReference');
    expect(types).toContain('mediaLibraryReference');
  });

  // The worker bounds each block tokenizer's `start()` scan to a prefix of the
  // remaining document. These cases guard that every construct is still found.
  it.each([
    ['math block', 'Before\n\n$$\nx^2 + y^2\n$$\n\nAfter'],
    ['web card', 'Before\n\n::webcard[{"url":"https://example.com","title":"Example"}]\n\nAfter'],
    ['table metadata', '<!-- flowix:table {"version":1,"columns":[{"width":120}]} -->\n\n| a |\n| --- |\n| 1 |'],
    ['table widths', '<!-- flowix:table-widths=120,80 -->\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['table reference', 'Before\n\n<!-- flowix:table-reference {"version":1,"path":"a.md"} -->\n\nAfter'],
    ['media reference', 'Before\n\n<!-- flowix:media-library-reference {"version":1,"path":"a.png"} -->\n\nAfter'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['bullet list', '- one\n- two\n\nplain'],
    ['ordered list', '1. one\n2. two'],
  ])('parses %s identically on both paths', (_name, source) => {
    const workerDocument = parseInWorker(source);
    expect(createEditor(workerDocument).getJSON()).toEqual(createEditor(source).getJSON());
  });

  // These two mount NodeViews that need the Tauri runtime, so the comparison
  // stays at the parsed JSON level.
  it('finds media style comments ahead of an image', () => {
    const document = parseInWorker(
      'Before\n\n<!-- flowix:media {"flowix":"media","version":1,"style":{"width":"60%"}} -->\n![x](asset://image-key)\n\nAfter',
    );
    expect(JSON.stringify(document)).toContain('"image"');
  });

  it('finds inline note references', () => {
    const document = parseInWorker('See [[wiki note]] inline.');
    expect(JSON.stringify(document)).toContain('noteReference');
  });
});
