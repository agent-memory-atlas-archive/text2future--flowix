// 冒烟 1：真实入口冷启动，不出现白屏。
//
// 断言"打包后能不能跑起来"，而不是业务细节：
//   1. 入口模块图加载不抛错
//   2. React 真的挂到 #root 上
//   3. 静态首屏 spinner 被移除（启动链没有卡死）
//   4. 出现了可识别的界面（启动屏或工作台），且不是错误页
//   5. 没有未捕获异常 / unhandled rejection
//
// 已知限制：探针停在启动屏（MainWindow 内部的 Suspense），没有推进到工作台。
// 原因是继续往下需要完整桩掉笔记列表 / 用户配置 / workspace load 一整套 IPC，
// 而 esbuild 探针还要额外处理 Vite 专属的 import.meta.glob（已在 run-smoke 里打桩）。
// 这条 case 守的是"白屏"这个最贵的事故形态；推进到 [data-workspace-host] 是后续项。

import { check, assert, installCrashGuard, report, sleep } from './harness.js';
import { installTauriStub } from '../shims/tauri-stub.js';

installCrashGuard();
installTauriStub();

check('root element exists', () => {
  assert(document.getElementById('root'), '#root 不存在，index.html 结构与入口不一致');
});

try {
  // desktop.tsx 自身负责 createRoot().render()。
  await import('@flowix-target-entry');
} catch (error) {
  check('entry module graph loads', () => {
    throw error;
  });
}

// 给启动链留出渲染时间；虚拟时间预算下 setTimeout 会立即推进，
// 这里用 rAF 循环等待根节点落定。
for (let frame = 0; frame < 120; frame += 1) {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (document.getElementById('root')?.childElementCount) break;
}

check('entry module graph loads', () => {
  assert(true, '');
});
check('react mounted into #root', () => {
  const root = document.getElementById('root');
  assert(root && root.childElementCount > 0, '#root 为空（白屏）');
});
check('first-paint spinner removed', () => {
  assert(!document.getElementById('app-loading'), '静态首屏 spinner 仍在，启动链可能卡住');
});
check('a known surface is painted', () => {
  const painted = document.querySelector(
    '[data-startup-screen], [data-workspace-host], [data-workspace-drop-overlay-host]',
  );
  assert(painted, '既没有启动屏也没有工作台，界面可能未渲染');
});
check('error fallback is not shown', () => {
  const text = document.body.textContent ?? '';
  assert(!/出错了|Something went wrong/.test(text), '根错误边界把整窗换成了错误页');
});

await sleep(0);
report({
  case: 'boot',
  surface: document.querySelector('[data-workspace-host]')
    ? 'workbench'
    : document.querySelector('[data-startup-screen]') ? 'startup-screen' : 'unknown',
});
