# Flowix 前端优化方案 v2

> 基线：`docs/FRONTEND-ARCH-EVALUATION-2026-10-27.html`（64.5 / 100）
> 前序：`docs/FRONTEND-ARCH-REMEDIATION-PLAN.md`（P0 全部落地、2.1 入口瘦身已完成）
> 本文定位：**接续未落地部分，并补上评审新发现的系统性缺口**。不重复已完成的 1.1–1.5 与 2.1。
> 原则：**先让门禁可信，再动结构；结构性改动一律按 seam 切，不做大爆炸重排。**

---

## 落地状态（2026-10-27，Wave 0 第一批）

| 项 | 状态 | 产物 | 验证 |
| --- | --- | --- | --- |
| T1 门禁转绿 | ✅ | 5 个窄 public 出口 + 2 个消费方改走门面 | `eslint` **7 error → 0**（201 warning）· `check:arch` **通过**（439/443）· 基线 -4、抑制表 -13 |
| T1 测试崩溃 | ✅ | `stable-caret.ts` 加 `unobserve` 存在性判断；`agent-thread-card.test.ts` 4 处桩补齐 | jsdom 未捕获异常消除，405 文件可完整跑完 |
| T1 `npm run verify` | ✅ | `package.json` 新增脚本 | tsc / eslint / arch / frontend-debt / vitest 一条命令 |
| T5 全局兜底 | ✅ | `lib/global-error.ts`、`app/global-error-toaster.tsx`、`desktop.tsx` 安装、`app.tsx` 接 `onError` | 5 个新单测通过；启动图 **324,396 gzip**（+1.6 KB，预算内） |
| T1 剩余 31 个断言失败 | ⏳ | 来自工作区未提交 WIP，源文件改动后测试未同步 | 已用「只跑改动相关测试」确认与本次无关（`features/surface` 20 文件全绿） |

> 下一步：T4-0 巨型文件闸门（1 人日），然后进入 Wave 1 的 T2 批 1。

---

## 0. 北极星：什么叫“优化完成”

一年后，这套代码应当满足六条可验收的定义。它们不是口号，每一条都能用命令复算。

| # | 终态定义 | 复算方式 | 当前 |
| --- | --- | --- | --- |
| 1 | 所有门禁全绿且**可信**：lint / arch / test / bundle / smoke 一次跑通 | `npm run verify` | 3 项红（lint 7 error、arch 3 违规、test 31 失败） |
| 2 | 跨 feature 引用 **≥85% 走 public**，双向依赖 **<10 对** | `node scripts/check-architecture.mjs --json` | 42.7% / 36 对 |
| 3 | 任何未捕获错误都**可见、可定位、可恢复**（有日志、有提示、有重试） | 人为注入异常，看日志与 UI | 全局兜底 0 处 |
| 4 | 新增一种文档 surface **≤2 个文件**；新增一个 feature **≤1 个脚手架命令** | 实操计时 | 11 文件 + 9 处方 switch |
| 5 | 单文件 **>1000 行 = 0**，**>600 行 ≤10**，且豁免名单只减不增 | `scripts/check-file-size.mjs` | 16 个 >1000 行 |
| 6 | 同一件事只有一种做法：一套状态范式、一套错误出口、一套 token 用法 | 见 §4 看板 | 各 2–4 套 |

### 0.1 四条硬约束（违反即视为方案失败）

1. **规则必须机器可验证**。写进文档但检查不到的约定 = 不存在。本项目 57% 的私有引用就是这么长出来的。
2. **门禁红灯优先于任何新功能**。红灯状态下不允许“先合进去，下周修”。
3. **债务单向下降**。基线/抑制表只允许减少；回涨按 bug 处理，不允许 `--update-baseline` 放行。
4. **动高风险路径前先有护栏**。编辑器、保存链、启动链的改动必须先有测试或冒烟，否则只做“加护栏”不做“改逻辑”。

### 0.2 与既有方案的关系

| 既有方案章节 | 状态 | 本方案动作 |
| --- | --- | --- |
| 1.1 ESLint / 1.2 边界门禁 / 1.3 错误边界 / 1.4 异步收口 / 1.5 冒烟 | 已落地 | 保留，只做**可信度修复**（T1） |
| 2.1 入口瘦身 | 已落地（322,791 gzip） | 保留预算，继续 ratchet（T11） |
| 2.2 拆 TableDocumentView | 未落地 | 升级为通用「巨型文件治理」（T4） |
| 2.3 domain 层 | 未落地 | 补全为可执行的 6 批迁移（T2） |
| 2.4 CSS 拆包 | 未落地 | 并入样式系统（T8） |
| P2 清单（依赖/图标/路径/HTML 出口/文档） | 部分未落地 | 拆入 T12 |
| — | 新增缺口 | 全局兜底、测试红灯、错误文案三套、状态四范式、扩展点收敛（T5/T6/T7/T9） |

---

## 1. 终态架构

### 1.1 六层，一条有向边

现在的三层（app → features → lib/shared/platform）方向是对的，但缺一层承载“共享业务模型”，于是 note / document / surface 这些跨 8 个 feature 的概念只能住在某个 feature 里，靠私有 import 被借用。补 `domain/` 后：

```
entrypoints/        启动装配（desktop.tsx / web.tsx）—— 只做 init，不含业务
      ↓
app/                组合根：窗口、生命周期、跨 feature 编排
      ↓
features/*          业务能力：20 个模块，对外只出 public/
      ↓
domain/             共享业务模型：纯数据 + 纯函数，无 React / 无 store / 无 Tauri
      ↓
lib/ shared/        通用能力：工具、UI 原语、i18n、logger
      ↓
platform/           Tauri IPC、文件系统、事件总线（唯一允许 import @tauri-apps 的地方）
```

### 1.2 允许依赖矩阵

