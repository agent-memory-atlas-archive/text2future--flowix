# Flowix 性能设计审查

审查日期：2026-10-19
范围：`app/flowix-web`（React 19 + TipTap + Zustand）、`app/flowix-desktop` / `app/flowix-core`（Tauri v2 + Rust）
方法：静态阅读 + 现有构建产物（`.build/web-dist`）度量。**未做运行时 profiling**，结论均附代码位置，可逐条复核。

## 0. 体感结论

| 体感症状 | 主要根因 | 优先级 |
| --- | --- | --- |
| 展开文件夹、全局搜索时整个窗口卡住 0.1~1s | 同步 Tauri command 在主线程做全库扫描 | P0 |
| 笔记多了以后列表滚动发涩、切换筛选要等 | 主列表不虚拟化，5k 行常驻 DOM；树行 selector 做 O(行×笔记) 查找 | P0 |
| 长文打字后段掉帧 | 4 个 ProseMirror 插件每次输入全文档重扫 | P0 |
| 媒体库滚动掉帧、图片多了卡 | scroll 直接 setState、派生数据每次 render 全量重算、masonry 全量挂载 | P0 |
| 自动保存时偶发卡顿 | 每次保存全文写两遍 + 全树序列化三遍 | P1 |
| 冷启动偏慢 | 入口 CSS 与默认语言文案仍全量进入首屏 | P1 |

启动图实测（`node` 解析 `.build/web-dist/.vite/manifest.json` 静态 import 闭包）：
**JS 1,180,859 B raw / 363,418 B gzip；入口 CSS 452,174 B raw / 64,922 B gzip。**
与初始基线相比，启动 JS 静态闭包减少 94,462 B gzip；入口 CSS 尚未拆分。

---

## 1. 冷启动

### 1.1 编辑器内核进了启动图（已处理）

启动副作用改为从 `*-data` / `memo-resolver` 直接导入，绕开同时导出 TipTap NodeView 的扩展 barrel。构建 manifest 的静态闭包不再包含 `_tag-mention` / `_note-mention` NodeView chunk。

这项调整把启动 JS gzip 从 457,880 B 降到 363,418 B（减少 94,462 B）。此前预估节省完整 99 KB 不准确；构建仍会把部分共享依赖留在启动图中。入口 CSS 和默认语言消息仍需单独拆分，见 1.2 与 1.3。

### 1.2 全量 CSS 阻塞首帧（P1）

`styles/index.css:15-37` 一次性 `@import` 了编辑器、多维表格、mermaid、Agent composer、PDF 打印等首屏不可见样式，最终产出单文件 **452 KB / 65 KB gzip**，作为 `<link rel=stylesheet>` 阻塞首屏渲染。

修法：按 surface 拆分 CSS，编辑器/表格/媒体库样式跟随各自的 lazy chunk 引入；主题色板与滚动条保留在入口。

### 1.3 默认语言文案全量进主包（P2）

`lib/i18n/locales.ts:1` `import zhCNMessages from './messages.zh-CN'`（文件约 129 KB）。注释说明 en-US 已动态加载，但默认语言仍是 eager。首屏实际只用到 `startup.*` 等十几个 key。

修法：默认语言同样按 chunk 加载（首屏可用内联的极小子集），或按 feature 拆分消息表。

### 1.4 启动串行 await 链（P2）

`app/main-window-startup.ts:81-108`：`waitForStartupReady` → `getStartupNotebookId` → `initializeNotebookContext`（内部 `notebooks.getAll`）→ `waitForWorkbenchMounted` → `afterShellPaint` → `notifyStartupInteractive`。

`getAll` 与 `getStartupNotebookId` 之间没有数据依赖，却被串成瀑布；shell 释放前多等一个完整 IPC 往返。

修法：两个 notebook 查询 `Promise.all`；shell gate 只依赖 notebook identity，不依赖列表内容。

### 1.5 250ms 轮询启动状态（P2）

`app/app.tsx:287` `timer = window.setInterval(() => void refresh(), 250);`

迁移期每秒 4 次跨进程 `getStartupStatus` + `setState`，与首屏列表查询抢 IPC。

修法：改为后端事件推送（Tauri `emit`），前端只在 mount 时取一次快照。

### 1.6 MainLayout 全量订阅启动 store（P1）

`features/shell/main-layout.tsx:284` `const workspaceStartup = useWorkspaceStartupStore();` —— 无 selector，整个 store 任何字段变化都让主布局整树重渲（同文件 `:276-281` 已经有一个 `useShallow` 的窄订阅，说明这是遗漏）。

同文件 `:899` `startupIdentity={JSON.stringify(navigationState.target)}` 每次 render 都重新序列化。

