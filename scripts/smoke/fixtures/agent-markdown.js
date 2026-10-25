// 冒烟 3：Agent 消息渲染的安全护栏。
//
// 这条链路把模型输出变成 HTML 再塞进 DOM（template.innerHTML），是整套前端里
// 唯一"外来内容 → 可执行标记"的通道。头号风险不是渲染错，而是渲染成功但把
// raw HTML / javascript: 链接一起放过去。jsdom 单测覆盖不到浏览器真实的
// HTML 解析差异，所以放在真实 Chromium 里跑。

import { check, assert, installCrashGuard, report } from './harness.js';

installCrashGuard();

const { renderAgentThreadCardMarkdownToHtml } = await import(
  '@features/agent/thread-card/agent-thread-card-markdown'
);

function mount(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

check('renders GFM structure', () => {
  const html = renderAgentThreadCardMarkdownToHtml('## 标题\n\n- a\n- b\n\n```ts\nconst x = 1;\n```');
  assert(html.includes('<h2'), '标题未渲染');
  assert(html.includes('<li'), '列表未渲染');
  assert(html.includes('<code'), '代码块未渲染');
});

check('raw HTML is rendered as text, never as markup', () => {
  const raw = '<img src=x onerror="window.__xss=1">';
  const html = renderAgentThreadCardMarkdownToHtml(raw);
  const host = mount(html);
  assert(host.querySelector('img') === null, 'raw HTML 被当成标记渲染（XSS 面）');
  assert(!host.innerHTML.includes('<img'), 'DOM 里出现了真实 img 标签');
  assert(host.textContent.includes(raw), 'raw HTML 没有被当作纯文本保留（内容丢失）');
  assert((window.__xss ?? undefined) === undefined, 'onerror 被触发');
});

check('javascript: and data: links are neutralised', () => {
  const html = renderAgentThreadCardMarkdownToHtml(
    '[a](javascript:alert(1))\n\n[b](data:text/html,<script>alert(1)</script>)\n\n[c](https://example.com)',
  );
  const host = mount(html);
  const hrefs = [...host.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');
  assert(
    !hrefs.some((href) => /^javascript:/i.test(href.replaceAll(/\s/g, ''))),
    `javascript: 链接被保留：${JSON.stringify(hrefs)}`,
  );
  assert(!hrefs.some((href) => /^data:/i.test(href)), `data: 链接被保留：${JSON.stringify(hrefs)}`);
  assert(hrefs.some((href) => href === 'https://example.com'), `正常 https 链接被误杀：${JSON.stringify(hrefs)}`);
});

check('script tags do not execute', () => {
  const html = renderAgentThreadCardMarkdownToHtml('<script>window.__scriptRan=1</script>');
  const host = mount(html);
  assert(host.querySelector('script') === null, 'script 节点进入了 DOM');
  assert((window.__scriptRan ?? undefined) === undefined, 'script 被执行');
});

report({ case: 'agent-markdown' });
