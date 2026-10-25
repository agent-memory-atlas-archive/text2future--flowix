import { createLogger } from '@/lib/logger';
const logger = createLogger('startup:stage3');
type StartupStage3Task = () => void | Promise<void>;

let admitted = false;
let resolveAdmission!: () => void;
const admission = new Promise<void>((resolve) => {
  resolveAdmission = resolve;
});
const tasks = new Map<string, Promise<void>>();

/** Release non-blocking startup work after the first workbench paint. */
export function admitStartupStage3(): void {
  if (admitted) return;
  admitted = true;
  resolveAdmission();
}

export function waitForStartupStage3(): Promise<void> {
  return admission;
}

/** Run an admitted startup task once per WebView, even if its effect remounts. */
export function runStartupStage3Task(
  taskId: string,
  task: StartupStage3Task,
): Promise<void> {
  const existing = tasks.get(taskId);
  if (existing) return existing;

  const pending = admission
    .then(task)
    .catch((error) => {
      logger.warn(`${taskId} failed`, error);
    });
  tasks.set(taskId, pending);
  return pending;
}