`✅` 允许，`→public` 仅允许走目标模块的 `public/`，`❌` 禁止并由脚本拦截。

| 从 \ 到 | entrypoints | app | features | domain | lib/shared | platform |
| --- | --- | --- | --- | --- | --- | --- |
| entrypoints | — | ✅ | ❌ | ❌ | ✅ | ✅ |
| app | ❌ | ✅ | →public | ✅ | ✅ | ✅ |
| features/x | ❌ | ❌ | →public（其他 feature） | ✅ | ✅ | ✅ |
| domain | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| lib/shared | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| platform | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |

两条新增的硬规则，写进 `architecture.config.json`：

- `domainMustNotImportUpward: true` —— domain 只依赖 domain。这条是防“domain 变成第二个垃圾桶”的唯一保险。
- `featuresMustNotImportApp: true` —— 现在还没破，但要提前锁死（feature 反向调组合根是最常见的腐化路径）。

### 1.3 feature 内部标准骨架

20 个 feature 里，有 `model/` 的 3 个、有 `services/` 的 2 个、有 `use-cases/` 的 5 个，`multidimensional-table` 78 个文件全平铺在根目录。终态统一为：

```
features/<name>/
├── public/                 对外契约：按消费方命名（app-api / shell-api / workspace-api）
├── model/                  领域模型与派生逻辑（可测、无 React）
├── services/               IPC 调用、跨进程编排（唯一碰 platform 的地方）
├── store/                  客户端状态（只放 UI 状态与缓存，不放业务规则）
├── use-cases/              跨 store 的业务动作（一个用例一个文件）
├── components/             React 组件（纯渲染 + 交互）
├── hooks/                  组件间复用的副作用
└── index.ts                仅导出类型，不 re-export 实现（避免 barrel 拖体积）
```

不要求一次迁完。规则是：**新建目录即按此骨架；改到某个 feature 时顺手补齐。** 例外：`editor/extensions`、`agent/thread-card` 这类子域允许在自己的目录内复制这套骨架（子域即模块）。

### 1.4 状态与通信的选择树

现在有四种跨模块通信方式并存（直接 `getState()` 1,761 处、event-dispatcher、memo-dispatcher、Tauri event-bus 75 个订阅），且没有选择标准。定为三层 + 一棵树：

```
Q1 这份数据是否来自后端的“服务端状态”？
├── 是 → server cache（T7：统一 IPC 查询层，带 key / staleTime / invalidate）
└── 否 → Q2 是否需要跨窗口/跨 WebView 同步？
        ├── 是 → platform 事件总线（唯一合法用途）
        └── 否 → Q3 是“当前 UI 会话状态”还是“用户偏好/持久设置”？
                ├── 会话态 → feature store（不持久化）
                └── 持久 → 统一 settings store（唯一 persist 实例）
```

三条禁止项：
- 禁止 feature A 直接读 feature B 的 store 实例（必须经 public 选择器或 domain 模型）。
- 禁止在 store 内调 `toast` / 操作 DOM（现存 1 处 `document-title-session.ts:13`，收掉）。
- 禁止新增 `event-dispatcher` 用途；存量逐步并入 server cache 的 invalidate。

### 1.5 扩展点：一个 surface 一个定义

现状：新增一种 surface 要改约 11 个文件 + 9 处 `switch`。终态：

```ts
// features/workspace/surface/define-surface.ts
export interface SurfaceDefinition<P = unknown> {
  kind: SurfaceKind;
  /** 从文件路径解析出 surface 参数；返回 null 表示不认领 */
  resolve(input: ResolveInput): P | null;
  /** 渲染契约：只接收 view-model 与 actions，不接收 host 内部对象 */
  render(props: { model: SurfaceViewModel<P>; actions: SurfaceActions }): ReactNode;
  /** 外壳元数据：标题、图标、面包屑、是否可编辑 */
  chrome: SurfaceChrome<P>;
  /** 该 surface 需要的 CSS（供按需加载） */
  styles?: () => Promise<unknown>;
}
```

注册表退化为一个数组，其余位置全部查表：

```ts
// features/workspace/surface/registry.ts
export const SURFACES = [
  markdownSurface, tableSurface, csvSurface, imageSurface, /* ... */
] satisfies SurfaceDefinition[];
```

验收：新增一种 surface = 新建 1 个 `xxx-surface.tsx` + 在 `registry.ts` 加一行。`satisfies` 保证漏配字段编译期报错。

---

## 2. 十二个专项

优先级标记：`P0` 立即（1–2 周）· `P1` 结构性（3–10 周）· `P2` 收敛（11–24 周）。

### T1 · 门禁止血：让红灯真的红，绿灯真的绿 `P0`

**现状（实测）**

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `check:arch` | ❌ 3 条新增 | `agent-tasks-section.tsx` ×1、`workspace-web-surface-renderer.tsx` ×2 |
| `eslint` | ❌ 7 error / 201 warning | 7 个 error **全部**是 `no-restricted-imports`，集中在同 2 个文件（`agent-tasks-section.tsx` ×2、`workspace-web-surface-renderer.tsx` ×5）。与 arch 的 3 条不重合，说明两套规则的覆盖面还没对齐 |
| `vitest` | ❌ 13 文件 / 31 用例 | 主因 jsdom 缺 `ResizeObserver.unobserve`（`stable-caret.ts:318`） |
| `check:web-bundle` | ✅ 322,791 / 340 KB | 余量仅 5% |
| `smoke` | ✅ 3/3 | 只覆盖到启动屏 |

**动作**

1. **修 7 个 error**（半天）。两个文件的正解不是加抑制，而是补 public：
   - `agent-tasks-section.tsx` → 新增 `preferences/public/user-settings-api.ts`，导出只读选择器 `useUserSettingsSnapshot()`；
   - `workspace-web-surface-renderer.tsx` → 该文件是 surface 协调入口，本身就该依赖 `workspace/public/*`；把 5 条引用换成 `workspace/public/host-api` + `memo/public/note-navigation-api` + `agent/public/runtime-status-api`。