修法：删掉全量订阅或改 `useShallow` 取具体字段；`startupIdentity` 用 `useMemo` 并以稳定 key（notebookId + path）替代整对象 stringify。

---

## 2. 列表与滚动

### 2.1 主列表完全不虚拟化（P0）

`features/memo/components/memo-list.tsx:174-175` 注释明确 “renders its loaded rows in normal document flow”；`:743` `const renderedMemoRows = filteredMemos.map(renderMemoRow);`；`:1539` 整块渲染。

分页 50 条（`features/memo/store/note-store.ts:55`），但 `loadMoreMemos` 只追加不设上限，注释按 5k 笔记设计。5k 行 → 5k 个 `MemoCard` 元素常驻 DOM，任何父级 state 变化（筛选、选中、滚动提示）都要重新创建并协调 5k 个元素，`React.memo` 只省子组件渲染，省不了元素创建与 diff。

修法：接入仓库里已有的 `features/memo/hooks/use-dynamic-virtual-list.ts`（目前仅 `notebook-file-tree.tsx:621` 在用），固定估算高度 + `measureElement`，overscan 8~12。

### 2.2 树行 selector 里做 O(行×笔记) 查找（P0）

`features/memo/components/notebook-tree-row.tsx:207-212`：
```ts
const storeNote = useNoteStore((state) => {
  const notebook = state.notebooks.find((candidate) => item.fullPath.toLowerCase().startsWith(...));
  ...
  return state.notes.find((candidate) => candidate.notebookId === notebook.id && candidate.relativePath === relativePath) ?? null;
});
```
每个可见行、每次 note store 变更都要：对 notebooks 做 `startsWith` + `toLowerCase` 匹配，再对 notes 全量线性扫描。

影响：5000 笔记 × 50 可见行 ≈ 25 万次字符串比较 / 每次 store 更新（编辑时每次保存都会触发）。这是“看着没干什么却一直占 CPU”的典型来源。

修法：在树根用 `useMemo` 建 `Map<`${notebookId}:${relativePath}`, NoteListItem>` 传入行组件，行内 O(1) 查表；notebook 匹配也应在树根预处理成 path→notebook 前缀表。

### 2.3 置顶区拉全部收藏（P1）

`features/memo/components/use-notebook-pinned-notes.ts:62-75` 用 `while (!cancelled)` 逐页拉完所有 `favorited` 笔记，`notebook-file-tree-sections.tsx:60` 直接 `items.map` 全渲染。

修法：置顶区只取前 N 条（如 20）+ “查看全部”，或独立虚拟化。

### 2.4 媒体库：滚动 setState + 无 memo + 全量 masonry（P0）

- `features/surface/document-list-view.tsx:329-339`：`scroll` 事件直接 `setViewport({...})`，无 rAF 合并。
- 同文件 `382-394`：`new Set(...)`、`linkedItems.filter(...)`、`toLocaleLowerCase()`、`new Map(...)`、`[...folders, ...items]` 全部在 render 体内，**整个文件没有一处 `useMemo`**。
- 同文件 `482-484`、`791`：所有已加载项按列取模后全量挂载，无窗口化。

影响：每个 scroll 事件（60~120 次/秒）× 全量过滤/去重 × 全量卡片重渲，媒体库一滚就掉帧；每张卡还带独立的 `IntersectionObserver` 与 effect。

修法：viewport 用 rAF 节流；`visibleItems` / `mediaColumns` 用 `useMemo` 并依赖 `items.length` 与筛选条件；卡片列表按可视区窗口化（列内 slice）。

### 2.5 标签树折叠不减少 DOM（P2）

`features/memo/components/tag-tree.tsx:147-151` 注释 “折叠的子树行留在 DOM 中”，`:618` 全量 `visibleTagOptions.map`。标签无上限，收起只改高度不改 DOM。

修法：折叠节点条件渲染（配合有限高度动画），或虚拟化。

---

## 3. 编辑器打字

自动保存与序列化的基础是健康的：`features/editor/markdown-editor.tsx:78-79` 有 200ms 序列化 debounce + 500ms idle timeout，`features/document/store/document-commit-queue.ts:83-84` 有 300ms 静默 / 最长 2s 的合并写。问题集中在 **ProseMirror 插件层的全文档重扫**。

### 3.1 tag 装饰每次输入重建全量（P0）

`features/editor/extensions/tag.ts:80`
```ts
transaction.docChanged ? createTagDecorations(newState) : value
```
`createTagDecorations`（`:20-45`）：`doc.descendants` 遍历全部文本节点，**逐字符** `charToPM.push(pos + index)`，拼出全文 `plainText` 后再 `matchAll(TAG_REGEX)`。

影响：3 万字笔记每键 ≈ 3 万次数组 push + 一次全文正则，1~3ms，且产生大量临时对象/GC。长文后段打字明显发涩。

