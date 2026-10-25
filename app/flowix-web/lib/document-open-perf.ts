import { createLogger } from '@/lib/logger';
const logger = createLogger('lib/document-open-perf');
/** Observation-only timing trace for one document-open transaction. */

interface OpenDocumentTrace {
  startedAt: number;
  lastAt: number;
}

const traces = new Map<number, OpenDocumentTrace>();
const TRACE_RETENTION_MS = 30_000;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function writeTrace(
  transitionId: number,
  phase: string,
  trace: OpenDocumentTrace,
  meta?: Record<string, unknown>,
): void {
  const timestamp = now();
  logger.info('[perf:open-doc-trace]', {
    transitionId,
    phase,
    elapsedMs: round(timestamp - trace.startedAt),
    deltaMs: round(timestamp - trace.lastAt),
    ...meta,
  });
  trace.lastAt = timestamp;
}

export function startDocumentOpenTrace(
  transitionId: number | null | undefined,
  meta?: Record<string, unknown>,
): void {
  if (transitionId === null || transitionId === undefined) return;

  const timestamp = now();
  const trace = { startedAt: timestamp, lastAt: timestamp };
  traces.set(transitionId, trace);
  writeTrace(transitionId, 'navigation:start', trace, meta);

  window.setTimeout(() => {
    if (traces.get(transitionId) === trace) traces.delete(transitionId);
  }, TRACE_RETENTION_MS);
}

export function markDocumentOpenTrace(
  transitionId: number | null | undefined,
  phase: string,
  meta?: Record<string, unknown>,
): void {
  if (transitionId === null || transitionId === undefined) return;

  const trace = traces.get(transitionId);
  if (!trace) {
    const timestamp = now();
    const fallback = { startedAt: timestamp, lastAt: timestamp };
    traces.set(transitionId, fallback);
    writeTrace(transitionId, phase, fallback, { traceStartedLate: true, ...meta });
    return;
  }

  writeTrace(transitionId, phase, trace, meta);
}