2. **修 31 个测试失败**（半天）。`vitest.setup.ts` 补 polyfill：
   ```ts
   if (!globalThis.ResizeObserver) {
     globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
   }
   ```
   并给 `stable-caret.ts:318` 的 `this.resizeObserver?.unobserve(element)` 加方法存在性判断——这是产品代码在 jsdom 下的真实脆弱点，不该靠测试环境兜。
3. **让门禁输出“离目标还差多少”**，而不只是一个 ✓。`check-architecture.mjs` 增加 `--json`，CI 里渲染成一段 summary：

   ```
   架构债务  443 → 目标 <180   本周 -12   ████████░░░░░░
   私有引用  462 (57.3%)      目标 <15%  ██░░░░░░░░░░░░
   循环依赖   36 → 目标 <10    本周  -2   ██████░░░░░░░░
   ```
4. **加一条 `npm run verify`**：`tsc && eslint && check:arch && check:frontend-debt && vitest run && check:web-bundle`。PR 只认这一个命令。

**验收**：`npm run verify` 全绿；CI 每次 PR 打印债务进度条；连续 4 周无新增红灯。

**风险**：补 public 时容易把内部类型一起暴露，导致下一次改动受制于“已公开的契约”。规则：public 只导出**消费方需要的最小面**，导出即视为兼容性承诺，加 `@public` 注释。

---

### T2 · domain 层：一次解决四个症状 `P1`

**为什么值得单列**：私有引用 462 条、循环依赖 36 对、Note/Document 命名撕裂、通知 4 套——这四个症状共享同一个病因：**共享业务模型没有归宿**。

**放什么 / 不放什么**

| 放 | 不放 |
| --- | --- |
| 实体类型与不变量（`NoteIdentity`、`DocumentIdentity`、`SurfaceId`） | 任何 React / hook |
| 纯函数（路径规范化、标签投影、标题派生、排序比较） | 任何 zustand store |
| 状态机定义（保存状态、会话阶段）与其转换函数 | 任何 `invoke` / Tauri 调用 |
| 跨模块共享的常量与枚举 | UI 文案（归 i18n） |

**目标结构**

```
domain/
├── note/
│   ├── identity.ts        NoteId、notebookId、relativePath、canonical 比较
│   ├── path.ts            toPosix / stripBoundarySlashes / canonicalRelativePath（从 lib/path 上提）
│   ├── model.ts           NoteListItem、Notebook、Tag（从 memo/store/note-store 剥离类型）
│   └── projection.ts      标签树、排序、筛选的纯函数
├── document/
│   ├── identity.ts        DocumentIdentity（fileIdentity + scope + relativePath）
│   ├── buffer.ts          DocumentBuffer 只读契约、revision
│   └── save-state.ts      SaveState 状态机（idle/dirty/saving/conflict/error）与转移函数
├── surface/
│   ├── id.ts              SurfaceId、SurfaceKind
│   └── contract.ts        SurfaceDefinition、SurfaceViewModel（从 workspace/model 下沉）
└── agent/
    ├── message.ts         消息类型与投影（只搬类型，不搬渲染）
    └── session.ts         会话阶段枚举
```

**迁移批次**（按“引用数 × 风险”排序，每批 ≤20 文件，独立 PR）

| 批 | 接缝 | 引用数 | 动作 | 预期降债 |
| --- | --- | --- | --- | --- |
| 1 | `surface → workspace` | 56 | `surface-contract` / `surface-identity` 下沉 `domain/surface`；workspace store 只经 public 暴露选择器 | -35 |
| 2 | `multidimensional-table → document` | 30 | 表格只需 `DocumentIdentity` + 保存命令 → `document/public/table-api` | -25 |
| 3 | `multidimensional-table → collection` | 29 | 集合记录读写 → `collection/public/record-api` | -22 |
| 4 | `agent → memo` / `agent → editor` | 21 / 18 | `NoteListItem` 从 note-store 剥离到 `domain/note`；agent 只读快照 | -30 |
| 5 | `memo → workspace` / `memo → document` | 35 / 16 | 导航意图改为 `domain/surface` 的 SurfaceId，不再传 workspace 内部对象 | -30 |
| 6 | `preferences ↔ agent` | 11 / 11 | 模型配置归 preferences，运行时状态归 agent，交叉走 `runtime-api` | -20 |

**关键设计决策**：`domain` 不做“大而全的领域层”，只搬**已经被 3 个以上模块引用**的东西。搬错的标准是：如果一个类型只被一个 feature 用，它就不该进 domain。

**验收**：私有跨 feature 引用 462 → <180；循环 36 → <15；`domain` 的 import 图中不含 `@features/`、`@shared/`、`@platform/`（脚本校验）。

**风险**：迁类型会造成大面积 diff，review 困难。对策：每批只做「移动 + 改 import」，不改逻辑；类型别名过渡（`export type { NoteListItem } from '@domain/note/model'`）保留一个版本，下个版本删。

---

### T3 · 边界治理：从“记账”到“还账” `P0 起持续`

T2 解决根因，T3 解决机制。三件事：

1. **补齐零门面的模块**。`editor` 只有 1 个 public 文件（15 行），`surface` 1 个、`shell` 2 个、`properties` / `media-library` / `notifications` / `work-documents` 完全没有。这些模块是“只能穿墙”的结构性原因。
   最低要求：每个 feature 至少有一个 `public/<consumer>-api.ts`，导出其被外部实际使用的符号。
