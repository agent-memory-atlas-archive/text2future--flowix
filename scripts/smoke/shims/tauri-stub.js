// 最小 Tauri IPC 桩：让打包后的真实入口能在普通浏览器里跑到首帧。
//
// 必须在 import 任何 @tauri-apps/* 之前调用（探针用动态 import 保证顺序）。
// 只实现 v2 前端真正读到的三个内部字段：invoke / transformCallback / metadata。

let callbackId = 0;
const listeners = new Map();

const READY_STATUS = {
  phase: 'ready',
  stage: 'workspacePreparation',
  step: 'ready',
  error: null,
  progress: null,
};

function answer(command) {
  if (command.includes('startup')) return READY_STATUS;
  if (command.startsWith('plugin:event|')) return callbackId;
  if (command.includes('list') || command.includes('all')) return [];
  return null;
}

export function installTauriStub() {
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    transformCallback(callback, once = false) {
      callbackId += 1;
      const id = callbackId;
      listeners.set(id, { callback, once });
      window[`_${id}`] = (payload) => {
        callback(payload);
        if (once) delete window[`_${id}`];
      };
      return id;
    },
    unregisterCallback(id) {
      listeners.delete(id);
      delete window[`_${id}`];
    },
    convertFileSrc: (path) => path,
    async invoke(command) {
      return answer(command);
    },
  };
  // Tauri 的 CSS/主题探测会读这个标记。
  document.documentElement.dataset.tauri = 'true';
}