修法：用 `tr.mapping.mapResult` 映射旧装饰集，只对变更区间重扫；`charToPM` 改为按 textblock 增量维护或直接用 `doc.textBetween` + 位置映射。

### 3.2 noteReference / 附件每次输入 4 次全文档遍历（P0）

`features/editor/extensions/note-link/view-note.ts:766` 每 `docChanged` 重建 caret 装饰；`:773` 的 `appendTransaction` 再全扫一次；`attachment-link/nodes/view-file.ts:359-370` 同一套逻辑。

影响：两个插件叠加 → 每键 2 次 DecorationSet 全量重建 + 2 次 hardBreak 全扫，命中处还各做 `doc.resolve`。

修法：caret 装饰走 mapping 增量；`appendTransaction` 只检查变更范围所在 block 的边界节点。

### 3.3 Shiki 每次 rAF 重算全部代码块（P1）

`features/editor/extensions/codeblock-shiki/shiki/shiki-plugin.ts:77-81`
```ts
if (didChangeSomeCodeBlock && pendingRaf === null) {
  pendingRaf = requestAnimationFrame(() => { ... requestWorkerRecompute?.() })
}
```
`:121-126` 收集全文档所有代码块，worker 端 `shiki-tokenizer.worker.ts:68` `blocks.map(codeToTokensBase)`。

影响：只有 rAF 节流、没有时间防抖，也没有按块缓存；在代码块里打字会让所有代码块重新分词，主线程再重建全部 inline 装饰。

修法：按块文本 hash 缓存 token；只重算变更块；加 150~250ms debounce。

### 3.4 工具栏 / 气泡 / 大纲每键重渲（P1）

- `features/editor/components/editor-toolbar.tsx:110-111`：`selectionUpdate` 与 **`transaction`** 都调用 `updateActiveStates`，每次输入 `setState`。
- `features/editor/components/selection-bubble-menu.tsx:72-77`：每个 transaction `rerender()`。
- `features/editor/components/heading-outline-navigation.tsx:22` + `:165`：每次 `update` 做 `querySelectorAll('h1..h4')` + 逐项 `textContent` + `setState`。

影响：每键 3 个组件重渲，其中大纲还触发一次全 DOM 查询与样式计算。

修法：toolbar/bubble 先比较 `editor.state.selection` 与 active marks 再决定是否 setState；大纲 200ms debounce 并做结果 diff。

### 3.5 拖拽时每帧全文档扫描 + 同步布局（P2）

`features/editor/extensions/block-drag.ts:531-552` 在 `doc.descendants` 内对每个列表项 `getBoundingClientRect()`，`:610-625` 再扫列表容器；`use-block-drag-gesture.ts:206-211` 每个 rAF 调用一次。

修法：拖拽开始时缓存块矩形，移动中只做坐标比较。

---

## 4. 保存链路

### 4.1 每轮自动保存全文写两遍（P1）

`features/document/store/document-session-service.ts:110-112`：
```ts
void protectDocumentDraft(session.identity, path, 'autosave');
if (hasUnsavedLocalChanges(identity)) { void flushDocument(...) }
```
`protectDocumentDraft` 走 `platform/tauri/client/recovery.ts:4-5` 的 `invoke('write_recovery_draft', { draft })`，即**先写一份恢复草稿，再写正式文件**——正常保存路径下这份草稿是冗余的；只有 save-error/timeout 才需要。

修法：正常保存成功后再决定是否写草稿；或仅在内存里保留待写内容，失败时才落草稿。

### 4.2 序列化一次保存三遍全树（P2）

`features/editor/markdown-editor-extensions.ts:198` 先 `getJSON()`，`:149` 再递归 clone 全树做规范化，最后 markdown stringify。

修法：clone 只处理含 bold 等需规范化的节点，其余复用 JSON 引用。

### 4.3 保存把全文提升到容器 state（P1）

`features/document/components/session/use-document-autosave.ts:51-53`：
```ts
live.current.setState(previous => previous.fullContent === content ? previous : ({ ...previous, fullContent: content, charCount, ... }));
```
`document-container.tsx:686` 把 `state.fullContent` 传给编辑器，`:599-607` 每次变化都向父层推整篇正文。

影响：每次保存取样都重渲 DocumentContainer + header/toolbar，并跨层传大字符串。

修法：正文留在 buffer/ref，容器只订阅 `charCount` / `saveState` 等窄字段。

---

## 5. Rust 后端

### 5.1 同步 command 在主线程做全库扫描（P0）

Tauri v2 中 `#[tauri::command]` 不加 `async` 即在主线程执行（IPC handler），会直接冻结窗口。