2. **门面命名统一为消费方视角**（现在 `memo/public/app-api.ts`、`shell/public/search-api` 是混用的半成品）。规则：`<consumer>-api.ts`，一个消费方一个文件。好处是“删一个消费方 = 删一个文件”，边界会随重构自然收窄。
3. **每周还账 15 条**。写进 `check-architecture.mjs` 的输出与 CI 注释：本周基线必须 ≤ 上周。连续两周未下降，CI 失败。

**验收**：12 周内 443 → <280；24 周内 → <180。

---

### T4 · 巨型文件治理：三个热点 + 一个通用闸门 `P1`

**现状**：16 个文件 >1000 行。三个“最大 + 抑制最多 + 无测试”三重交集：

| 文件 | 行数 | 抑制 | 测试 |
| --- | --- | --- | --- |
| `multidimensional-table/table-document-view.tsx` | 3,352 | 24 | 0 |
| `agent/thread-card/settings/external-agent-settings-controller.ts` | 2,457 | — | 0 |
| `agent/thread-card/agent-thread-card-view.tsx` | 2,076 | — | 0 |

**第 0 步（本周，1 天）：先上闸门，禁止增长**

```js
// scripts/check-file-size.mjs
const LIMITS = { warn: 600, error: 1000 };
// 豁免名单只减不增，且带“到期日”；到期未降则视为失败
const EXEMPT = new Map([
  ["features/multidimensional-table/table-document-view.tsx", { max: 3352, due: "2026-12-31" }],
  ["features/agent/thread-card/settings/external-agent-settings-controller.ts", { max: 2457, due: "2026-12-31" }],
  ["features/agent/thread-card/agent-thread-card-view.tsx", { max: 2076, due: "2026-12-31" }],
]);
```

**第 1 步：表格拆分**（沿用既有方案的三步走，补一个前置）

前置：先给 `table-document-view` 补 3 个行为测试（渲染空表 / 新增字段 / 编辑单元格），否则拆完无法判断是否拆坏。

```
table-document-view.tsx                 # 目标 ≤30 行
session/use-table-document-session.ts   # 状态 + 副作用（原 270–2593）
session/use-table-record-actions.ts     # 增删改 + 拖拽落位
session/table-view-model.ts             # 字段/可见记录/预设/筛选（纯函数，可测）
views/table-grid-view.tsx               # JSX（原 2594–3378）
views/table-field-header.tsx
```

硬约束：view 只接 `{ model, actions }` 两个对象，**不允许展开成 30 个 props**——否则只是把耦合搬家。

**第 2 步：agent 内部模块化**（不拆 feature）

`agent` 69,680 行（占前端 30%）已经是“超级模块”。拆成独立 feature 的代价（改 200+ import、断启动图）大于收益；正解是**内部子域 + 内部边界规则**：

```
features/agent/
├── core/            会话状态机、reducer、投影（20,616 行 store 收敛到这里）
├── thread/          渲染（thread-card 34,817 行，按 message/tool/attachment 再分）
├── settings/        配置 UI 与控制器
├── tasks/           任务流
└── public/          现有 13 个 consumer-api
```

新增 lint 规则：`agent/thread` 不得 import `agent/settings` 与 `agent/store` 内部（只能走 `agent/core` 的公开接口）。这条规则比“拆 feature”便宜十倍，收益接近。

**第 3 步：editor/extensions 治理**（25,726 行）

按“一个 node 一个目录”重组：`extensions/frontmatter/{index.ts, node-view.ts, property-editor.ts, markdown.ts}`。当前 `frontmatter-property-editor.ts` 1,090 行 + `frontmatter-node-view.ts` 1,084 行 + `frontmatter-model.ts` 三处分散，天然是一个子域。

**验收**：>1000 行文件 16 → 0；>600 行 ≤10；三个热点各降 60%；表格/编辑器测试全绿。

---

### T5 · 错误与可观测性：把“最后一公里”接上 `P0`

这是本次评审中性价比最高的一块：**不到 200 行代码，把“线上黑盒”变成“可定位”。**

**现状缺口**

| 能力 | 现状 |
| --- | --- |
| 全局未捕获异常 | `window.onerror` / `unhandledrejection` 命中 **0** |
| 错误上报钩子 | `ErrorBoundary.onError` 已实现，`app.tsx` 两处调用均未传 |
| 日志落盘 | `logger` 只有 console，不脱敏、不落盘 |
| 文案统一 | `toast.error` 399 处 vs `friendlyErrorMessage` 106 处 |
| 恢复路径 | agent 发送失败无“重发”，流中断无续传 |
| 静默吞错 | 436 个 catch 中 66 个（15%）不产生任何可观测行为 |

**目标结构**

```ts
// domain/error/app-error.ts —— 错误对象成型
export type ErrorKind = "network" | "timeout" | "auth" | "conflict" | "validation" | "storage" | "unknown";

export interface AppErrorShape {
  kind: ErrorKind;
  code?: string;          // 后端错误码 / IPC command 名
  retryable: boolean;
  userKey: string;        // i18n key，而非文案
  context?: Record<string, string | number | boolean>;
}

export class AppError extends Error {
  readonly shape: AppErrorShape;
  constructor(shape: AppErrorShape, options?: { cause?: unknown }) { /* ... */ }
}

export function normalizeError(input: unknown): AppError;
```

```ts
// shared/error/present-error.ts —— 唯一出口
export function presentError(
  input: unknown,
  options: {
    /** i18n fallback key，normalize 无法分类时使用 */
    fallbackKey: string;
    /** toast（瞬时）/ inline（就地展示，如表单） */
    surface?: "toast" | "inline";
    /** 提供则渲染「重试」按钮 */
    retry?: () => void;
    context?: Record<string, unknown>;
  },
): AppError;
```

