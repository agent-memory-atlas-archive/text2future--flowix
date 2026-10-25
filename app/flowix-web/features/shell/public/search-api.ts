/**
 * 全局搜索（命令面板）的公开入口。
 *
 * 它原先从 `features/shell/index.ts` 那个 barrel 转出，于是无论调用方是不是
 * 懒加载，整个命令面板都会被打进 shell 的启动 chunk。命令面板只在用户按下
 * 搜索快捷键时才需要，因此单独成入口，由 `LazyGlobalSearchCommand` 动态引入。
 */
export { GlobalSearchCommand } from '@features/shell/components/global-search-command';
