# 78 → 85 架构攻坚设计（T2 / T4-0 / CSS 预算）

> 承接 2026-10-27 复评（78 / 100，A-）。本设计覆盖通向 85 分的三场硬仗：
> **T4-0 千行文件冻结闸门**、**CSS 预算**、**T2 domain 层下沉**。
> 所有现状数字均为写作时实测（`app/flowix-web`）。

---

## 0. 目标与评分映射

| 战役 | 主要拉动维度 | 预期分值变化 |
|---|---|---|
| T4-0 千行文件冻结闸门 | 可维护性 | 16 → 18（+2，先"止涨"再"清偿"） |
| CSS 预算 | 性能与产物体积 + 架构简洁度 | 7 → 8（+1） |
| T2 domain 层下沉 | 分层与模块边界 + 架构简洁度 | 14 → 15、10 → 10（结构性变化的第一步，分值兑现滞后） |
| **合计** | | **78 → 85** |

设计原则：**先立闸门，再做搬迁**。没有闸门的拆分一定会反弹（skill market 已经证明：新 surface 类型一来，简洁度就倒退）。

---

## 1. 战役一：T4-0 千行文件冻结闸门（约 1 人日）

### 1.1 现状实测

≥1000 行的源文件共 **22 个**（16 个业务/源码 + 6 个测试文件）。16 个非测试千行文件：

| # | 文件 | 行数 | 类型 | 处置 |
|---|---|---|---|---|
| 1 | `features/multidimensional-table/table-document-view.tsx` | 3352 | 视图 | 拆（P0） |
| 2 | `features/agent/thread-card/settings/external-agent-settings-controller.ts` | 2457 | 控制器 | 拆（P0） |
| 3 | `lib/i18n/messages.en-US.ts` | 2374 | 资源 | **豁免**（数据文件） |
| 4 | `lib/i18n/messages.zh-CN.ts` | 2346 | 资源 | **豁免**（数据文件） |
| 5 | `features/preferences/sections/agent.tsx` | 2085 | 视图 | 拆（P1） |
| 6 | `features/agent/thread-card/agent-thread-card-view.tsx` | 2076 | 视图 | 拆（P1） |
| 7 | `features/memo/components/notebook-file-tree.tsx` | 1671 | 视图 | 拆（P1） |
| 8 | `features/memo/components/memo-list.tsx` | 1450 | 视图 | 拆（P2） |
| 9 | `features/workspace/use-cases/workspace-navigation.ts` | 1358 | 逻辑 | 拆（P1） |
| 10 | `features/agent/thread-card/settings/notebook-agent-settings-dialog.tsx` | 1261 | 视图 | 拆（P2） |
| 11 | `features/editor/extensions/codeblock-shiki/codeblock-shiki-view.ts` | 1200 | 视图扩展 | 拆（P2） |
| 12 | `features/editor/extensions/frontmatter-property-editor.ts` | 1090 | 逻辑 | 拆（P2） |
| 13 | `features/shell/main-layout.tsx` | 1088 | 视图 | 拆（P0，启动路径） |
| 14 | `features/editor/extensions/frontmatter-node-view.ts` | 1084 | 视图扩展 | 拆（P2） |
| 15 | `features/agent/store/thread-history.ts` | 1039 | 纯逻辑 | **随 T2 下沉**（不拆，搬家） |
| 16 | `features/editor/markdown-editor.tsx` | 1027 | 视图 | 拆（P2） |

6 个千行测试文件：冻结即可，不主动拆（测试文件的拆分收益低）。

### 1.2 闸门设计（双层）

**第一层：冻结（立即生效，防恶化）**

在 `scripts/check-frontend-debt.mjs` 中新增 LOC ratchet，与现有的 `MAX_EXPLICIT_ANY` / `MAX_DIRECT_CONSOLE_CALLS` 同一套机制：

```js
// 千行文件"禁止增长"闸门。只能往下 ratchet，禁止上调让 CI 变绿。
const FROZEN_FILES = {
  'features/multidimensional-table/table-document-view.tsx': 3352,
  'features/agent/thread-card/settings/external-agent-settings-controller.ts': 2457,
  // ... 上面 22 个文件逐条列出（含测试文件）
};
const MAX_NEW_FILE_LINES = 1000; // 新文件直接进千行俱乐部 = error
```

判定规则：
- 名单内文件行数 **>** 记录值 → error（增一行都不行，倒逼拆分而非续写）；
- 名单内文件行数 **<** 记录值 → 通过，并把新值写回名单（ratchet 自动下探，可选：打印提示让人工确认写入）；
- 名单外新文件 ≥ 1000 行 → error；
- `lib/i18n/messages.*` 两条数据文件单独标记 `exempt: true`，同样冻结但不计入"应拆"债务。

