import { createLogger } from '@/lib/logger';
import { invoke } from '@tauri-apps/api/core';

type Receipt<T> = { state: 'pending' | 'missing' } | { state: 'complete'; result: T } | { state: 'failed'; error: string };
const log = createLogger('document:ipc');
const RECEIPT_PROBE_MS = 1_500;

/** An IPC timeout starts receipt queries, never another filesystem mutation. */
export async function invokeDocumentMutation<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const operationId = crypto.randomUUID();
  const started = performance.now();
  let settled = false;
  let stopped = false;
  let requestFailed = false;
  let requestError: unknown;
  let startProbe!: () => void;
  const probe = new Promise<void>(resolve => { startProbe = resolve; });
  const timer = setTimeout(startProbe, RECEIPT_PROBE_MS);
  const request = invoke<T>(command, { ...args, operationId }).catch(error => {
    requestFailed = true; requestError = error; startProbe();
    // The receipt decides whether this was an I/O failure or a lost response.
    return new Promise<T>(() => {});
  });
  const receipt = (async (): Promise<T> => {
    await probe;
    while (!stopped) {
      let value: Receipt<T> | null = null;
      try { value = await invoke<Receipt<T>>('document_operation_status', { operationId }); }
      catch { /* Transport unavailable: keep exclusive ownership and probe again. */ }
      if (stopped) break;
      if (value?.state === 'complete') return value.result;
      if (value?.state === 'failed') throw new Error(value.error);
      // A pending invoke may not have reached the backend yet. Missing alone
      // is not proof that it is safe to release ownership and submit a retry.
      if (value?.state === 'missing' && requestFailed) throw requestError;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return new Promise<T>(() => {});
  })();
  try {
    const result = await Promise.race([request, receipt]);
    settled = true;
    return result;
  } catch (error) {
    settled = true;
    throw error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    startProbe(); // Release the dormant probe closure on the normal fast path.
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 100) log.info('slow mutation', { operationId, command, elapsedMs });
    if (settled) void invoke('acknowledge_document_operation', { operationId }).catch(() => undefined);
  }
}