- `flowix-desktop/src/commands/file.rs:911` `pub fn get_file_tree(...)`（无 async）→ `:919 memo_tree_metadata_for_directory` → `:215 read_note_entries(&config.id)`。
- `flowix-desktop/src/commands/memo/reads.rs:391` `pub fn search_path_notes(...)`（无 async）→ `:397 NoteService::search`。
- `commands/file.rs:968` `fs::read_to_string`。

影响：展开任意文件夹都要读整本笔记的元数据，`file.rs:227-235` 还对每篇笔记 `canonical_path()`（系统调用）；搜索同理。用户侧表现为“点一下文件夹整个界面定住”。

修法：这三类 command 改 `async` + `tauri::async_runtime::spawn_blocking`；`get_file_tree` 改为按父路径前缀直接查 SQLite，不再全表过滤。

### 5.2 分页是「全目录扫描后截断」（P1）

`flowix-desktop/src/commands/document_list.rs:296-368`：`fs::read_dir` 遍历整个目录 → 全量 `sort_by` → 再按 cursor/limit 切前 N 条。虽然已在 `spawn_blocking` 里，但每翻一页都重做一遍 readdir + stat + 排序，cursor 不减少任何工作量。

修法：目录级快照缓存（mtime 失效），或维护有序索引做真正的游标扫描。

### 5.3 索引查询每次新建 SQLite 连接并重跑 DDL（P1）

`flowix-core/src/memo_file/note_index.rs:1039`（`note_index_is_ready`）与 `:1045`（`open_note_index_connection`）——一页查询两次判断；`:1784-1805` `Connection::open` + `PRAGMA` + 一长串 `CREATE TABLE IF NOT EXISTS` + `CREATE VIRTUAL TABLE IF NOT EXISTS`。

影响：翻页/滚动的固定开销大于取 50 行本身。

修法：连接池（或每 notebook 一个长连接）；schema 初始化用进程内 `OnceLock` 标记，只跑一次。

### 5.4 保存每次 fsync + 重复全文读写（P2）

`flowix-core/src/memo_file/file_io.rs:35` `temporary.as_file().sync_all()`；`note_index.rs:338 refresh_note_path` 里 `fs::read` + SHA256 + 新事务。

修法：自动保存走合并写、去 fsync（退出/手动保存再 fsync）；索引更新进增量队列异步落库。

### 5.5 文件监听逐条事件处理（P2）

`watcher/manager.rs:704-709` 每个事件 `wait_for_markdown_copy_to_settle` + `FileRevision::read`（`watcher/filter/mod.rs:32 fs::read`），`watcher/processor.rs:204-218` 最多 8×50ms 等待，`:81` 再读一次算 hash。

修法：按路径 debounce 合并；用 `(size, mtime)` 代替全文 revision；批量事件成组处理。

---

## 6. 结构性 / 长期问题

1. **巨型组件**：`features/multidimensional-table/table-document-view.tsx` 3,606 行、`notebook-file-tree.tsx` 1,884 行、`memo-list.tsx` 1,580 行。state 变化无法局部化，是 2.1 / 2.2 的放大器。建议按“数据订阅层 / 渲染层 / 交互层”拆分。
2. **双图标库**：61 个文件用 `@phosphor-icons/react`，99 个文件用 `lucide-react`，两套同时进产物。建议统一到一套（或至少在入口做一次映射层），可直接省掉几十 KB 与一套运行时。
3. **缺统一的列表容量策略**：分页大小、是否虚拟化、置顶区上限散落在各 feature 内，没有共享约定，导致同类问题反复出现。

## 7. 已经做对的部分（避免重复投入）

- 编辑器序列化已 debounce（200ms）+ idle 合并；保存有 commit queue 合并写。
- 文件树已虚拟化（`use-dynamic-virtual-list`，固定估算 + measure + overscan）。
- 全局搜索有 150ms debounce（`features/shell/components/global-search-command.tsx:154`）。
- 索引层已有 SQLite 投影 + FTS5 trigram + size/mtime/hash 三级增量，不是“每次全量读正文”。
- 构建有 bundle 预算门禁（`scripts/check-web-bundle.mjs`），Shiki 语法、mermaid、katex 已隔离为可选 chunk。
- `vite.config.ts` 已对 KaTeX/Inter 字体做 woff2 收敛。

## 8. 修复进度（2026-10-19）

本轮只落地「确定性高 + 改动小」的部分，其余保持原样。

### 已改

