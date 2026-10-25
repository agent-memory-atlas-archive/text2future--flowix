/**
 * 集合标题组件的公开入口。
 *
 * table 与 work_documents 两个视图都渲染 `CollectionTitle`；它属于 collection
 * 的展示层，调用方不该 import `features/collection/collection-title` 这种私有
 * 路径（会触犯跨模块 public 边界门禁）。
 */
export { CollectionTitle } from '@features/collection/collection-title';
