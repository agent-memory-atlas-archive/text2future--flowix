#!/usr/bin/env node
// CHROME_BIN=/path/to/chrome npm run check:editor-indent-layout
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_BIN ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
assert(chrome, 'Set CHROME_BIN to a Chromium browser.');
const folder = await mkdtemp(join(tmpdir(), 'flowix-indent-layout-'));
let browser;
let socket;
try {
  await build({
    absWorkingDir: root,
    entryPoints: ['scripts/fixtures/editor-indent-layout.js'],
    bundle: true, format: 'iife', platform: 'browser',
    alias: { '@': resolve(root, 'app/flowix-web') },
    outfile: join(folder, 'probe.js'),
  });
  const html = join(folder, 'probe.html');
  await writeFile(html, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="probe.css">
<style>
:root { --editor-font-family: sans-serif; --editor-font-size: 16px;
  --editor-line-height: 1.8; --editor-first-line-indent: 0em; }
.markdown-editor { height: auto; overflow: visible; width: 600px; }
.editor-content { height: auto; overflow: visible; }
.markdown-editor .ProseMirror { min-height: 0; max-width: 600px; }
</style>
<pre id="indent-layout-result">Running…</pre><script src="probe.js"></script>`);
  browser = spawn(chrome, [
    '--headless', '--disable-gpu', '--allow-file-access-from-files',
    `--user-data-dir=${join(folder, 'chrome')}`, '--remote-debugging-port=0',
    '--no-first-run', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    browser.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    browser.once('error', reject);
    browser.once('exit', (code) => reject(new Error(`Chrome exited (${code}): ${stderr}`)));
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('Chrome debugging connection closed.'));
    pending.clear();
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await call('Target.createTarget', { url: pathToFileURL(html).href });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.bringToFront', {}, sessionId);
  let result;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await call('Runtime.evaluate', {
      expression: 'document.querySelector("#indent-layout-result")?.textContent',
      returnByValue: true,
    }, sessionId);
    const value = response.result?.value;
    if (value && value !== 'Running…') {
      result = JSON.parse(value);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(result, 'Browser did not return an indentation report.');
  assert(result.ok, result.error);
  console.log(`Editor indentation passed: ${result.cases.join(', ')}.`);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const closed = once(browser, 'close');
    browser.kill();
    await closed;
  }
  await rm(folder, { recursive: true, force: true });
}
