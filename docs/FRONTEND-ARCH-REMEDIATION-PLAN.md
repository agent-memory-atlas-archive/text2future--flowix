# 前端架构整改实施方案

> 配套报告：`docs/FRONTEND-ARCH-REVIEW-2026-10-25.md`
> 目标：把已有架构意图变成**机器可执行的规则**，并打断最顽固的几条双向依赖。
> 原则：**先可执行，再谈重构**；P0 每项 ≤2 天且可独立合入；拆解按 seam（接缝）而非按文件。

---

## 落地状态（2026-10-25）

P0 的 1.1 → 1.5 已全部实施并验证：

| 项 | 状态 | 产物 | 验证结果 |
| --- | --- | --- | --- |
| 1.1 ESLint + pre-commit | ✅ 已落地 | `eslint.config.mjs`、`eslint-suppressions.json`（201 文件）、`lefthook.yml`、`.git/hooks/pre-commit` | `npm run lint` 通过（0 error / 202 warning）；在 `features/agent` 下引入私有跨模块 import 会立即报错 |
| 1.2 边界门禁（策略 + 基线） | ✅ 已落地 | `architecture.config.json`、`scripts/check-architecture.mjs`、`architecture-baseline.json`（456 条 / 36 对环）、CI 新增 `check:arch` | 通过；新增 1 条违规即 exit 1 |
| 1.3 面板级错误边界 | ✅ 已落地 | `shared/surface-boundary.tsx` + 4 个落点 + 根边界 `resetKeys`/`epoch` 重试 | 4 个新单测通过 |
| 1.4 异步错误收口 | ✅ 已落地 | `lib/fire-and-forget.ts`；逻辑层 26 个文件的 `console.*` 迁到 `createLogger`；5 处裸 `void promise` 改为 `fireAndForget` | **`check:frontend-debt` 转绿**：`any` 0/0、console 98/106（评审时是 10 / 144，红的） |
| 1.5 三条冒烟 | ✅ 已落地 | `scripts/smoke/run-smoke.mjs` + 3 个探针（boot / save-pipeline / agent-markdown），CI 新增 `npm run smoke` | 3/3 通过（真实 Chromium，零新增依赖） |
| 2.1 入口瘦身 | ✅ 已落地 | 6 条真实桥：`workspace-api` 拆分、preferences barrel 去 tab 配置、`shell-api` 窄入口 + 标题栏/状态栏 lazy、命令面板出 barrel、运行中投影拆两层、云模型目录链延后到 stage3 | 启动图 **1,511,114 / 467,176 → 1,035,976 / 322,791 gzip（−144 KB，−31%）**；`agent-session-store` chunk 完全离开启动图；预算改 ratchet 到 340 KB |

实施中与文档预期不同的四处，已按现实修正：

1. **ESLint 的 `no-restricted-imports` 不支持 `!` 否定**。`group: ['@features/x/**', '!@features/x/public/**']` 与 extglob `!(public)` 都会被当成普通字面量（前者命中全部、后者命中 0 条，都是"静默失效"）。最终改为**在 lint 时从文件系统枚举除 `public/` 外的真实子路径**，见 `privateEntrypointsOf()`。另外 `group` 必须是去重数组，否则 ESLint 会报一个与真实原因毫不相关的 schema 错误。
2. **既有门禁是红的**：`check:frontend-debt` 在评审时就已失败（10 处 `any`、console 144 > 106）。1.4 之后两项都收口了：`any` 0、console 98（低于 106 上限）。
3. **冒烟测试当场抓到一个真问题**：`agent-markdown` 探针发现 Markdown 链接（`[a](javascript:...)`）的 href 原样进入 DOM——此前的协议白名单只覆盖 raw `<a>` 与图片，链接只在**点击时**才净化。已在 `cardMarked` 的 `link` renderer 里补上 `sanitizeLinkHref`，不安全协议不写进 href（点击处理只认 `a[href]`，因此退化为不可点击文本）。
4. **2.1 的核心假设不成立**：入口 chunk 的大小不由"静态 import 边"决定，而由 `onlyExplicitManualChunks` 的上提行为 + 预算口径决定。删边只改善依赖方向，不减体积；加显式分块反而把启动图从 1.5 MB 推到 5.0 MB。详见 2.1 开头的实测修正。

---

## 0. 三条约束（避免这次治理变成一次性运动）

1. **所有规则必须可自动验证**。写进 docs 但检查不到的约定，一律视为不存在（当前 60% 的私有跨模块引用就是这么长出来的）。
2. **只允许单向下调**。删除违规必须同步下调基线；基线回涨视为 bug（和现有 `check-frontend-debt` 的 ratchet 同一套哲学）。
3. **动启动路径前必须先有冒烟测试**。2.1 依赖 1.5，这是硬依赖，不是建议。

---

## 1. P0：两周内做完的五件事

### 1.1 装 ESLint，用一条规则替掉 200 行白名单

**问题**：整个仓库没有任何 ESLint 依赖，`lefthook.yml` 是未修改的脚手架模板（所有钩子都被注释）。这直接导致 439 处裸 `void`、394 个 `useEffect` 无依赖校验。

**做法**

```bash
npm i -D eslint@^9 typescript-eslint eslint-plugin-react-hooks
```

新建 `eslint.config.mjs`（关键点：**按 feature 生成配置块**，而不是维护路径清单）。

> ⚠️ 已落地版本见仓库根目录的 `eslint.config.mjs`，与下面这版有一处关键差异，踩坑记录如下：
>
> `no-restricted-imports` 的 `group` **不支持否定**：
> - `['@features/x/**', '!@features/x/public/**']` → `!` 被当字面量，第一条已命中全部，public 也被封；
> - `['@features/x/!(public)/**']`（minimatch extglob）→ 同样不生效，一条都不命中，规则静默失效；
> - 另外 `group` 必须是**去重**数组，重复项会触发一个完全无关的 `additionalProperties` schema 报错。
>
> 最终实现改为「在 lint 时读文件系统，枚举目标 feature 下除 `public/` 之外的真实子路径」，见真实文件里的 `privateEntrypointsOf()`。这是本项目唯一一处必须绕过的 ESLint 语义限制。