**第二层：清偿（拆分看板）**

在 `architecture-baseline.json` 同级新增 `loc-debt.json` 记录每个文件的 P0/P1/P2 与目标行数（目标统一 ≤ 600 行）。`npm run verify` 输出当前债务余量，作为评分复测的数据源。

### 1.3 拆分顺序与手法

拆分顺序按"P0 → P2 + 启动路径优先"：

1. **P0（拆完才有资格谈启动体积）**：`main-layout.tsx`（1088，启动闭包内）、`table-document-view.tsx`（3352，最大单文件）、`external-agent-settings-controller.ts`（2457）。
2. **P1**：`workspace-navigation.ts`、`agent-thread-card-view.tsx`、`preferences/sections/agent.tsx`、`notebook-file-tree.tsx`。
3. **P2**：editor 扩展三个 + 其余。

拆分手法约定（写进 CONVENTIONS，避免拆出"平行目录"）：
- 同目录就近拆，不新建 `xx-splitted/` 之类目录；子文件名用职责命名（如 `table-document-view` 拆为 `table-grid-view` / `table-toolbar` / `table-context-menu`）。
- 视图文件拆分优先抽 **非渲染逻辑**（hooks / selectors / 常量），保持子组件树不动，降低回归面。
- 每拆一个文件跑 `npm run verify`；测试文件不动（现有 3043 用例是拆分的安全网）。

### 1.4 验收标准

- [ ] `npm run verify` 包含 LOC 闸门，故意给任一冻结文件加一行能红。
- [ ] P0 三个文件降到 600 行以下，冻结名单 ratchet 后 ≤ 13 个非测试千行文件。
- [ ] 可维护性维度复测 +2 的依据成立（闸门上线 + P0 清偿）。

---

## 2. 战役二：CSS 预算（约 3 人日）

### 2.1 现状实测

- `app/flowix-web/styles/` 共 **17,423 行 CSS**，无任何体积预算。`check-web-bundle.mjs` 只管 JS 启动图。
- 最大的三块：`agent-thread-card/markdown.css` 2366 行、`agent-conversation/composer.css` 1992 行、`editor.css` 1904 行。
- Token 化程度尚可（`editor.css` 内 `var(--…)` 210 处 vs 裸 hex 仅 4 处），所以预算先管"总量与增量"，不急着管"裸值"。
- 两套图标、两条 i18n、两套渲染范式的 CSS 侧症状：`agent-icon.css` 与 `cloud-status-icon.css` 并存、agent 树与 editor 树各自维护 markdown 排版。

### 2.2 预算设计（三级）

**一级：产物总量 ratchet（硬门禁）**

在 `scripts/check-web-bundle.mjs` 里扩展 CSS 口径——从 `.build/web-dist/.vite/manifest.json` 复算全部 CSS chunk 的 gzip 总量（与 JS 启动图同一套方法，避免源码级统计的坑，这是之前确认过的教训）。预算算法与 JS 相同：`预算 = 当前实测 × 1.02` 起步，只降不升。

首日先实测一次基线（构建 → manifest → gzip 汇总），写入脚本。

**二级：增量来源定位（辅助，不进 CI）**

`--report` 模式输出 CSS chunk Top 20 及其 gzip 占比，标注"本次构建新增/增长最多的 CSS 文件"。定位谁在涨，不拦谁。

**三级：重复与裸值 lint（低成本先做）**

- stylelint `declaration-block-no-duplicate-properties` + 自定义规则：`styles/` 下新增裸 hex 超过现有基线 → warning（暂不 error，等 token 化补齐再收紧）。
- `check-agent-style-boundaries.mjs` 已有的 Chromium 三面对比保留，作为 agent 树的回归网。

### 2.3 合并两条战线的既定约定（不新增工作量，写进本设计备忘）

- 两套 markdown 排版（editor 树 vs `agent-thread-card/markdown.css`）：**不合并**，维持 memory 里已定的 Agent 样式边界约定（agent 样式唯一入口 + `agent-` 前缀命名空间）。CSS 预算管总量，不强行 DRY。
- 图标与 i18n 的合并属于 T2/简洁度后续项，本战役只记录、不实施。

### 2.4 验收标准

- [ ] `npm run verify` 包含 CSS 总量 ratchet，往任一 CSS 粘 500 行重复样式能红。
- [ ] 基线数字写入脚本并有注释说明口径（gzip / manifest 复算）。
- [ ] 性能维度 +1 的依据：预算从无到有（原来 CSS 是完全自由变量）。

---

## 3. 战役三：T2 domain 层下沉（约 3–4 周，分期）