```ts
// entrypoints/desktop.tsx —— 全局兜底（约 30 行）
installGlobalErrorHandlers({
  onError: (err, origin) => {
    const appError = normalizeError(err);
    logger.error("uncaught", { origin, ...appError.shape });
    // 启动阶段之后才弹 toast，避免首帧前打扰
    if (isStartupComplete()) presentError(appError, { fallbackKey: "error.unexpected" });
  },
});
```

**动作清单**

| # | 动作 | 量级 | 验收 |
| --- | --- | --- | --- |
| 1 | `installGlobalErrorHandlers`（onerror + unhandledrejection） | 30 行 | 人为 `Promise.reject(new Error())`，日志与 toast 均出现 |
| 2 | `app.tsx` 两处 `ErrorBoundary` 传 `onError` → `presentError` + logger | 10 行 | 组件抛错后控制台有结构化记录 |
| 3 | `logger` 加 sink 机制：console + 内存环形缓冲（500 条）；desktop 注入文件 sink | 80 行 | 崩溃后能导出最近 500 条 |
| 4 | `AppError` + `normalizeError` + `presentError`，先接 3 条主链（保存、agent 发送、文档打开） | 150 行 | 三条链路的错误文案不再出现原始 message |
| 5 | 增量替换 399 处 `toast.error`：按 feature 分批，先 table(98)/preferences(108)/memo(145) | 5 批 | 每批 PR ≤40 文件，`toast.error` 直调降至 <80 |
| 6 | lint 规则：`features/**` 禁止直接 `toast.error(`，白名单 `shared/error/**` | 10 行 | 新增违规立即报错 |
| 7 | 补恢复路径：agent 发送失败「重发」按钮；流中断自动重连（指数退避，最多 3 次） | 1 天 | 断网重连后消息不丢 |
| 8 | 静默 catch 分类清理：66 处逐个判定「应上报 / 应降级 / 应删」 | 1 天 | 空 catch 0 处；降级处加注释说明理由 |

**风险**：`presentError` 全量替换会改变用户看到的文案，可能触发“报错变了”的反馈。对策：先做 3 条主链，灰度一个版本后再铺开。

---

### T6 · 测试体系：从“有测试”到“测得准” `P0 起持续`

**现状**：405 文件 / 3,036 用例 / 62,168 行（0.37 : 1），但 31 个失败、无覆盖率阈值、冒烟只到启动屏。

**动作**

1. **修绿 31 个失败**（见 T1），并加 `check:test-health` 汇总：失败数、跳过数、耗时、flake 重试次数。
2. **覆盖率分级阈值**（`vitest.config.ts`）：

   ```ts
   coverage: {
     provider: "v8",
     thresholds: {
       // 全局只做“不倒退”的软线
       lines: 40, functions: 40,
       // 核心链路硬线
       "features/*/store/**": { lines: 70, functions: 70 },
       "features/*/use-cases/**": { lines: 70 },
       "domain/**": { lines: 85 },
     },
   }
   ```
   关键：**阈值只对已经达标的目录设**，不给全仓设一个够不到的数字——那只会让人加 `/* v8 ignore */`。
3. **契约测试**：给 12 个 `public/*-api.ts` 加导出快照测试（`expect(Object.keys(mod)).toMatchInlineSnapshot()`）。作用不是测逻辑，是让“公开了什么”变成可审查的 diff。
4. **冒烟推进到工作台**：`boot` 探针目前只到 spinner 消失。下一步用 IPC 桩推进到 `[data-workspace-host]`，再补一条“打开一个 note → 编辑 → 保存 → 重新打开”的端到端。
5. **三个巨型文件补行为测试**（T4 前置）：不追求覆盖率，只要锁住“空态/正常态/错误态”三条路径。

**验收**：`npm run verify` 中 test 稳定绿（连续 10 次无 flake）；核心目录覆盖率达阈值；契约快照覆盖 12 个 public API。

---

### T7 · 状态管理：32 个 store 收敛为一种范式 `P1`

**现状**：32 个 zustand store，三种写法并存（930 行内联 repository 型 / 647 行 slice 型 / 257 行薄壳型）；`devtools` 使用 0；跨模块读取 1,761 处 `getState()`；192 个手写 Map 缓存替代查询层。

**目标：两层状态 + 一个工厂**

```ts
// lib/store/create-feature-store.ts
export function createFeatureStore<T>(
  initializer: StateCreator<T>,
  options: { name: string; persist?: PersistOptions<T>; },
) {
  return create<T>()(
    options.persist ? persist(initializer, options.persist) : initializer,
  );
}
```

统一约定（写进 lint 与 review checklist）：
- 命名：`useXxxStore`；action 前缀固定 `set/load/upsert/remove/flush`，禁止自定义动词。
- 一切异步 action 返回 `Promise<void>` 且内部完成错误归一（不抛给组件）。
- store 不持久化派生数据（`threadProjections` / 缓存投影），只持久化源数据。

**服务端状态单独一层**（这是现在最大的空洞）：192 个手写 Map + 各自失效逻辑，等价于手写了一个没有一致性的缓存层。建议引入 `@tanstack/react-query` 管 IPC 读：

```ts
// features/document/services/queries.ts
export const documentQuery = (path: string) => ({
  queryKey: ["document", path],
  queryFn: () => invoke<DocumentPayload>("read_document", { path }),
  staleTime: 30_000,
});
// 保存后失效
queryClient.invalidateQueries({ queryKey: ["document", path] });
```

对启动体积的影响：`react-query` gzip ≈ 12 KB，但只被非启动路径引用即可（用 `import()` + 组件内 hook）。若评估后仍不可接受，退化为自研 `lib/query`（key 注册表 + TTL + 失效事件），但**必须有统一层**，不能继续各写各的 Map。

**验收**：store 数量 32 → ≤12（合并派生型与重复型）；`devtools` 覆盖率 100%；`getState()` 从 1,761 降到 <500（其余走选择器或 query）；新代码不再出现模块级 `new Map()` 缓存。

