# 笔记图标、颜色与置顶同步

文件树与置顶列表通过 `note-metadata-service` 共享按规范化绝对路径索引的元数据投影。文件树只负责目录结构和展开状态，置顶查询只负责成员、排序和分页；它们的查询结果在 IPC 读取开始时记录 checkpoint，返回后再合并到投影。不要在 React render 或 state updater 内写入投影。

## 状态和新鲜度

- `pending`：尚无已确认元数据。
- `ready`：已获取完整元数据。
- `stale`：需要刷新，继续保留上次确认值。
- `deleted`：收到删除或目录快照确认路径消失。

传输中的 `null`/缺失表示索引暂不可用，不表示用户清空。完整对象内的 `icon: null`、`colors: []` 才表示清空。删除墓碑不会被空读取复活，新查询中的完整对象可以表示重新创建。

revision 仅保证当前窗口内的观察顺序，不是服务端全局版本。查询不能覆盖开始后收到的更新或删除；强制刷新推进边界，拦截更早的未完成读取。缓存限制为 5000 项，挂载中的逐路径订阅不被淘汰。

## 事件与恢复

每个笔记本作用域共享一个原生订阅，最后一个消费者离开时释放。保存端在刷新索引后发布完整元数据；监听恢复和查询失效会标记缓存过期，刷新正在观察的路径，并通知查询消费者重新核对成员。

保存事件携带可选 `previousFavorited`，因此即使文件不在已加载的置顶页中，也能区分普通图标修改和置顶成员变化。旧事件缺少前态时保守重查，保留当前分页窗口并在页数减少时收缩。


## Observation and cache lifecycle

`observeNoteMetadata` coalesces a read when a pending/stale note is attached or reattached. A failed read retains known data and does not loop within the same attachment; reattachment or recovery can retry. Invalidation preserves deletion tombstones.

Active path reads retain their cache entries until completion, including superseded requests. Only the current request may merge its result. The 5000-entry target can be exceeded while entries are protected. Eviction advances the minimum accepted checkpoint so bulk tree/list reads cannot restore an evicted stale snapshot; under heavy cache pressure this conservatively skips some in-flight metadata merges.

## Current document header

Browser uses `useNotebookNoteIcon(filePath)` for its single current document. It consumes the same metadata observer and notebook subscription as sidebar rows; no tab request arrays, keyed icon results, or private icon cache remain. The note glyph renderer is `NotebookNoteIcon`. Main-list query results remain independent of this metadata authority.