### 3.1 现状实测

- `features/agent/store/` 有 **约 80 个文件**，其中相当一部分是**零 React 依赖的纯逻辑**（已抽查：`thread-history.ts`、`session-reducer/reduce-projection.ts` 均不 import react）。这部分就是"agent 占前端 30%"里最值得下沉的部分。
- `agent-session-store` / `agent-data-store` 已被启动图隔离（函数体内 `import()` / `lazy()`），下沉**不会**影响启动体积——反而降低风险，因为 chunk 边界更干净。
- 现有约束：`check-layer-boundaries.mjs` 硬编码了 `agent-session-store ≤650 行`、partialize 不存大对象等 4 条不变量。下沉方案必须与这些不变量兼容。

### 3.2 目标形态

```
app/flowix-web/
  lib/agent-domain/            # 或 features/agent/domain/，见 3.3 决策
    session-reducer/           # reduce-projection、types 等
    thread-history.ts
    message-chunks.ts / tool-chunks.ts / streaming-buffer.ts
    conversation-run-index.ts / conversation-run-signature.ts
    ...（纯逻辑，零 react / 零 tauri / 零组件依赖）
  features/agent/store/        # 留下的都是有 React / tauri 依赖的 store、bridge、slice
```

### 3.3 关键决策：放 `lib/` 还是 `features/agent/domain/`

| 选项 | 优点 | 缺点 |
|---|---|---|
| A. `lib/agent-domain/` | 位置即语义（"低层"），memo/editor 未来下沉可复用同一层 | `lib/` 现在放的是 logger、i18n 等基础设施，混入业务 domain 会让 lib 语义变糊 |
| B. `features/agent/domain/` | 业务归属清晰，跨 feature 引用走 `public/` 门面的既有规则直接适用 | 名义上仍在 features 层，需要额外规则防"反向依赖 store" |

**选 B**。理由：跨 feature 复用是假需求（目前没有第二个 feature 需要这些 reducer），而"业务归属清晰 + 复用现有 public 门面规则"是当下真实收益。若未来 memo/editor 确实出现共享 domain，再讨论上浮，不上浮先行。

配套规则（写入 `architecture.config.json`，而非硬编码进 `check-layer-boundaries.mjs`）：
- `features/*/domain/**` 不得 import：`react`、`react-dom`、`@tauri-apps/*`、同级 `store/**`、同级 `components/**`、其他 feature（除其 `public/`）。
- `features/agent/store/**` 必须经由 `../domain` 引用 reducer（禁止绕行复制）。

### 3.4 分期计划

**Phase 1 — seam 先行（2 天，不动一行业务代码）**
1. 建 `features/agent/domain/` 目录 + 上述两条规则进 config，跑 `npm run verify`（此时 domain 为空，规则只对新文件生效，避免全量迁移一次性爆炸）。
2. 用 `dependency-cruiser` 或复用 `check-architecture.mjs` 的遍历逻辑输出"可下沉候选清单"：`features/agent/store/**` 中不 import react/tauri 的文件，逐个标注依赖方向。**这份清单是唯一的事实来源，人工不再拍脑袋。**

**Phase 2 — 搬迁第一批（1 周）**
- 从清单选叶子节点（被依赖最少的）先搬：`session-reducer/reduce-projection.ts`（635 行）、`thread-history.ts`（1039 行，一并解决千行冻结名单第 15 项——搬家不算增长，闸门里对应条目同步迁移路径并清零）、`message-chunks.ts`、`tool-chunks.ts`、`streaming-buffer.ts`。
- 搬迁 = 纯 `git mv` + 修 import + 测试文件跟随移动。**禁止顺手重构**。
- 每搬一批（5 个文件一批）跑 `npm run verify`，绿了再继续。

**Phase 3 — 搬迁主体 + 门禁收紧（1.5 周）**
- 清单上剩余文件按依赖序分批搬完（预计 30–40 个文件）。
- 把 Phase 1 的"只对新文件生效"收紧为"对全部文件生效"。
- `check-layer-boundaries.mjs` 的 4 条 agent 不变量**原样保留**，路径同步更新。

**Phase 4 — 收尾与复测（2 天）**
- `features/agent/` 占前端代码比例从 ~30% 实测复核一次（这是分层维度复测的数据）。
- 评分复测：domain 规则全绿 + store 层文件数下降 = 分层维度 14 → 15 的依据。

### 3.5 风险与对策