---

### T8 · 样式系统：让 token 真的被用 `P2`

**现状**：`styles/` 42 文件 / 17,429 行 / 391 个 `!important`；arbitrary value 3,849 处，其中 `text-[var(--foreground)]` 455 处、`text-[var(--muted-foreground)]` 634 处，而语义类 `text-foreground` 只用 8 次；loading skeleton 6 份、EmptyState 4 处、`createPortal` 裸用 11 处。

**动作**

1. **一把梭替换高频 arbitrary value**（脚本 + 人工复核）：
   `text-[var(--foreground)]` → `text-foreground`（455）
   `text-[var(--muted-foreground)]` → `text-muted-foreground`（634）
   `bg-[var(--background)]` → `bg-background`（约 80）
   `border-[var(--border)]` → `border-border`（约 120）
   剩余 `var()` 用法逐个判断：是尺寸/圆角 → 建 token；是一次性微调 → 保留并加注释。
2. **`!important` 清零**：391 个按来源分三类——(a) 覆盖第三方库（保留，但收敛成 `.flowix-override-*` 命名空间）；(b) 覆盖自身样式（删，改优先级）；(c) 历史遗留（直接删，跑视觉对比）。
3. **CSS 预算**：`check:web-bundle` 增加两条——入口 CSS gzip ≤55 KB、`!important` 数量不得增长。CSS 拆包沿用既有 2.4 方案（agent-thread-card 5.1k 行、table 890 行、pdf-print 598 行改组件旁导入），用 `check:agent-style-boundaries` 的三面对比守门。
4. **组件收敛**：6 份 skeleton → 1 个 `<Skeleton variant>`；4 处 EmptyState → `shared/ui/empty-state.tsx`；11 处裸 `createPortal` → `shared/ui/portal.tsx`（统一挂载点与卸载清理）。

**验收**：arbitrary value <1,000；`!important` = 0（或全部收敛到 3 个 override 文件）；入口 CSS ≤55 KB；skeleton/empty-state 各 1 份。

---

### T9 · 扩展点收敛 `P2`

按 §1.5 的 `defineSurface` 重构。分两步，避免一次性大改：

1. **先加新接口，让新 surface 用它**（1 个 PR）。旧 surface 不动，用适配器包一层。
2. **再逐类迁移**（每个 surface 一个 PR）。每迁一个，删掉 `switch` 里的一个分支；分支清零后删 `switch` 本身。

同时定义 plugin 的能力边界（这是决策，不是缺陷）：
- plugin 可以：注册产物 renderer、声明新的 format、提供解析器。
- plugin 不可以：注入 React 组件、新增 surface kind、访问 IPC。
理由：插件代码在主 WebView 内运行，注入组件等于给它完整 DOM 与 store 访问权。当前“封闭但安全”的设计应保持，把边界写进 `PLUGIN-DEVELOPMENT.md`，避免后来者误以为是待补功能。

**验收**：新增 surface 2 文件；`workspace-surface-renderer-registry.tsx` 从 400+ 行降到 <80 行；`switch (kind)` 出现次数 9 → 0。

---

### T10 · 概念统一：Note / Document / File 的定义 `P1`

**现状**：Note 6,741 次 / Document 3,881 次 / File 2,686 次 / Memo 1,448 次；`note-store` 与 `document-store` 并存；`features/document` 里提到 note 266 次，`features/memo` 里提到 document 316 次。

**这不是命名偏好问题，而是模型缺失**：没有区分“存储实体”和“打开中的编辑会话”，于是两个 store 都在兼任。

**定义（写进 `docs/adr/0001-note-document-terminology.md`）**

| 术语 | 含义 | 归属 |
| --- | --- | --- |
| **Note** | 笔记本里的一个 Markdown 存储单元（磁盘上有对应文件） | `domain/note` |
| **Document** | 一次“打开”的编辑会话：buffer + revision + 保存状态 + 焦点 | `domain/document` |
| **File** | 磁盘上的任意文件（含非 Note：图片、CSV、PDF、代码） | `domain/file`（可并入 note） |
| **Memo** | **仅指旧的 memo-content 渲染形态**，逐步淘汰；`memo` feature 应改名为 `notes` | `features/memo` → `features/notes` |

命名规则：
- 磁盘路径/列表/元数据 → `Note`
- 编辑器里的 buffer/脏标记/保存 → `Document`
- 展示层图标/类型判定 → `File`
- 禁止新增 `memo` 命名（除历史 API）

迁移策略：**先加定义与 lint 禁止项，再改代码**。`features/memo` 改名放到 T4 的 agent 模块化之后（一次性改 161 个文件，需独立窗口），改名前先用 codemod 统一 `memo` → `note` 的内部符号。

**验收**：ADR 落地；新增代码零 `memo` 命名；`note-store` 不再持有编辑器会话状态（buffer 归 `document`）。

---

### T11 · 性能：预算继续 ratchet `P1`

| 项 | 现状 | 目标 | 手段 |
| --- | --- | --- | --- |
| 启动图 gzip | 322,791 / 340 KB | ≤300 KB | 继续找静态边；新增大模块默认 `lazy()` |
| 入口 CSS gzip | 69 KB（489 KB raw） | ≤55 KB | T8 拆包 |
| `React.memo` 使用 | 7 处 vs `useCallback` 638 处 | 长列表项 100% memo | 列表项组件统一 `memo`，props 扁平化 |
| 列表虚拟化 | 已引入 `@tanstack/react-virtual` | memo-list / 表格 / 文件树均启用 | 逐列表核对 |
| 打开文档 P95 | 有 `document-open-perf.ts` 但无预算 | <300 ms | 建预算并进 CI（本地基准） |
| 渲染长会话 | 单条消息降级已有 | 1,000 条消息可交互 | 虚拟化 + 分片渲染 |