示意结构（省略上述 `privateEntrypointsOf` 细节）：

```js
const crossFeatureRule = (self) => ({
  files: [`app/flowix-web/features/${self}/**/*.{ts,tsx}`],
  ignores: [`app/flowix-web/features/${self}/**/*.test.{ts,tsx}`],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: [...new Set(FEATURES
          .filter((other) => other !== self)
          .flatMap((other) => privateEntrypointsOf(other)))],
        message: '跨 feature 只能 import 对方的 public/ 入口；需要新能力请先补 public API。',
      }],
    }],
  },
});
```

其余骨架（与真实文件一致）：

```js
export default tseslint.config(
  { ignores: ['.build/**', 'node_modules/**', 'app/target/**', 'app/flowix-web/public/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['app/flowix-web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
  ...FEATURES.map((name) => crossFeatureRule(name)),
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-floating-promises': 'off' },
  },
);
```

**存量怎么办**（不要一次性全改）。实测首跑：473 个 error（其中 `no-restricted-imports` 420 条）+ 204 个 warning，已按下面的方式全部记入基线：

```bash
npx eslint . --suppress-all                        # 生成 eslint-suppressions.json（201 个文件，按 file+rule 计数）
npm run lint                                       # 之后新增的违规立即 error
npx eslint app/flowix-web --prune-suppressions     # 每清理一批，基线条目减少
```

抑制是**按 file + rule + count** 生效的，所以同一个文件里新增同类违规仍会失败，不是"整文件豁免"。

若团队 ESLint 版本不支持 bulk suppressions，则把 `no-restricted-imports` 先设 `warn` + `--max-warnings` 锁定当前数量，与 1.2 的基线文件配合。

**`lefthook.yml` 已激活这两条**（`lefthook` 已加入 devDependencies，`prepare: lefthook install` 让新克隆自动装钩子）：

```yaml
pre-commit:
  parallel: true
  jobs:
    - name: eslint
      glob: "*.{ts,tsx}"
      run: npx eslint {staged_files}
    - name: architecture
      glob: "*.{ts,tsx}"
      run: node scripts/check-architecture.mjs
```

**验收**：新增 1 处 `import { x } from '@features/memo/store/note-store'` 到 `features/agent` 下，`npm run lint` 立即失败。**风险**：`recommended` 全量可能有几百条噪音 → 只保留上面 6 条关键规则，`no-unused-vars` 之类交给 `tsc`（`noUnusedLocals` 已开）。

---

### 1.2 边界门禁改成「策略 + 基线」

**问题**：`scripts/check-layer-boundaries.mjs` 有 21 条硬编码路径条件（12 个精确文件名）。改文件名即静默失效；`features/shortcuts/actions.ts` 违反规则但从未报警。

**新增 `architecture.config.json`**（把规则从代码里搬出来）：

```json
{
  "layers": {
    "foundation": { "paths": ["lib", "shared", "platform"] },
    "features": { "paths": ["features/*"] },
    "coordination": { "paths": ["app", "features/workspace", "features/surface", "features/shell"] }
  },
  "rules": {
    "foundationMustNotImportFeatures": true,
    "featuresMustUsePublicEntrypoints": true,
    "noDirectTauriImportOutsidePlatform": true
  },
  "grandfathered": {
    "privateCrossFeatureImports": "architecture-baseline.json"
  }
}
```

**新增 `scripts/check-architecture.mjs`**（完整可落地，约 130 行）：

```js
#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));
const BASELINE = fileURLToPath(new URL('../architecture-baseline.json', import.meta.url));
const update = process.argv.includes('--update-baseline');

const FROM = /\b(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.build'].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(p);
  }
  return acc;
}

const isTest = (f) => /\.(test|spec)\.(ts|tsx)$/.test(f);
const rel = (f) => relative(ROOT, f).replaceAll('\\', '/');
const layerOf = (r) => (r.startsWith('app/') ? 'app' : r.split('/')[0]);
const moduleOf = (r) => (r.startsWith('features/') ? r.split('/')[1] : null);

const files = walk(ROOT).filter((f) => !isTest(f));
const found = []; // { key, kind }
const edges = new Map(); // feature -> Set<feature>

for (const file of files) {
  const r = rel(file);
  const src = readFileSync(file, 'utf8');
  const self = moduleOf(r);
  const specs = [];
  for (const re of [FROM, DYN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }

  for (const spec of specs) {
    if (spec.startsWith('@tauri-apps/') && layerOf(r) !== 'platform' && layerOf(r) !== 'app') {
      found.push({ key: `${r}|${spec}`, kind: 'tauri-direct' });
    }
    if (!spec.startsWith('@features/')) continue;
    const parts = spec.split('/');
    const target = parts[1];
    if (!self) {
      if (target && !spec.startsWith(`@features/${target}/public/`)) {
        found.push({ key: `${r}|${spec}`, kind: 'composition-private' });
      }
      continue;
    }
    if (target === self) continue;
    edges.set(self, (edges.get(self) ?? new Set()).add(target));
    if (!spec.startsWith(`@features/${target}/public/`)) {
      found.push({ key: `${r}|${spec}`, kind: 'cross-feature-private' });
    }
  }
}

// 低层反向依赖
for (const file of files) {
  const r = rel(file);
  if (!['lib', 'shared', 'platform'].includes(layerOf(r))) continue;
  const src = readFileSync(file, 'utf8');
  FROM.lastIndex = 0;
  let m;
  while ((m = FROM.exec(src))) {
    if (/^@(features|app)\//.test(m[1])) found.push({ key: `${r}|${m[1]}`, kind: 'reverse-dependency' });
  }
}

// feature 级环检测（Tarjan SCC 简化版：找到互相可达的对）
const cycles = [];
for (const [a, outs] of edges) {
  for (const b of outs) {
    if (a < b && edges.get(b)?.has(a)) cycles.push(`${a}<->${b}`);
  }
}

const keys = [...new Set(found.map((f) => `${f.kind}:${f.key}`))].sort();
const cyclesNow = [...new Set(cycles)].sort();

if (update) {
  writeFileSync(BASELINE, JSON.stringify({ imports: keys, cycles: cyclesNow }, null, 2) + '\n');
  console.log(`✓ 基线已更新：${keys.length} 条存量引用，${cyclesNow.length} 对双向依赖`);
  process.exit(0);
}

const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : { imports: [], cycles: [] };
const allowed = new Set(baseline.imports);
const newViolations = keys.filter((k) => !allowed.has(k));
const stale = baseline.imports.filter((k) => !keys.includes(k));
const newCycles = cyclesNow.filter((c) => !(baseline.cycles ?? []).includes(c));

if (newViolations.length || newCycles.length) {
  console.error(`\n❌ 架构违规：新增 ${newViolations.length} 条引用 / ${newCycles.length} 对新双向依赖\n`);
  for (const v of newViolations) console.error('  + ' + v);
  for (const c of newCycles) console.error('  + cycle ' + c);
  console.error('\n修复方向：补 public API，或把共享模型下沉到 domain/。禁止用 --update-baseline 直接放行。');
  process.exit(1);
}

console.log(
  `✓ 架构检查通过（存量 ${keys.length}/${allowed.size}，双向依赖 ${cyclesNow.length}/${(baseline.cycles ?? []).length}）`,
);
if (stale.length) console.log(`  可清理 ${stale.length} 条过期基线（跑 --update-baseline 收紧）`);
```