| 风险 | 对策 |
|---|---|
| 循环依赖在搬迁中暴露 | Phase 1 清单阶段就跑依赖图分析，环先拆再搬；有环的文件不进当批 |
| 搬迁期间与 WIP（skill 市场）冲突 | 先等 8000 行 WIP 的两周复盘结论，Phase 2 择机启动；期间只完成 Phase 1 |
| "搬家变重构"导致行为变化 | 硬约束：纯 `git mv`，diff 里不允许出现 `git mv` 之外的逻辑行 |
| 深层 import 路径大量修改 | 用 tsconfig path alias（`@agent-domain/*`）收敛写法，review 面最小化 |

### 3.6 验收标准

- [ ] `features/agent/domain/` 存在，规则对全部文件生效且 `npm run verify` 全绿。
- [ ] 可下沉清单上 ≥ 80% 的文件完成搬迁，store 层只剩 react/tauri 绑定代码。
- [ ] 分层维度复测有据：agent 占比、domain 规则拦截记录。

---

## 4. 排期总览

```
第 1 周        T4-0 闸门上线（1 天）→ P0 拆分启动 + CSS 基线实测与预算上线（3 天）
第 2–3 周      P0/P1 拆分持续 + T2 Phase 1（seam + 清单）
               ⚠ T2 Phase 2 启动前：等待 WIP 两周复盘结论
第 3–6 周      T2 Phase 2/3（搬迁主体）+ P2 拆分穿插
第 6 周末      T2 Phase 4 收尾 + 全量复测（预期 85）
```

总量与原方案约 140 人日的口径对齐：闸门 1 天 + CSS 3 天 + 拆分约 30 人日 + T2 约 25 人日 ≈ 60 人日为"到 85 分"的最短路径；其余 80 人日属于 85 → 90（两套渲染范式合并、i18n 合并、图标合并），不在本设计范围内。

## 5. 与既有约定的一致性检查

- ✅ 不在 Markdown/编辑器扩展里加块锚点（与本设计无交集）。
- ✅ Agent 样式仍唯一入口 `styles/agent-conversation.css`，CSS 预算不改变 token 分层。
- ✅ `check-architecture.mjs` / `check-layer-boundaries.mjs` 都不删；新规则进 config，旧脚本只加不改。
- ✅ 启动图预算 340 KB 口径不动；`agent-session-store` / `agent-data-store` 继续禁止出现在静态闭包——domain 下沉后需在 `check-web-bundle.mjs` 复核一次闭包无回归。

---

## 6. 实施进度（2026-10-27 晚）

| 项 | 状态 | 结果 |
|---|---|---|
| T4-0 冻结闸门 | ✅ 已上线 | `check-frontend-debt.mjs` 新增 `FROZEN_FILES`（22 个文件）+ `MAX_NEW_FILE_LINES=1000`；+1 行即红已实测验证 |
| CSS 预算 | ✅ 已上线 | `check-web-bundle.mjs` 实测基线 559,001 raw / 83,321 gzip，预算 570,000 / 85,000（×1.02）；红线已实测验证；`--css-report` 辅助定位 |
| P0：main-layout.tsx | ✅ 已完成 | 1088 → 594 行，冻结名单已 ratchet。拆出 5 个 hook（use-default-create-folder / use-external-file-deletion / use-media-actions / use-work-column-presentation / use-document-titlebar-props / use-product-intro）+ 5 个组件（main-list-column-section / main-work-columns / main-layout-export-notice / main-layout-startup-failure-overlay / memo-list-preview-edge-trigger），全部位于 `features/shell/` 既有 hooks/、components/ 目录 |
| P0：table-document-view.tsx（3352） | 🔶 进行中 | 3352 → 2024 行（-40%），冻结名单已 ratchet 到 2024。纯函数/常量抽至 `table-view-helpers.ts` + `incompatible-view-empty-state.tsx`；逻辑段拆成 5 个领域 hook（use-table-note-linking / use-table-note-drop / use-table-field-edits / use-table-calendar-notes / use-table-kanban），回调体逐字搬移。35 文件 / 168 用例全绿。**剩余：JSX 区块组件化**（视图 tabs 导航 / datasetAction / 表格主体 / 底部弹层，约 1400 行），完成后可到 600 行以下 |
| P0：external-agent-settings-controller.ts（2457） | ⬜ 未开始 | P0 之后 |
| flaky：notebook-file-tree 5s 超时 | ⬜ 未开始 | 全量并发下偶发超时（单跑 918ms），待调整测试自身 |

**存量豁免账本变化**：`eslint-suppressions.json` 中该模块的 `no-restricted-imports` 从 22 涨到 36 —— 搬到 hook 的回调带着原文件的跨 feature import 走，且 view 与 hook 共用 `reviseCollection` 等同批依赖，拆分让同一批存量分散到多文件计数。这是拆分的已知代价，不是新增违规类型。

