export {
  MainLayout,
  type MainLayoutBusinessController,
  type MainLayoutSystemController,
} from '@features/shell/main-layout';
// 命令面板不在这里转出：它只在用户按搜索快捷键时才需要，从 barrel 转出会
// 无条件打进 shell 的启动 chunk。懒加载入口见 public/search-api.ts。
export { NotebookDeleteDialog } from '@features/shell/components/notebook-delete-dialog';
export * from '@features/shell/hooks';
export * from '@features/shell/store';
export * from '@features/shell/public/system-api';