| 位置 | 改动 |
| --- | --- |
| `flowix-desktop/src/commands/file.rs` | `get_file_tree` / `get_dir_children` / `read_file` 改 `async` + `spawn_blocking`，用 `AppHandle` 取状态 |
| `flowix-desktop/src/commands/memo/reads.rs` | `search_path_notes` 同上 |
| `features/shell/main-layout.tsx:284` | 全量订阅改 `useShallow`，只取 `status` / `error` |
| `features/surface/document-list-view.tsx` | scroll / ResizeObserver 合并到 rAF 且值不变时 bail out；`excludedMediaPathSet` / `visibleItems` / `mediaColumns` 改 `useMemo` |
| `features/editor/components/heading-outline-navigation.tsx` | `update` 改 200ms debounce，标题结果做 identity 比较后再 setState |
| `app/agent-window-effects.tsx`、`app/main-window-effects.tsx` | 缓存失效函数改从 `*-data` / `memo-resolver` 直接导入，绕开扩展 barrel |

### 第二批（架构清晰、改动收敛的部分）

| 位置 | 改动 | 消除的成本 |
| --- | --- | --- |
| `features/memo/store/note-store.ts` | 新增 `noteIndexFor()` / `noteLookupKey()`，用 `WeakMap` 按数组 identity 缓存 `notebookId + relativePath → 笔记` 索引 | 每次构建索引只随列表版本发生，不再每次查找都线性扫描 |
| `features/memo/components/notebook-tree-row.tsx:207` | 行内 `state.notes.find(...)` 改为索引查表 | 从 `可见行 × 全量笔记`（5k 笔记 × 50 行 ≈ 25 万次比较）降到 O(1)/行 |
| `features/memo/components/memo-list.tsx:339` | 选中项查找同样改索引 | 每次 render 少一次全量扫描 |
| `features/editor/extensions/codeblock-shiki/shiki/shiki-tokenizer.worker.ts` | 增加按「语言 + 主题 + 文本」的 64 条 LRU token 缓存 | 在代码块里打字不再重新分词全部代码块，只算变更块 |
| `features/editor/components/editor-toolbar.tsx` | `updateActiveStates` 先做 9 个布尔/shallow 比较，未变化则不 setState | 每键一次工具栏重渲 |

### 第三批（目录定向查询、schema 快路径、主列表窗口化）

- **目录元数据**：先列出当前目录的可见子项，再按找到的笔记路径批量查询主键；只解码 `relative_path / created_at / favorited / icon / colors`。每批最多 300 个参数，根目录同样不读整本笔记投影。目录内符号链接继续按其 notebook 内目标回填元数据。无需新增 `parent_path` 字段或迁移 schema。
- **schema 快路径**：普通连接检查数据库当前的必需表/索引、schema 版本和 notebook 归属，正常时跳过 CREATE/INSERT；缺少对象时补建，初始化/迁移继续走原来的完整流程和跨进程修复锁。不使用进程内路径初始化缓存，数据库被替换后仍会重新检查。
- **主列表窗口化**：新增 `MemoListRows`，复用已有动态高度 virtualizer；分页仍由原 store 负责。隐藏视口未完成测量时最多挂载 16 行，正常视口按可见范围加 overscan 挂载；菜单/重命名交互中的行保活。动态列表适配器按 keys identity 缓存索引，避免滚动时反复建 Map；新增可选的可见行锚定，处理插入、删除、重排，其他调用方默认不启用。

本批验证：

- `tsc --noEmit`、`vite build`、bundle 预算通过；startup JS 1,481,666 raw / 457,367 gzip。该指标不是主列表运行时性能测量。
- 前端相关 5 个测试文件共 58 tests 通过；覆盖 5k 条列表 DOM 数量、隐藏视口、滚动范围、交互行保活、分页追加，以及插入/删除时的滚动位置。
- `flowix-core --lib`：345 tests 通过，包括新增的定向元数据查询、分批参数、无关字段损坏隔离、写锁下打开 schema 快路径、缺表补建、数据库替换和错误版本/归属检查。
- `cargo check -p flowix-desktop`：通过（已有 warnings）。
- 桌面目录回填定向测试已添加，但 `flowix-desktop --lib` 测试目标被既有 `commands/collection.rs` 测试夹具缺少 `CollectionType::WorkDocuments` match 分支阻断，无法执行；尚未做桌面窗口人工交互验收。

本批仍保留：目录全量 readdir + 排序、索引每次建立连接、watcher 全文 hash 校验、编辑器插件全文扫描、保存链路、媒体库 masonry 窗口化和启动依赖拆分。

### 第四批（编辑器装饰与 inline atom 维护局部更新）