**注意**：这个项目的性能问题不是“慢”，而是“没有预算”。已有启动预算这套机制很好，应把同样的 ratchet 思路复制到 CSS、交互延迟、首次打开耗时三项。

---

### T12 · 依赖、IPC 类型与文档 `P1`

1. **删 6 个零引用依赖**：`date-fns`、`react-markdown`、`remark-gfm`、`@tiptap/extension-color`、`@tiptap/extension-text-style`、`prosemirror-gapcursor`（本次逐个 grep 复核，`from "<pkg>"` 命中数均为 0；最后一个实际用的是 `@tiptap/pm/gapcursor`），可直接 `npm uninstall`。
2. **图标统一 lucide**：`@phosphor-icons/react` 只剩 1 个文件引用，先立规则（`no-restricted-imports` 禁止新增），再替换。
3. **IPC 类型生成**：338 个 `#[tauri::command]` 目前靠手写类型对齐。引 `tauri-specta` 生成 `bindings.ts`，`invoke` 全部走生成类型。短期不引也必须给 `write_* / delete_* / rename_*` 加运行时参数校验——这三类出错等于丢数据。
4. **路径规范化收口**：`lib/path.ts` 补 `toPosix` / `stripBoundarySlashes` / `canonicalRelativePath`，替换 113 处手写。这是 Windows 数据边界 bug 的高发点。
5. **HTML 出口收口**：`lib/trusted-html.ts` 提供唯一 `renderTrustedHtml()`，`no-restricted-syntax` 禁止直接 `innerHTML =`。
6. **文档纠偏**：`CLAUDE.md` 的目录树（`main.tsx` / `components/editor/` / `lib/tauri/client.ts`）已全部失效，改为指针 + 三条硬规则；新增 `docs/adr/` 目录，术语、分层、扩展点各一篇。

---

## 3. 执行机制

方案的价值 80% 在执行机制。没有下面这套，“优化”会在第三周变成“优化过”。

### 3.1 四个 wave

```
Wave 0  第 1–2 周    止血：红转绿 + 全局兜底 + 文件闸门 + 看板
 ├─ T1 全部门禁修绿（含 31 个测试）
 ├─ T5-1~3 全局错误兜底 + logger sink
 ├─ T4-0 巨型文件「禁止增长」闸门
 └─ T6-1 check:test-health

Wave 1  第 3–8 周    结构性：domain 前三批 + 表格拆分 + CSS 拆包
 ├─ T2 批 1/2/3（surface→workspace、table→document、table→collection）
 ├─ T4-1 表格三步走（先补 3 个行为测试）
 ├─ T5-4~6 错误统一（3 条主链 + 15 处替换/周）
 └─ T8-3 CSS 拆包（并行，独立 PR）

Wave 2  第 9–16 周   收敛：agent 模块化 + 状态统一 + 扩展点
 ├─ T2 批 4/5/6
 ├─ T4-2 agent 内部子域 + thread 边界规则
 ├─ T7 状态范式统一 + 查询层（先做 1 个 feature 试点）
 ├─ T9 surface 新接口 + 迁移 3 类
 └─ T6-3 契约测试 / T6-4 冒烟到工作台

Wave 3  第 17–24 周  收尾：概念统一 + 样式 + 性能 + 文档
 ├─ T10 术语 ADR + memo→notes 改名
 ├─ T8 arbitrary value 替换 + !important 清零
 ├─ T11 预算复制（CSS/交互/打开耗时）
 └─ T12 依赖/IPC 类型/文档
```

依赖关系（硬约束，不允许并行打乱）：
`T1 → 其他一切`；`T6-1 → T4-1`；`T4-1 → T10（改名）`；`T8-3 → T11-CSS 预算`；`T2 → T9（surface 契约下沉后才能统一接口）`。

### 3.2 债务 ratchet 协议

| 规则 | 内容 |
| --- | --- |
| 只减不增 | 基线文件与抑制表只允许删除条目；新增需 PR 内说明 + 两人 review |
| 周节流 | 每周至少 -15 条架构债务、-10 处 `toast.error`、-3 个 arbitrary value 集群 |
| 输出可见 | CI summary 打印四项进度条（见 T1-3），PR 里能看见 |
| 到期制 | 豁免项必须带 `due` 日期；到期未达标视为失败，不许续期两次 |
| 复盘 | 每两周 15 分钟看板回顾：只问“为什么没降”，不问“进度多少” |

### 3.3 PR 检查单

```markdown
- [ ] npm run verify 全绿（tsc / eslint / arch / test / bundle）
- [ ] 新增跨 feature 引用走 public（否则 PR 描述需说明何时补）
- [ ] 新增文件 ≤600 行；修改巨型文件不得增加行数
- [ ] 异步失败有可见路径（presentError 或 fireAndForget + 理由）
- [ ] 新增状态属于 §1.4 的哪一层？写在 PR 描述里
- [ ] 涉及 CSS 的改动附改动前后截图（agent/editor 区域必附）
```

### 3.4 角色（最小集，按现有团队规模即可）

| 角色 | 职责 |
| --- | --- |
| 架构 owner（1 人） | 维护 `architecture.config.json`、基线、ADR；每周发布债务看板 |
| 各 feature owner | 本模块内的 T2/T3/T4/T8 动作；对 public 出口负责 |
| 质量 owner（可兼） | 门禁可信度（测试稳定性、flake、覆盖率） |
| 产品/设计（可兼） | 术语 ADR 的最终裁定（Note/Document 影响用户心智） |

---

## 4. 度量看板

每项都有复算命令，任何人不依赖记忆就能验证。