配套 `package.json`：

```json
"check:arch": "node scripts/check-architecture.mjs",
"check:arch:baseline": "node scripts/check-architecture.mjs --update-baseline"
```

**干跑结果**（上面的脚本已在本仓库实跑验证过）：

```
❌ 架构违规：新增 456 条引用 / 36 对新双向依赖
   cross-feature-private   431
   composition-private      25
   tauri-direct              0      ← 现有规则确实守住了
   reverse-dependency        0      ← 现有规则确实守住了
```

两个好消息：`@tauri-apps/*` 直接引用和低层反向依赖**已经是干净的**，说明现有门禁在这两条上是有效的；问题集中在"跨模块私有导入"和"组合根私有导入"两类，正好是新脚本能精确定位的。

**验收**：从某个 `public/*.ts` 里删掉一个导出 → 依赖它的跨模块文件立刻报 `cross-feature-private`（因为它改走了私有路径）或编译失败。基线条目数只减不增。**迁移策略**：新脚本与旧 `check-layer-boundaries.mjs` 并行跑一个版本周期，等新脚本覆盖旧规则后删除旧的（避免双轨制）。

---

### 1.3 按面板加 ErrorBoundary（当前面板崩溃 = 整窗白屏）

**问题**：生产代码里 `<ErrorBoundary>` 只有 3 处：`app.tsx` 两处（两个窗口的根）、`preferences-view.tsx` 一处。主窗口内所有面板共用一个根边界。且 `handleRetry` 只做 `setState({ hasError: false })`，没有重置，确定性错误会立刻再次抛出。

**新建 `shared/surface-boundary.tsx`**：

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '@/lib/logger';

const logger = createLogger('surface-boundary');

interface Props {
  name: string;
  resetKeys?: readonly unknown[];
  fallback?: (retry: () => void) => ReactNode;
  children: ReactNode;
}

interface State { error: Error | null; epoch: number }

export class SurfaceBoundary extends Component<Props, State> {
  state: State = { error: null, epoch: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error(`surface crashed: ${this.props.name}`, {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKeys?.some((k, i) => k !== this.props.resetKeys?.[i])) {
      this.retry();
    }
  }

  retry = (): void => this.setState((s: State) => ({ error: null, epoch: s.epoch + 1 }));

  render(): ReactNode {
    if (!this.state.error) {
      return <div key={this.state.epoch} className="contents">{this.props.children}</div>;
    }
    if (this.props.fallback) return this.props.fallback(this.retry);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">这个面板出错了，其余区域仍可正常使用。</p>
        <button type="button" className="icon-btn rounded-lg border px-3 py-1 text-sm" onClick={this.retry}>
          重新加载面板
        </button>
      </div>
    );
  }
}
```

**4 个落点**（`features/shell/main-layout.tsx`）：

| 行号 | 包住什么 | resetKeys |
| --- | --- | --- |
| ~774 | `<ListColumnContent>`（笔记列表/文件树） | `[selectedNotebook?.id]` |
| ~911 | `<WorkColumnContentHost>`（文档 / Agent / 表格 / 插件） | `[navigationState.target]` |
| ~928 | `<BrowserColumn>` | `[browserColumnLayoutKey]` |
| ~941 | `<MainStatusBarHost>` | `[]` |

`WorkColumnContentHost` 的 fallback 直接复用已有的"surface 不可用"UI（`workSurfaceFailed` 分支的呈现），保证视觉一致。

**同时修根边界的重试**：`shared/error-boundary.tsx` 的 `handleRetry` 增加"重新挂载子树"的语义（见上面 `epoch` 写法），并把 `componentDidCatch` 从 `console.error` 换成 `logger.error` + 预留上报钩子。

**验收**：在 `table-document-view.tsx` 里临时 `throw new Error('boom')`，只有第三列显示错误态，左列/右列/状态栏仍可用，点击"重新加载面板"能恢复。

---

### 1.4 异步错误收口

**问题**：439 处 `void promise`，300 处带 `.catch`；典型裸奔点：`app/user-config-sync.ts:25,38`（`void actions.reloadPreferences()` / `void actions.refreshAgentRuntime()`）、`platform/open-target/pending-requests.ts:39`。

**新建 `lib/fire-and-forget.ts`**：

```ts
import { createLogger } from '@/lib/logger';

const logger = createLogger('fire-and-forget');