- **变更范围统一计算**：新增 `shared/textblock-ranges.ts`，把每个 step 的范围映射到最终文档，再扩大到完整文本块与必要边界邻居，合并重叠范围。支持多 step / 多 transaction、删除、分段合并，以及 StepMap 为空的 mark/attribute 修改；无法定位范围的自定义 step 安全回退全文路径。
- **tag**：沿用原有匹配规则，以文本块为单位解析；普通输入先映射旧装饰，仅移除并重建受影响块的装饰。初始化与整篇替换继续处理整篇内容，单个超长段落仍需要扫描整个段落。
- **noteReference / fileAttachment**：共用 `inline-atom-maintenance.ts` 的光标装饰与 hard break 清理规则，普通变更只访问受影响的文本块。两个节点仍可各自独立注册，避免与主编辑器或 composer 的扩展列表耦合；onCreate 保留一次完整旧内容清理。
- **光标位置正确性**：未修改块的 widget DOM 会跨位置映射复用，因此 StableCaret 改为读取 ProseMirror 的实时 getPos，避免文档前方编辑后读取到过期的固定位置。位置 getter 通过 WeakMap 关联 DOM，不额外保留已卸载节点。

本批验证：

- 最终定向 6 个测试文件共 51 tests 通过；覆盖 5k 段落的局部扫描、多步骤映射、代码标记/块类型变更、分段合并、composition transaction、撤销重做、粘贴后的换行清理、嵌套 inline 内容，以及 widget DOM 复用后的实时位置。
- `tsc --noEmit`、`vite build`、bundle 预算通过。startup JS 1,481,666 raw / 457,376 gzip；未做桌面人工输入延迟或系统输入法验收，composition 测试验证的是 ProseMirror transaction 行为。
- 扩大到 editor/extensions、composer 和笔记链接集成测试时，315 tests 通过、21 tests 失败；用本批修改前保存的 5 个源码文件通过独立 Vite load 配置对照，7 个失败测试文件同样出现这 21 个失败，失败用例集合完全一致，没有新增失败。既有失败涉及 frontmatter、composer 提交/命令和笔记预览导航。
- 层级检查仍有 4 条既有违规，分别位于 document-titlebar-shared、browser-column-header、global-search-command 和 workspace/model/path-move，本批未修改这些文件。

### 第二批验证结果

- `tsc --noEmit`：0 error
- 受影响的测试：`note-store` / `notebook-file-tree` / `memo-list-data-loader` / 编辑器组件，共 107 tests 全部通过
- `vite build` + `scripts/check-web-bundle.mjs`：通过（startup JS 1,481,666 raw / 457,393 gzip）
- `cargo check -p flowix-desktop`：通过

### 第二批暂缓（后续进度见第三、四批）

- **媒体库 masonry 窗口化**：列内卡片高度不定，窗口化需要测量与滚动锚定，属于结构性改造，风险高于收益。
- **气泡菜单 transaction 去重**：渲染依赖 `storedMarks` / 链式 `can()`，用 selection 签名做守卫容易产生「按钮状态不刷新」的隐蔽 bug，需要先补测试再动。
- **主列表虚拟化 / tag 插件增量装饰**：第二批暂缓；随后分别在第三批和第四批完成。


### 未达预期

**1.1 的 99 KB 收益没有出现。** 启动图 gzip 从 457,880 降到 457,273（-607 B）。ProseMirror 并不只经由 barrel 进入：构建后 `tag-mention` 共享 chunk（约 300 KB，含 tiptap）仍被 `main-window-effects` 静态引用，说明 `tag-mention-data` 与 Node view 模块被 Rollup 合并进同一 chunk。要真正移出启动图，需要在 `manualChunks` 把 tiptap 单独切块，或让 data 模块成为独立 chunk。当前改动无副作用，但收益近似为零。

**第二批结束时，6 号（索引去重复 DDL）未做；第三批已加入基于数据库实际状态的快路径。** 当时的评估： `open_note_index_connection_unchecked` 同时承担 `SCHEMA_VERSION` 校验与 legacy 迁移，而 `with_database_rebuild` 会重建 db 文件、并有跨进程 `.rebuild.lock`。用进程内 `HashSet<PathBuf>` 缓存「已初始化」，在重建路径上会跳过 DDL 导致表缺失。正确做法是引入 schema 版本快路径（`PRAGMA user_version` 或提前读 `note_index_meta.schema_version`），不属于「几行改完」，故暂缓。

### 第五批（保存去重、正文订阅下移；实现完成，行为回归待完成）

- **恢复草稿去重**：保留恢复草稿与正文保存并行保护。相同 checkpoint 在排队期间合并，成功写入后按运行时 session 缓存回执；正文、基线、路径或标题版本改变时重新保护。失败不缓存成功回执，清理已保存版本时同步失效回执。较旧请求不能覆盖同一文档的新排队版本。
- **正文队列去重**：队列执行时重新读取最新正文及 CAS 基线；前序任务已经保存相同字节时只确认对应 revision。显式 force 仍走写入路径；确认前对齐 savingRevision，避免残留旧的正在保存状态。
- **正文单一来源**：移除 DocumentContainerState 中的 fullContent / charCount / tokenCount，以及 autosave 的重复正文状态更新。DocumentContentBoundary 直接订阅共享 buffer，合并结果仍同步送达编辑器；容器仅在编辑器尚未挂载时响应正文变化，防止初始 worker 解析使用过期内容。
- **字数统计**：命令回调立即获得最新正文，展示统计在输入停顿 200ms 后计算，持续输入最多等待 1 秒；同一 buffer 的相同正文复用统计结果，活动 host 更新全局字数。此处 tokenCount 仍沿用字符数除以 4 的估算。
- **通知与元数据**：相同恢复保护状态不重复通知；文件修改时间仅在 savedRevision 前进时刷新，并忽略过期异步响应。

