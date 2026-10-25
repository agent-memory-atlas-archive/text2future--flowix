#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(ROOT, '.build/web-dist');
const indexPath = join(DIST, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const failures = [];

const manifestPath = join(DIST, '.vite', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// All three lazy roots render concurrently in the default desktop window.
// Follow their static imports recursively; checking index.html alone misses
// Vite's runtime __vitePreload dependency graph.
//
// Rollup may merge the `features/shell` facade into an anonymous shared
// dynamic chunk. In that case the manifest has no stable
// `features/shell/index.ts` key, so resolve the chunk from the index entry's
// dynamic imports by its exported startup marker instead of making the budget
// check depend on a content hash.
function findDynamicChunkContaining(entryKey, marker) {
  const entry = manifest[entryKey];
  for (const candidateKey of entry?.dynamicImports ?? []) {
    const candidate = manifest[candidateKey];
    if (!candidate?.file?.endsWith('.js')) continue;
    const source = readFileSync(resolve(DIST, candidate.file), 'utf8');
    if (source.includes(marker)) return candidateKey;
  }
  return null;
}

const shellStartupRoot = findDynamicChunkContaining('index.html', 'MainLayout');
if (!shellStartupRoot) {
  failures.push('manifest has no desktop startup root/import: features/shell/index.ts');
}
const desktopStartupRoots = [
  'index.html',
  shellStartupRoot,
  'app/main-window-effects.tsx',
  'app/agent-window-effects.tsx',
].filter((key) => key !== null);
const startupManifestKeys = new Set();

function visitStaticImports(key) {
  if (startupManifestKeys.has(key)) return;
  const chunk = manifest[key];
  if (!chunk) {
    failures.push(`manifest has no desktop startup root/import: ${key}`);
    return;
  }
  startupManifestKeys.add(key);
  for (const importedKey of chunk.imports ?? []) {
    visitStaticImports(importedKey);
  }
}

for (const root of desktopStartupRoots) visitStaticImports(root);

let startupRawBytes = 0;
let startupGzipBytes = 0;
for (const key of startupManifestKeys) {
  const chunk = manifest[key];
  if (!chunk?.file?.endsWith('.js')) continue;
  const bytes = readFileSync(resolve(DIST, chunk.file));
  startupRawBytes += bytes.byteLength;
  startupGzipBytes += gzipSync(bytes).byteLength;
}

// Budgets track the desktop startup graph (`index.html` + `features/shell/` +
// `app/main-window-effects.tsx` + `app/agent-window-effects.tsx`).
//
// 2026-10 收紧：把 agent-session-store 那条链（约 456 KB raw / 138 KB gzip）移出
// 启动图后，实测为 1,036 KB raw / 323 KB gzip。预算按"实测 + 5%"设为棘轮，
// 只允许下降，不允许靠改常数回涨。如果确实需要空间，先找能懒加载的模块，
// 不要抬这个数字。
const STARTUP_RAW_BUDGET = 1_090_000;
const STARTUP_GZIP_BUDGET = 340_000;
if (startupRawBytes > STARTUP_RAW_BUDGET) {
  failures.push(`desktop startup JavaScript is ${startupRawBytes} bytes, budget is ${STARTUP_RAW_BUDGET}`);
}
if (startupGzipBytes > STARTUP_GZIP_BUDGET) {
  failures.push(`desktop startup gzip is ${startupGzipBytes} bytes, budget is ${STARTUP_GZIP_BUDGET}`);
}

const startupGrammarKeys = [...startupManifestKeys].filter((key) =>
  key.includes('node_modules/@shikijs/langs/'),
);
if (startupGrammarKeys.length > 0) {
  failures.push(`Shiki grammars entered desktop startup: ${startupGrammarKeys.join(', ')}`);
}

const optionalHeavyChunks = ['mermaid', 'shiki', 'katex', 'cytoscape'];
for (const name of optionalHeavyChunks) {
  if (new RegExp(`modulepreload[^>]+${name}`, 'i').test(html)) {
    failures.push(`optional ${name} chunk is preloaded by index.html`);
  }
}

function referencedAsset(pattern, label, maxBytes) {
  const match = html.match(pattern);
  if (!match) {
    failures.push(`index.html has no ${label} asset`);
    return;
  }
  const path = resolve(DIST, match[1]);
  const bytes = statSync(path).size;
  if (bytes > maxBytes) {
    failures.push(`${label} is ${bytes} bytes, budget is ${maxBytes}`);
  }
}

referencedAsset(/<script[^>]+src="([^"]+\.js)"/, 'entry JavaScript', 700_000);
referencedAsset(/<link[^>]+href="([^"]+\.css)"/, 'entry CSS', 500_000);

const interFonts = readdirSync(join(DIST, 'assets')).filter((name) =>
  /^inter-.*\.(?:woff2?|ttf)$/i.test(name),
);
if (interFonts.length > 12) {
  failures.push(`Inter emits ${interFonts.length} font files, budget is 12`);
}
if (interFonts.some((name) => !name.endsWith('.woff2'))) {
  failures.push(`legacy Inter font formats emitted: ${interFonts.map(basename).join(', ')}`);
}

const markdownParserWorker = readdirSync(join(DIST, 'assets')).find((name) =>
  /^markdown-parser\.worker-.+\.js$/.test(name),
);
if (!markdownParserWorker) {
  failures.push('Markdown parser Worker bundle is missing');
} else {
  const parserWorkerPath = join(DIST, 'assets', markdownParserWorker);
  const parserWorkerSource = readFileSync(parserWorkerPath, 'utf8');
  // Includes the worker-safe DOM parser required to preserve raw HTML tables.
  if (statSync(parserWorkerPath).size > 750_000) {
    failures.push(`Markdown parser Worker is ${statSync(parserWorkerPath).size} bytes, budget is 750000`);
  }
  if (/\blocalStorage\b/.test(parserWorkerSource)) {
    failures.push('Markdown parser Worker includes browser storage code; keep feature stores out of its dependency graph');
  }
}

if (failures.length) {
  console.error(`\n❌ Web bundle budget failed\n\n${failures.map((item) => `  ${item}`).join('\n')}\n`);
  process.exit(1);
}

console.log(
  `✓ Web bundle budget passed (startup JS: ${startupRawBytes} raw / ${startupGzipBytes} gzip; Inter fonts: ${interFonts.length}/12)`,
);