/** 显式表达"不等待"的意图，同时保证异常不会变成 unhandled rejection。 */
export function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((error) => {
    logger.warn(`unhandled async failure: ${context}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
```

替换顺序：`app/**`（约 20 处）→ `features/*/store/**` → `features/*/services/**`。组件内部的 `void` 交给 1.1 的 `no-floating-promises` 兜底即可，不必手工全改。

**✅ 已落地**：`lib/fire-and-forget.ts`；已替换 5 处真正会漏异常的调用（`user-config-sync` 4 处、`use-main-window-business-controller`、`use-agent-workspace-window-lifecycle`、`agent-window-effects`、`document-session-service` 的自动草稿保护）。其余带 `.catch` 的 `void` 保持原样——它们已经处理了异常，改写成 `fireAndForget` 只是换写法。

同时把**逻辑层 26 个文件**的 `console.*` 迁到 `createLogger`（`app/`、`lib/`、`platform/`、`entrypoints/`、`features/*/{store,services,use-cases,runtime}/`），`check:frontend-debt` 的 console 计数从 144 降到 98，门禁转绿。

迁移遵守两条规则，保证日志文本与既有测试断言不变：`[domain] Message` 的方括号前缀抽成 `createLogger('domain')`；非对象上下文统一包成 `{ error }`。视图层剩下的 98 处留给后续批次。

**验收**：`app/` 与 `features/*/store/` 下不再出现裸 `void somePromise()`；lint 通过。

---

### 1.5 三条冒烟测试（复用现有 Chrome 探针，不引新依赖）

你们已经有一套零依赖的浏览器验证手法：`scripts/check-agent-style-boundaries.mjs` 用 esbuild 打包探针 → headless Chrome `--dump-dom` → 正则取 JSON 断言。冒烟测试直接沿用这套模式，不需要 Playwright。

新增 `scripts/smoke/`：

```
scripts/smoke/
├── run-smoke.mjs            # esbuild 打包 → chrome --dump-dom → 解析 JSON 断言
├── shims/tauri-stub.js      # 最小 __TAURI_INTERNALS__ 桩（invoke / transformCallback / metadata）
└── fixtures/
    ├── harness.js           # check / assert / report，把结果写回 <pre id="smoke-result">
    ├── boot.js              # case 1：真实入口冷启动，不白屏
    ├── save-pipeline.js     # case 2：保存链路的三个不变量
    └── agent-markdown.js    # case 3：Agent 消息渲染的安全护栏
```

三个 case 的实际断言（都不依赖真实 Tauri）：

1. **boot**：入口模块图加载不抛错 → `#root` 有内容 → 静态 spinner 被移除 → 出现启动屏或工作台 → 不是根错误页 → 无未捕获异常/unhandled rejection。
2. **save-pipeline**：同一文档任何时刻只有一个写者；latest-value 槽位下被替换的任务以 `true` 结算但**不执行**；capture 时钟 300ms 去抖合并三次输入为一次；`flush` 立即触发、`cancel` 不再触发。
3. **agent-markdown**：GFM 结构正常渲染；raw HTML 当文本（不产生 `<img>`、不触发 `onerror`）；`javascript:`/`data:` 链接被中和、正常 https 保留；`<script>` 不执行。

**为什么这三个而不是"编辑→输入→落盘"和"Agent 发送"**：后两者需要桩掉 `localDocumentOperations.write` 与 `agent-client` 的完整事件序列，桩的复杂度会超过被测逻辑本身，且容易变成"测桩"。改为测**不变量**（单写者、去抖合并、协议白名单），既能在真实浏览器里跑，又不依赖 IPC 细节。

**✅ 已落地**：`npm run smoke` 3/3 通过；CI web job 已加该步骤。第一个 case 目前停在启动屏（`surface: 'startup-screen'`），推进到工作台需要更完整的 IPC 桩，列为后续项（见"遗留"）。

---

## 2. P1：一个月内做完的四件事

### 2.1 入口瘦身：16 条静态边逐条处理

> **✅ 最终结果（2026-10-25，实测）**
>
> 结论：**入口瘦身确实能做，但真正的桥不在"16 条 app→feature 静态边"上**。把下面 6 处改完，桌面启动图从 **1,511,114 raw / 467,176 gzip** 降到 **1,035,976 raw / 322,791 gzip**（−475 KB raw / **−144 KB gzip，−31%**），`agent-session-store` 整个 chunk（456 KB raw / 138 KB gzip）完全离开启动图。预算同步改成 ratchet：`340 KB gzip`。
>
> | # | 桥 | 做法 | 收益 |
> | --- | --- | --- | --- |
> | 1 | `workspace-api` 同时导出目录查询与会话操作 | 拆出 `features/agent/public/workspace-session-api.ts`：目录查询继续静态依赖轻量的 `agent-workspace-store`（20 文件 / 3.3k 行），会话操作的 store 放进函数体动态 import。`hasWorkspaceAgentConversation` 因此变成异步（调用点本来就在 async 流程里） | 入口块 1,412 → 920 KB raw |
> | 2 | preferences barrel 转出 tab 配置 | `preferences/public/app-api.ts` 不再 re-export `PREFERENCE_TAB_GROUPS`，改走 `public/tabs-api.ts` | tab 配置含 `AgentIcon → lib/agent-types`，这条链离开启动图 |
> | 3 | `shell-api` barrel + 常驻 UI | 新建 `icon-api` / `titlebar-api` / `status-bar-api` / `new-conversation-api`；工作区标题栏、状态栏的会话片段改 `lazy()`（占位沿用 `WorkColumnTitlebar`，不产生高度跳变），新建会话命令改动态 import | barrel 里一条 re-export 就能带进 489 个文件的依赖图 |
> | 4 | `shell/index.ts` 转出命令面板 | 改走 `shell/public/search-api.ts`，由已有的 `LazyGlobalSearchCommand` 动态引入 | 命令面板只在按快捷键时需要，250 文件离开 shell 块 |
> | 5 | 运行中投影直连 session store | memo 的 `running-agent-index` 拆两层：轻量 `agent/store/running-agents-store`（首屏订阅的空表）+ `agent/store/running-agent-selector`（读 session store，stage3 后发布） | 笔记卡片"运行中"角标不再拉会话数据图。首帧空表在语义上是正确的：刚启动时不可能已有运行中的会话 |
> | 6 | 云模型目录链 | `agent-window-effects` 不再静态引 `pi-cloud-model-service`；整条 `catalog-service → agent-data-store / codex-slash-service → session-store` 改为 stage3 之后动态 import。首次快照推到 stage3，`listenerReady` 的首次回调交给 stage3（重连仍立即刷新） | **最后这 138 KB gzip** |
>
> **为什么上一版测出"改了体积不变"**：当时只改了 `app/agent-window-effects → useAgentEvents` 这一条边，而 session store 同时被 shell 块（经 memo-list / status-bar / shell-api）静态引用，chunk 归属不变，删一条边只是把引用挪个地方。用 manifest 的静态闭包复算才看清：`agent-window-effects` 子树里真正通向 session store 的是 `pi-cloud-model-service → agent-catalog-service`，不是 `useAgentEvents`。所以"延后事件订阅"本身只有几百字节，真正的大头是**模型目录**。
>
> 顺带纠正上一版的两条判断：
>
> - `onlyExplicitManualChunks` 不是拦路虎，本次全部收益都没动它；
> - 给 `features/agent/**` 加显式 `manualChunks` 依然有害（实测启动图涨到 5 MB），保持不加。
>
> **遗留的耦合（不影响体积，属可维护性）**：`shell-api` 里仍有 `useBrowserColumnAgentHeaderModel` 直接读 session store，`shell/components/status-bar` 仍直连 `agent-runtime-store`，`notebook-file-tree` 仍在引 `shell-api`。这些文件已经在懒加载块里，不再计入启动图，可以随 2.3（抽 domain 层）一起收。

#### (b) 方向的量化评估（2026-10-25，实测）

按 `check-web-bundle` 同口径重算启动图，把 `app/agent-window-effects.tsx` 从启动根拿掉：

| 口径 | raw | gzip | chunk 数 |
| --- | --- | --- | --- |
| 不含 agent-effects（3 个根） | 1,483 KB | 456 KB | 16 |
| 现状（4 个根） | 1,500 KB | 463 KB | 21 |
| **差量** | **+17 KB** | **+7.4 KB** | +5 |

只省 7.4 KB（约 1.5%），原因是 agent 代码早就被上提到 entry 块，而 entry 是启动图里最大的那一块——从某个根上删掉它，entry 里的副本不会跟着消失。

更关键的发现：**shell 自己也静态依赖 agent，B 单独做永远不可能把 agent 挪出启动图**。

- `features/agent/public/shell-api.ts` 除了 re-export 会话组件（Titlebar / List / StatusBar），还 `import { useAgentSessionStore }`——光这一行就把整套 session store + slices 拉进 shell 的静态图。
- `features/shell/components/status-bar/status-bar.tsx:17` 直接 `import { useAgentRuntimeStore }`（顺带违反 public 入口规则，属于 431 条基线之一）。
- 从四个启动根做静态可达分析：**355 个文件，其中 agent 92 个 / 16,554 行**。

#### 桩替换试验：把 5 处桥全部切断后的真实上限

做法：临时把 shell / app / workspace / preferences 里对 agent 的静态 import 指向一个桩文件（组件返回 null、hook 返回空值），`npx vite build` 后量入口；试验完已完整回退（`tsc` / `build` / `smoke` / `check:arch` 均回到试验前的数字）。

| 场景 | entry raw | 启动 gzip | 相对现状 |
| --- | --- | --- | --- |
| 现状 | 1,412 KB | 474,478 | — |
| 只把 `agent-window-effects` 移出启动根 | 1,412 KB | 463,000（估算） | −7.4 KB |
| 切断 shell / workspace / preferences 的桥，**保留** `agent-window-effects` | — | 473,743 | **−0.7 KB** |
| 连 `agent-window-effects` 一起延后（agent 完全离开启动图） | **916 KB** | **317,940** | **−156 KB（−33%）** |

结论非常干净：**全部收益都锁在"是否延后 `useAgentEvents`"这一个决定上。** 因为它的重量不在自己身上，而在 `agent-session-store`（session store + slices + reducer）。只要它还早挂载，切掉再多渲染桥都只省 0.7 KB。

实测到的 5 处静态桥（按解耦成本从低到高）：

| # | 桥 | 具体位置 | 性质 |
| --- | --- | --- | --- |
| 1 | shell → agent 组件 | `main-layout`（AgentConversationTitlebar）、`browser-column`（create/discard conversation）、`browser-column-header`（Identity/MoreMenu/header model）、`browser-content-icon`（AgentIcon）、`workspace-column-context-menu`（AgentIcon + 建会话）、`global-search-command`（global-search-api）、`status-bar`（StatusBar + AgentIcon + `useAgentRuntimeStore` 直连） | 渲染依赖，可 lazy + 占位 |
| 2 | preferences → agent 图标 | `preferences-tab-config.tsx` 的 `AgentIcon` | 渲染依赖，可 lazy |
| 3 | workspace → agent 数据 | `file-browser-context.ts`（`getWorkspaceAgentResourceFolders`）、`agent-conversation-navigation.ts`（`hydrate/hasWorkspaceAgentConversation`） | 数据依赖，需要命令化或按需加载 |
| 4 | app → agent 订阅 | `agent-window-effects.tsx`（`useAgentEvents` → session store） | **正确性依赖，收益全在这里** |
| 5 | document → agent | `agent-location-navigation.ts` 的 `SourceLocation` | 仅 `import type`，编译期擦除，不是真桥 |

要做的话，工作量与风险：

- 约 **10 个渲染点**改 lazy + 占位（标题栏、状态栏、右栏 header、右键菜单、全局搜索、偏好 tab 图标），回归面覆盖主窗口全部 chrome → 必须有截图对比 + 现有 `check:agent-style-boundaries` 兜底。
- **3 个数据 API** 改成按需：agent resource folders（文件树刷新时会调）、hydrate conversation（工作区恢复时会调）、persistence 事件（已完成）。
- **接受事件订阅延后**：启动窗口内的流式增量靠 `reconcileRunningRuns` + history refresh 补；窗口 ≈ 一个 chunk 的加载时间（本地 `asset://` 通常几十毫秒）。多窗口 / 浏览器栏的投影同步同理。
- 上限 156 KB gzip，约为当前启动图的 1/3。

**因此决策是二选一，而不是"做个折中"**：要么为这 156 KB 接受"首帧后约百毫秒内的 Agent 流式增量靠重拉历史补齐"，要么明确放弃这条，转做 (c) 收紧预算 + 2.3 domain 层（后者的价值在可维护性，不在体积）。

所以 (b) 的行为影响远大于收益：

| 影响面 | 具体后果 | 缓解手段 |
| --- | --- | --- |
| 流式事件订阅 | `useAgentEvents` 晚挂载 → 启动窗口内的增量 chunk 收不到 | 有 reconcile 兜底（`reconcileRunningRuns` + history refresh），但表现为短暂内容缺失/重拉历史 |
| memo 事件桥 | `acquireMemoEventBridge()` 晚挂载 → agent 在窗口内创建/重命名的笔记事件漏掉 | 只能靠下一次事件或手动刷新 |
| Cloud / Pi 模型目录 | 登录态、会员态、模型选择器首次打开可能为空或旧值 | 挂载后补一次 `refreshSnapshot` |
| DSH/CLI 可用性 | 状态栏先显示未知再跳变 | stage3 已在做，影响小 |
| 打包 WebView 失败模式 | 延后 chunk 拉取失败 → Agent 面板不可用（不是白屏），effect 里的动态 import 失败会变成 unhandled rejection | 需要显式 catch + 重试入口，`SurfaceBoundary` 只接渲染错误 |
| 多窗口 / 浏览器栏 | 注释明确"content Webviews own their live Agent projection，browser column 复用这套基础设施"，主窗口延后会让这段时间的投影不同步 | 无 |

**结论：不建议单独做 (b)。** 如果目标是体积，顺序必须是先解决 `shell → agent` 的静态依赖（把 Titlebar/List/StatusBar 改成 lazy + 占位、把 status-bar 的 store import 换成 `public/shell-api` 的选择器），让 agent 真的可分离，再谈延后；那时收益上限约 150–170 KB gzip（拆出来过 `feature-agent` chunk = 639 KB raw / 171 KB gzip）。如果目标是启动时的"可交互到可发消息"延迟，(b) 也不是正确的刀——`useAgentEvents` 和 memo bridge 属于正确性依赖，应该保持早挂载，只把 catalog/cloud 这类"可以晚一点"的重活继续留在 stage3。

原始分析（静态边清单仍然有效，只是别指望它换体积）：

实测入口静态可达图：**166 个文件 / 约 2.2 万行**，其中 document 20、memo 17、agent 13、preferences 10 个文件。以下是全部 16 条 `app → features` 静态边及处理方式：

| 位置 | 静态 import | 改法 | 状态 |
| --- | --- | --- | --- |
| `app/app.tsx:9` | `useAppAgentRuntimeViewModel`（→ `agent-runtime-store`） | 改为公开入口里的 `refreshAgentRuntime()`，内部动态 import store | ✅ 已改 |
| `app/app.tsx:24` | `useAgentPersistenceError`（→ `agent-data-store` 963 行） | **改用已有的 window 事件**（见下） | ✅ 已改 |
| `app/app.tsx:22-23` | `NotebookSetupCoordinator` / `NotebookSetupNoticeHost` | 同 `DocumentSaveNotifications` 的写法，`lazy()` + `Suspense` | ✅ 已改 |
| `app/app.tsx:19` | `invalidateDshModelConfigs`（re-export 自 `dsh-model-config-store` → 又拉进 `agent-data-store`） | 公开入口改成函数，内部动态 import | ✅ 已改 |
| `app/app.tsx:15` | `import "@features/shortcuts/actions"`（副作用） | 移到首帧后：`runStartupStage3Task('shortcut-actions', () => import(...))` | ⏳ 未做（收益小、影响快捷键就绪时机） |
| `app/desktop-shutdown.ts` | 3 个 `public/shutdown-api` | 在 shutdown handler 内部 `await import()` | ⏳ 未做（关闭路径，收益小） |
| `app/use-agent-workspace-window-lifecycle.ts:2-3` | 直接 import agent store（本身也违反边界规则） | 走公开入口，并在生命周期内动态导入 | ✅ 已改 |
| `app/user-config-sync.ts` | `property-preset-store` | 移入回调内动态导入 | ⏳ 未做（小） |

**agent 持久化错误那条已经有现成通道**——store 里本来就在派发 `flowix-agent-data-persistence-status` 事件，只是没人监听（`agent-data-store.ts:23,28-32`）。已把它提升为公开契约 `features/agent/public/persistence-status.ts`（不 import 任何 store），store 侧改为引用同一个常量，避免字符串漂移。

`app.tsx` 侧已按此改造（`useState` + 事件订阅），store 侧改为引用同一常量。

**仍未做的一项（有意跳过）**：`features/preferences/public/app-api.ts` 里的 `PREFERENCE_TAB_GROUPS` re-export。理论上它把整套 tab 配置（含图标表）带进入口，但唯一的跨模块消费者是 `features/memo/components/notebook-icon-menu.tsx`，而它本身就在启动图里——拆出去不会减体积，只多一个文件。等 2.3 抽 domain 层时一并处理。

**vendor 分组与预算 ratchet 未采纳**，原因见本节开头的实测修正：在 `onlyExplicitManualChunks` 打开的前提下，加显式分块会让启动图从 1.5 MB 涨到 5.0 MB。预算 ratchet 仍建议做（把 900 KB 收紧到当前实测 +5%），但应在确定 chunk 策略之后再定数字，否则会把一次失败的实验固化成基线。

---

### 2.2 拆 `TableDocumentViewSession`（3,378 行 / 39 个 useState）

**现状切分**（实测）：`table-document-view.tsx` 270–3378 行是同一个函数组件；其中 270–2593 为状态与副作用（39 个 `useState`、96 个 `useMemo`/`useCallback`、8 个 `useEffect`），2594–3378 为 JSX。文件顶部 148–258 已经是纯函数，可以先行搬走。

**目标结构**：

```
features/multidimensional-table/
├── table-document-view.tsx          # 只剩 30 行：<TableView key={sessionKey} {...} />
├── session/
│   ├── use-table-document-session.ts   # 状态 + 副作用 + 持久化适配（原 270-2593）
│   ├── use-table-record-actions.ts     # 增删改、拖拽落位（原 1104-1900 区段）
│   └── table-view-model.ts            # 派生模型：字段、可见记录、预设、筛选（原 272-500）
├── views/
│   ├── table-grid-view.tsx            # 原 2594-3378 的 JSX
│   └── table-field-header.tsx
└── table-document-view-helpers.ts      # 原 148-258 纯函数
```

**关键约束**：`views/table-grid-view.tsx` 接收**一个 view-model 对象**，不要展开成 30 多个 props（否则只是把耦合搬了家）：

```tsx
export function TableGridView({ model, actions }: {
  model: TableViewModel;
  actions: TableViewActions;
}) { /* ... */ }
```

**三步走**（每步可独立合入、可单独回归）：

1. 搬 148–258 纯函数 → `table-document-view-helpers.ts`（零行为变更，30 分钟）。
2. 把 JSX 抽成 `views/table-grid-view.tsx`，props 用 `model`/`actions` 两个对象打包（这一步能立刻把文件降到 ~2,400 行）。
3. 把 `useState` 聚成 3 个 hook（session / record-actions / view-model），每抽一个跑一次表格测试（现有 `multidimensional-table` 有 35 个测试文件可用）。

**验收**：单文件 ≤600 行；`useState` 数量 ≤8；表格相关测试全绿。

---

### 2.3 抽 domain 层，从根上打断双向依赖

真正的问题不是"谁 import 了谁"，而是**共享模型住在某个 feature 里**。补一层 `domain/`：

```
app/flowix-web/domain/
├── note/       # NoteListItem、note 路径规范化、note key、标签投影
├── document/   # DocumentIdentity、DocumentBuffer 只读契约、保存状态枚举
└── surface/    # SurfaceId、SurfaceContract、host id
```

**放什么 / 不放什么**：只放"纯数据 + 纯函数"（无 React、无 zustand、无 Tauri）。`domain` 的依赖只能是 `domain` 自己。`lib` 可以依赖 `domain`（路径工具需要 Note 路径规则），`features` 依赖 `domain`，`agent` 与 `memo` 之间不再直接互引。

**迁移顺序**（按"引用次数 × 改动风险"排序，每批 ≤20 个文件）：

| 批次 | 接缝 | 现状引用 | 具体动作 |
| --- | --- | --- | --- |
| 1 | `surface → workspace` | 26 | `surface-contract` 下沉到 `domain/surface`；workspace 的 store 通过 public API 提供选择器 |
| 2 | `multidimensional-table → document` | 28 | 表格只需要 `DocumentIdentity` + 保存命令 → 用 `document/public/table-api` 收口 |
| 3 | `multidimensional-table → collection` | 19 | 取集合记录读写 → `collection/public/record-api` |
| 4 | `agent → memo` | 16 | `note-store` 读取改为 `memo/public/note-snapshot-api`（只读快照，不给 store 本体） |
| 5 | `preferences ↔ agent` | 11 / 9 | 模型配置归 preferences，运行时状态归 agent，交叉部分走 `runtime-api` |

每批完成的标准：`architecture-baseline.json` 对应条目被删除、基线总量下降、`check:arch` 通过。

**不要做**：一次性把 36 对双向依赖全改完。选 5 批做完就是阶段性胜利（能砍掉 ~110 条引用），剩下的交给持续 ratchet。

---

### 2.4 CSS 按 surface 拆包

**现状**：入口 CSS 489 KB（gzip 69 KB），17,258 行全部首屏。Agent 相关就占 5,100 行（`agent-thread-card/markdown.css` 2,106 + `agent-conversation/composer.css` 1,943 + 其余）。

**做法**：把 3 块从 `styles/index.css` 的 `@import` 列表移除，改到组件旁导入：

```tsx
// features/agent/thread-card/agent-thread-card-view.tsx
import '@styles/agent-thread-card/markdown.css';
import '@styles/agent-thread-card/messages.css';
```

目标三块：`agent-thread-card/*`（5.1k 行）、`multidimensional-table.css`（890 行）、`pdf-print.css`（598 行）。

**风险与验证**：CSS 拆分改的是级联顺序，最容易出"某个 hover 态失效"这种隐性回归。你们已有 `npm run check:agent-style-boundaries`（含 Chromium 三面对比 + 逐文件 selector 校验），把它作为这次改动的守门员，再补一张"改动前后 Agent 卡片截图 diff"。

**验收**：入口 CSS gzip ≤55 KB；`check:agent-style-boundaries` 通过；截图无差异。

---

## 3. P2 清单（半天级，可并行插入）

**3.1 删 5 个未引用依赖**

```bash
npm uninstall date-fns react-markdown remark-gfm @tiptap/extension-color @tiptap/extension-text-style
```

（已逐个确认：源码零引用；`prosemirror-gapcursor` 可一并删，实际用的是 `@tiptap/pm/gapcursor`。）

**3.2 图标库统一**：保留 `lucide-react`（104 个文件）作为唯一来源，把 `@phosphor-icons/react` 的 12 个文件逐步替换（`scripts/extract-phosphor-bold-paths.mjs` 说明这些图标需要粗描边变体，先确认 lucide 有等价物）。**先立规则**：新增代码只用 lucide，用 ESLint `no-restricted-imports` 禁止新增 phosphor 引用。

**3.3 路径规范化收口**：`lib/path.ts` 补三个函数，然后替换 113 处手写：

```ts
export const toPosix = (path: string): string => path.replaceAll('\\', '/');
export const stripBoundarySlashes = (path: string): string => path.replace(/^\/+|\/+$/g, '');
/** 跨平台相对路径：转 POSIX 分隔符 + 去掉首尾斜杠，用于 notebook 内路径比较。 */
export const canonicalRelativePath = (path: string): string => stripBoundarySlashes(toPosix(path.trim()));
```

替换顺序：`features/collection/*`（7 处）→ `features/surface/*`（2 处）→ `app/*`（2 处）→ 其余。这是 Windows 数据边界 bug 的高发点，值得单独一次性做完。

**3.4 IPC 类型生成**：引入 `tauri-specta`，把 338 个 command 的形状导出成 `bindings.ts`，`invoke` 全部走生成类型。若短期不引入，至少给 `write_*` / `delete_*` / `rename_*` 三类命令加运行时参数校验（Zod 或手写 guard）——这三类出错等于丢数据。

**3.5 HTML 出口收口**：`lib/trusted-html.ts` 提供唯一的 `renderTrustedHtml(html: string): DocumentFragment`（内部 sanitize），并用 ESLint `no-restricted-syntax` 禁止直接 `innerHTML =`。当前 Agent 管线的守卫是对的，但它是"每个渲染点自己记得守"。

**3.6 文档纠偏**：`CLAUDE.md` 的架构图（`components/editor`、`lib/store/memo-store.ts`、`windows/main/...`）已全部失效，改成一句指针："前端结构见 `docs/FRONTEND-MODULE-BOUNDARIES.md`"。

---

## 4. 度量看板（每项整改前后各跑一次）

| 指标 | 当前 | 目标 | 复算方式 |
| --- | --- | --- | --- |
| 架构违规条目总数 | 456（跨模块私有 431 + 组合根 25） | <180 | `npm run check:arch` 输出 |
| 双向依赖模块对 | 36（feature 之间） | <18 | 同上 |
| entry chunk gzip | 432 KB | ≤340 KB | `npm run check:web-bundle` |
| 启动预算余量 | 48% | ≤10% | 同上 |
| 入口 CSS gzip | 69 KB | ≤55 KB | `ls -l .build/web-dist/assets/*.css` |
| 单文件最大行数 | 3,378 | ≤800 | `find app/flowix-web -name '*.ts*' ! -name '*.test.*' \| xargs wc -l \| sort -rn \| head` |
| 裸 `void`（app/store 层） | 439 | 0 | `grep -rn "^\s*void " app features/*/store` |

建议把前 5 个做成 CI 的一段汇总输出，让每次 PR 都能看到"离目标还差多少"，而不是只有一个 ✓。

---

## 5. 顺序与依赖

```
第 1 周  1.1 ESLint + pre-commit   ─┬─> 1.2 边界脚本（复用同一套规则表）
         1.3 SurfaceBoundary        ─┘
第 2 周  1.4 fire-and-forget 收口
         1.5 三条冒烟  ← 这是 2.1 的硬前提
第 3 周  2.1 入口瘦身（每条改完跑冒烟 + 下调预算）
第 4 周  2.2 表格拆分（三步走）      2.4 CSS 拆包（并行）
第 5-8 周 2.3 domain 层，每批一个 PR；P2 项穿插
```

**为什么不先做 2.1**：启动路径是这个应用最敏感的部分（native 阶段、首帧、window show 时序都在里面），没有冒烟测试就动它，等于拿"用户开不了应用"换几百 KB。

---

## 6. 明确不做的事

| 不做 | 原因 |
| --- | --- |
| 把 Agent thread-card 重写成 React | 命令式那套是为流式渲染性能做的，重写成本和回归风险远大于收益；只需补 `dispose()` 契约与边界 |
| 合并多套 Markdown 管线 | Worker 隔离 React/Tauri 依赖、Agent 要防任意 HTML，差异是必要的；只统一 tokenizer 真源 |
| 全量目录重组（按 DDD 重排） | 移动 1,400 个文件会产生无法审查的 diff；domain 层只搬"共享模型"，增量收敛 |
| 用 `--update-baseline` 让门禁变绿 | 一旦允许，基线就再也不会下降 |

---

## 7. 遗留（本次未做，按顺序接手）

1. ~~2.1 的性能部分需要决策~~ —— 已落地：启动图 322,791 gzip，`agent-session-store` chunk 离开启动图，预算 ratchet 到 340 KB。后续任何新增的静态边都要先问一句「它会不会把大 store 拖回启动图」，`check:web-bundle` 会拦住。
2. **冒烟只覆盖到启动屏，还没到工作台**。`boot` 探针现在守的是"不白屏"（入口加载、React 挂载、spinner 移除、出现可识别界面、无未捕获异常）。推进到 `[data-workspace-host]` 需要更完整的 IPC 桩；探针已踩平 `import.meta.glob`（Vite 专属 API，esbuild 会用注入的桩替代）。
3. **剩下的 98 处 `console.*`**（视图层）仍在抑制表里，门禁上限 106 只是刚好够用。建议按 ratchet 每次顺手减。
4. **`check:layer-boundaries.mjs` 与新脚本并行跑**：等新脚本覆盖旧规则一个版本周期后删掉旧的，避免双轨。
5. **`eslint-suppressions.json` 与 `architecture-baseline.json` 必须提交进仓库**（否则 CI 上没有基线）。
6. **`npm test` 仍有 25 文件 / 56 用例失败**，与本次改动无关（已用 `git stash` 回退验证）：集中在表格 kanban、媒体库、onboarding、editor tag、agent thread-card，属工作区里未提交的 WIP。