验证结果与限制：

- `tsc --noEmit`、`vite build`、bundle 预算通过；startup JS 1,482,723 raw / 457,675 gzip。构建仍提示存在大 chunk；未测量真实输入延迟或磁盘写入次数。
- 首轮运行保存链路相关 5 个回归文件为 38 通过 / 3 失败。修复并隔离测试 session 后，同一组文件 41 项全部通过。恢复草稿保护失败且显示路径尚未登记时，改为回退传入路径继续排程保存；关闭握手在最终保护前重新捕获正文，并仅在存在标题草稿时要求标题保护。容器测试改为验证由 `onContentStateChange` 提供的加载状态，不再要求同时渲染容器的备用 spinner。
- `document-persistence.test.ts` 加入用例后清理，避免先前冲突 session 污染全局关闭握手测试。用户已完成界面检查。保存去重快捷路径和字数统计 debounce 的单独边界测试仍未新增；真实输入延迟和磁盘写入次数也未测量。

### 第六批（启动并行化、代码块缓存与局部序列化）

- **启动并行化**：原生笔记本 ID 查询与 notebook 列表加载并发启动，shell 仍等两者完成后再选择 notebook。消除了无依赖的串行 IPC 等待。
- **Shiki 按打开文档复用 token**：输入空闲 150ms 后才排队重算；变化时只把未缓存的代码块发给 worker，当前文档未变化的块复用 token。缓存随当前文档裁剪，超过 64 个代码块也不会因 worker LRU 顺序而反复分词。装饰范围仍需按全部代码块重建，主线程收集代码块仍为 O(代码块数)。
- **Markdown 序列化结构共享**：规范化只复制需要转换的粗体文本节点及其祖先；无变化的子树继续复用 `getJSON()` 节点，不再无条件复制整棵树。
- **折叠标签 DOM**：折叠时保留子树行 100ms 以完成 80ms 的 CSS 动画，动画结束后卸载隐藏行；展开时立即重新挂载。
- **媒体库 masonry 窗口化**：按列使用动态高度 virtualizer，只挂载视口附近卡片；滚动容器顶部偏移纳入虚拟坐标，卡片实测高度更新列位置，保留当前分列顺序和预览 IntersectionObserver。加入 1000 项数据下限制挂载卡片数量的组件测试。没有做桌面真实图片加载与滚动锚定的人工验收。
- **目录页排序**：先在枚举期间应用 cursor 与类型过滤，再用 `select_nth_unstable_by` 保留前 `limit + 1` 条并排序。仍需完整 `readdir` 和逐文件 metadata，所以只降低排序成本，没有实现真正的目录快照分页。
- **Watcher 事件合并**：serial worker 在 10ms 窗口里按 notebook/root/path 合并 Create/Modify；若一组里有 Create，则合并结果保留 Create 语义。rename、目录和其他事件会打断合并，避免跨路径重基准。事件窗口之外的文件仍要等稳定并读取全文 revision/hash。
- **索引查询少开一次连接**：`read_note_entries`、`read_note_tree_metadata_for_paths`、`read_note_page` 现在在同一连接上检查 ready 状态并读取结果；不再先开连接检查、再为查询开第二个连接。其他读取与写入路径仍按调用创建连接。
- **桌面测试夹具**：补齐 `CollectionType::WorkDocuments` 的测试匹配分支，使 desktop lib 定向用例可以编译运行。

验证结果：`tsc --noEmit` 通过；相关前端测试 5 个文件、41 项通过；`vite build` 与 bundle 预算通过，startup JS 1,482,810 raw / 457,679 gzip；`cargo check -p flowix-desktop` 通过；desktop 目录分页测试 2 项和 watcher 合并测试 2 项通过；`flowix-core --lib` 最终 345 项通过。完整 core 首次运行有 1 项并发 SQLite 测试报 `database is locked`，隔离重跑通过，随后全套重跑通过。构建仍报告既有的 CSS `@import` 顺序、循环 chunk 和大 chunk 警告；本批未做真实媒体滚动、启动和输入延迟 profiling。

### 第七批（置顶分页、启动状态等待与气泡菜单去重）