| # | 指标 | 当前 | 3 个月 | 6 个月 | 12 个月 |
| --- | --- | --- | --- | --- | --- |
| 1 | `npm run verify` | ❌ 3 项红 | ✅ | ✅ | ✅ |
| 2 | 架构债务条目 | 443 | 280 | 180 | <80 |
| 3 | 私有跨 feature 引用 | 462（57.3%） | 350（43%） | 240（28%） | <130（15%） |
| 4 | 双向依赖对 | 36 | 24 | 15 | <8 |
| 5 | 千行文件 | 16 | 10 | 4 | 0 |
| 6 | 最大单文件行数 | 3,352 | 2,100 | 1,200 | ≤800 |
| 7 | 全局未捕获异常 | 不可见 | 有日志 | 有日志+上报 | 有归因看板 |
| 8 | `toast.error` 直调 | 399 | 250 | 120 | <60 |
| 9 | 测试失败数 | 31 | 0 | 0 | 0 |
| 10 | 核心目录覆盖率 | 无统计 | 有报告 | 70% | 80% |
| 11 | arbitrary value | 3,849 | 3,200 | 1,500 | <600 |
| 12 | 新增 surface 改动文件数 | 11 | 11 | 3 | 2 |
| 13 | 启动图 gzip | 322,791 | 315,000 | ≤300,000 | ≤290,000 |
| 14 | 入口 CSS gzip | 69 KB | 62 KB | 55 KB | 50 KB |

第 1、2、3、5、9 项建议做成仓库首页 badge 或 CI 注释，让“债务”变成每天都在眼前的东西。

---

## 5. 风险与止损

| 风险 | 触发信号 | 处置 |
| --- | --- | --- |
| domain 迁移引发行为回归 | 迁移后测试失败集中在路径/排序 | 每批只移动不改逻辑；保留类型别名一个版本；单批回滚（不跨批） |
| CSS 拆包造成级联失效 | `check:agent-style-boundaries` 三面对比出现差异 | 立即回滚该块；改用「按 surface 加命名空间」再拆 |
| 引入查询层拖大启动图 | `check:web-bundle` 超预算 | 只允许 `import()` 引用；超预算即退化为自研轻量层 |
| 错误文案统一引发用户困惑 | 客服/反馈集中提到“报错变了” | 先改 3 条主链，观察一个版本；保留原始 message 到日志不打到 UI |
| 测试补测变成刷覆盖率 | 出现大量 `/* v8 ignore */` | 阈值只设在已达标目录；review 关注“测的是行为还是实现” |
| 拆分巨型文件拆坏表格 | 表格 kanban/字段编辑回归 | 前置 3 个行为测试；每步独立 PR + 截图 |
| 债务节流变成运动式冲刺 | 某周一次性 -100 条然后停滞 | 节流看“连续 12 周斜率”，不看单周峰值 |

---

## 6. 收益预测

| 维度 | 当前 | 6 个月 | 12 个月 | 主要贡献 |
| --- | --- | --- | --- | --- |
| 架构简洁性 6.5 | | 7.8 | 8.6 | T2/T3/T4/T9 |
| 代码健壮性 7.5 | | 8.4 | 8.8 | T5/T6/T7 |
| 可维护性 6.5 | | 7.9 | 8.7 | T4/T6/T12 |
| 错误处理 6.0 | | 7.6 | 8.5 | T5 |
| 一致性/扩展性 5.5 | | 7.2 | 8.4 | T7/T8/T9/T10 |
| **加权总分** | **64.5** | **≈77** | **≈85** |

投入估算（单人日，按现有团队并行）：Wave 0 ≈ 8 人日；Wave 1 ≈ 35 人日；Wave 2 ≈ 55 人日；Wave 3 ≈ 40 人日。合计约 **140 人日**，其中约 40% 可与功能迭代并行（样式、文案、依赖、文档）。

**最划算的三笔**（若只能做三件）：
1. T5-1~3 全局兜底 + logger sink（≈3 人日，把黑盒变可观测）；
2. T1 全部门禁修绿（≈3 人日，恢复“红灯=停手”的纪律）；
3. T4-0 巨型文件闸门（≈1 人日，止住复杂度继续集中）。

三件合计不到 8 人日，能同时改善四个维度的下限。

---

## 7. 明确不做的事

| 不做 | 原因 |
| --- | --- |
| 按 DDD 全量重排目录（移动 1,400 文件） | 产生不可 review 的 diff；收益低于增量域收敛 |
| 把 agent 拆成独立 feature | 200+ import 与启动图风险大于收益；改为内部子域 + 边界规则 |
| 把 agent thread-card 重写成 React | 命令式渲染是为流式性能做的，重写风险高；只补 `dispose()` 与边界 |
| 合并多套 Markdown 管线 | Worker 隔离与安全模型的差异是必要的；只统一 tokenizer 真源 |
| 给全仓设统一覆盖率阈值 | 会诱发忽略注释；按目录分级 |
| 用 `--update-baseline` 让门禁变绿 | 一旦允许，基线不再下降 |
| 让 plugin 注入 React 组件 | 等于给插件完整 store/DOM 权限；保持“封闭但安全” |
| 一次性替换 399 处 toast | 文案突变风险；按 feature 分批灰度 |

---

## 8. 第一周就能开始的三件事

1. **今天**：`vitest.setup.ts` 补 `ResizeObserver` polyfill + `stable-caret.ts:318` 加方法判断 → 31 个失败降到个位数。
2. **明天**：给 2 个文件补 public 出口，清掉 7 个 lint error 与 3 条 arch 违规 → 两条红灯转绿。
3. **第三天**：在 `entrypoints/desktop.tsx` 挂 `installGlobalErrorHandlers` → 从此线上异常不再是黑盒。

完成这三件，`npm run verify` 会第一次真正全绿。**这是后面所有结构性改造的前提**——门禁不可信的时候，任何重构都只能靠人肉 review 兜底。
