// 冒烟探针的公共外壳：在真实浏览器里收集断言结果并写回 DOM，
// 由 scripts/smoke/run-smoke.mjs 用 --dump-dom 读取。
//
// 刻意不引 Playwright / Puppeteer：与 scripts/check-agent-style-boundaries.mjs
// 保持一致——esbuild 打包 + headless Chrome + JSON 断言，零新增依赖。

const checks = [];
const startedAt = performance.now();

export function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${expected}, got ${actual})`);
}

/** 等真实时间（虚拟时间预算下也不会卡死主线程）。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function report(extra = {}) {
  const payload = {
    ok: checks.every((entry) => entry.ok),
    failed: checks.filter((entry) => !entry.ok).length,
    checks,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...extra,
  };
  const node = document.getElementById('smoke-result');
  if (node) node.textContent = JSON.stringify(payload);
  document.documentElement.setAttribute('data-smoke-done', 'true');
}

/** 兜住探针自身的意外异常：否则页面上只会留一个空结果。 */
export function installCrashGuard() {
  window.addEventListener('error', (event) => {
    checks.push({ name: 'uncaught error', ok: false, error: String(event.error ?? event.message) });
  });
  window.addEventListener('unhandledrejection', (event) => {
    checks.push({ name: 'unhandled rejection', ok: false, error: String(event.reason) });
  });
}