- **置顶笔记分页**：置顶区每页展示 100 条，进入后只请求第一页；“下一页”按需加载，“上一页”在已访问页之间切换。不会截断收藏，也不会随着翻页把前后页同时留在 DOM；已访问页面只保留数据缓存。
- **启动状态长轮询**：前端移除每 250ms 一次的 `get_startup_status` 调用，改为先取快照，再等待后端 `Condvar` 状态变化，10 秒超时用于恢复连接后的快照同步。等待以旧快照做比较，不会漏掉快照与等待调用之间发生的状态变化。
- **气泡菜单事务比较**：编辑器 transaction 仍计算当前格式和 `can()` 状态，但只有所选文本、格式激活态、按钮启用态或链接地址变化时才触发 React 更新；selection 消失时仍关闭高亮面板。

验证：`npm run build`（含 `tsc`、`vite build` 和 bundle 预算）通过；startup JS 为 1,482,877 raw / 457,712 gzip。置顶分页与气泡菜单 2 个测试文件、7 项通过；置顶分页 hook 测试覆盖只取第一页、按需取下一页及返回缓存页；`flowix-desktop` 启动状态长轮询定向用例通过。构建仍提示 CSS `@import` 顺序、循环 chunk 和大 chunk；尚未做真实启动耗时、长笔记输入或多收藏滚动 profiling。

### 第八批（目录候选内存、watcher 正文快照与启动图复核）

- **目录分页候选有界**：每扫描到约两页候选就用 `select_nth_unstable_by` 保留前 `limit + 1` 项，再继续枚举。常驻候选内存从随目录文件数增长改为 O(page size)，并保持与全量排序分页相同的结果。资源类型筛选在读取 metadata 前执行，可跳过不匹配文件的 stat；目录仍需完整 `readdir`，因此这不是减少 I/O 的真正分页。
- **Watcher 复用稳定正文快照**：Markdown 稳定性检查读到的 UTF-8 正文同时用于索引刷新和云同步指纹，避免同一事件重复读取正文。快照只在单个事件处理中传递；rename、删除、资源文件和无效 UTF-8 继续走原路径。
- **应用保存复用正文**：原子写入确认成功后，把刚写入的正文直接传给索引刷新，不再立即从磁盘读回同一正文做 hash 与解析；冲突路径仍返回磁盘版本。
- **启动依赖图**：绕过扩展 barrel 后重新测量，启动 JS 静态闭包为 1,180,859 raw / 363,418 gzip，较初始基线减少 94,462 B gzip。入口 CSS 仍为 452,174 raw / 64,922 gzip。

验证：目录分页 3 tests、watcher manager 10 tests、note index 20 tests、保存回归 1 test 通过；`cargo check -p flowix-desktop` 与 `npm run build`（含 TypeScript 和 bundle 预算）通过。`git diff --check` 通过。相关大文件的 `rustfmt --check` 会要求大范围格式调整；未整文件格式化，以免引入无关重排。未做运行时 profiling。

## 9. 当前仍然确认存在的问题（第八批后）

以下结论来自静态代码路径；除非注明，没有运行时 profiling 数字。优先级表示后续处理建议，不代表已测出用户侧毫秒数。

1. **普通目录分页仍全目录工作（P1）**：每页仍完整 `readdir`；未筛选时会读取每个文件的 metadata，启用类型筛选时只读取匹配项。候选内存和排序已限制在 O(page size)，剩下的成本是目录扫描与必要的 stat；只有性能采样证明值得时，再考虑目录快照或索引，并明确 watcher 丢事件后的失效策略。
2. **SQLite 其他路径仍逐次开连接（P2）**：常见列表查询在同一连接上检查 ready 并读结果，当前 schema 的连接快路径也跳过重复 DDL。其他读写调用仍每次 open；简单的连接池会引入锁、生命周期和重建数据库的复杂性，应先用 profiling 证明连接创建是热点。
3. **首屏 CSS 与语言文案（P1/P2）**：编辑器、表格、媒体库等样式仍通过入口 CSS 一并加载；`zh-CN` 消息仍 eager。优先按 surface 拆 CSS，并把首屏真正需要的文案保留为小型启动资源；避免一次性拆分所有消息文件造成维护负担。
4. **拖拽定位每帧几何查询（P2）**：block drag 仍在 rAF 手势路径反复扫描块并读取布局矩形。若要处理，应以拖动 session 为缓存边界，并在文档 transaction、滚动和 resize 时集中失效；先补交互回归测试，再考虑实现。

保存链路第五批的回归用例已通过；其真实磁盘写入次数、恢复草稿开销和输入延迟尚无运行时测量。双图标库与巨型组件仍是结构债务，当前没有量化证据将其列为已确认运行时瓶颈。
