#!/usr/bin/env node
// scripts/check-architecture.mjs
//
// 架构边界门禁：用「策略 + 基线」代替逐文件白名单。
//
// 规则来自 architecture.config.json，不来自本文件里的路径清单：
//   - 跨 feature 只能 import 对方的 public/ 入口
//   - 组合根（app/）对 feature 也只能走 public/ 入口
//   - foundation（lib/shared/platform）不得反向依赖 features/app
//   - features/lib/shared 不得直接 import @tauri-apps/*
//
// 存量违规记录在 architecture-baseline.json；新增违规直接失败、基线只减不增。
// 收紧基线：node scripts/check-architecture.mjs --update-baseline
//
// 设计说明见 docs/FRONTEND-ARCH-REMEDIATION-PLAN.md 1.2。

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));
const BASELINE = fileURLToPath(new URL('../architecture-baseline.json', import.meta.url));
const update = process.argv.includes('--update-baseline');

const FROM_RE = /\b(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.build') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(path);
  }
  return acc;
}

const isTest = (file) => /\.(test|spec)\.(ts|tsx)$/.test(file);
const rel = (file) => relative(ROOT, file).replaceAll('\\', '/');
const layerOf = (path) => (path.startsWith('app/') ? 'app' : path.split('/')[0]);
const featureOf = (path) => (path.startsWith('features/') ? path.split('/')[1] : null);

const files = walk(ROOT).filter((file) => !isTest(file));
const violations = [];
const edges = new Map();

function readSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  const specs = [];
  for (const re of [FROM_RE, DYN_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) specs.push(match[1]);
  }
  return specs;
}

function report(kind, path, spec) {
  violations.push(`${kind}:${path}|${spec}`);
}

for (const file of files) {
  const path = rel(file);
  const layer = layerOf(path);
  const self = featureOf(path);

  for (const spec of readSpecifiers(file)) {
    if (layer === 'foundation' && /^@(features|app)\//.test(spec)) {
      report('reverse-dependency', path, spec);
      continue;
    }

    if (!spec.startsWith('@tauri-apps/')) continue;
    if (layer === 'platform' || layer === 'app') continue;
    report('tauri-direct', path, spec);
  }

  for (const spec of readSpecifiers(file)) {
    if (!spec.startsWith('@features/')) continue;
    const target = spec.split('/')[1];
    if (!target) continue;
    const isPublic = spec.startsWith(`@features/${target}/public/`);

    if (!self) {
      // 组合根只认 public 入口，且不豁免；它不该知道任何 feature 的内部形状。
      if (!isPublic) report('composition-private', path, spec);
      continue;
    }

    if (target === self) continue;
    if (!edges.has(self)) edges.set(self, new Set());
    edges.get(self).add(target);
    if (!isPublic) report('cross-feature-private', path, spec);
  }
}

// feature 级双向依赖：A 依赖 B 且 B 依赖 A。
// 这类环让 lazy 边界、初始化顺序、单模块测试全部失效，因此单独计数并纳入基线。
const cycles = [];
for (const [from, targets] of edges) {
  for (const to of targets) {
    if (from < to && edges.get(to)?.has(from)) cycles.push(`${from}<->${to}`);
  }
}

const imports = [...new Set(violations)].sort();
const cycleList = [...new Set(cycles)].sort();

if (update) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ imports, cycles: cycleList }, null, 2)}\n`,
  );
  console.log(
    `✓ 架构基线已更新：${imports.length} 条存量引用，${cycleList.length} 对双向依赖`,
  );
  process.exit(0);
}

const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : { imports: [], cycles: [] };
const allowedImports = new Set(baseline.imports ?? []);
const allowedCycles = new Set(baseline.cycles ?? []);

const newImports = imports.filter((key) => !allowedImports.has(key));
const newCycles = cycleList.filter((key) => !allowedCycles.has(key));
const staleImports = (baseline.imports ?? []).filter((key) => !imports.includes(key));
const staleCycles = (baseline.cycles ?? []).filter((key) => !cycleList.includes(key));

if (newImports.length > 0 || newCycles.length > 0) {
  console.error(
    `\n❌ 架构违规：新增 ${newImports.length} 条引用 / ${newCycles.length} 对新双向依赖\n`,
  );
  for (const key of newImports) console.error(`  + ${key}`);
  for (const key of newCycles) console.error(`  + cycle:${key}`);
  console.error(
    '\n修复方向：给目标 feature 补 public API，或把共享模型下沉到 domain/。\n'
      + '禁止用 --update-baseline 直接放行新违规；只有删除存量时才允许收紧基线。\n',
  );
  process.exit(1);
}

const count = (kind) => imports.filter((key) => key.startsWith(`${kind}:`)).length;
console.log(
  `✓ 架构检查通过（存量 ${imports.length}/${allowedImports.size} 条引用，`
    + `双向依赖 ${cycleList.length}/${allowedCycles.size} 对）`,
);
console.log(
  `  跨模块私有 ${count('cross-feature-private')} · 组合根私有 ${count('composition-private')}`
    + ` · Tauri 直引 ${count('tauri-direct')} · 低层反向 ${count('reverse-dependency')}`,
);
if (staleImports.length > 0 || staleCycles.length > 0) {
  console.log(
    `  可收紧基线：${staleImports.length} 条引用、${staleCycles.length} 对环已消失`
      + '（跑 npm run check:arch:baseline）',
  );
}
