import { useEffect } from 'react';
import { useShortcutsContext } from './shortcuts-provider';
import type { Scope } from './types';

/**
 * 声明当前组件子树需要某个 scope — mount 时 push 到 Provider 的栈, unmount 时 pop。
 *
 * 用法 (编辑器 mount 时):
 *
 *   function TiptapEditor() {
 *     useShortcutScope('editor');
 *     return <EditorContent ... />;
 *   }
 *
 * 多次调用会得到多个 scope 同进栈, 弹栈顺序与 push 严格对应 (LIFO)。
 * 这样嵌套的编辑器也能正确表达 "我在 editor 上下文里"。
 */
export function useShortcutScope(scope: Scope): void {
  const ctx = useShortcutsContext();
  // 不在 Provider 内 ── 静默 no-op, 让 slash menu 这种 imperative root
  // 挂载的组件也能挂上而不会炸整条 layout effect。
  //
  // hook 必须无条件调用：把 ctx 判空放进 effect 内部。原先的 early return 会让
  // ctx 在两次渲染间变化时改变 hook 顺序（Provider 外→内切换时会抛
  // "Rendered more hooks than during the previous render"）。
  useEffect(() => {
    if (!ctx) return;
    const pop = ctx.pushScope(scope);
    return pop;
  }, [ctx, scope]);
}
