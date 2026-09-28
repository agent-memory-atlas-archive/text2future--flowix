import { afterEach, expect, it, vi } from 'vitest';
import { invokeDocumentMutation } from './document-mutation';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => { vi.useRealTimers(); invoke.mockReset(); });

it('recovers a lost response without issuing the file mutation twice', async () => {
  vi.useFakeTimers(); let statusCalls = 0;
  invoke.mockImplementation(async command => {
    if (command === 'rename_memo_title') throw new Error('lost response');
    if (command === 'document_operation_status') {
      return ++statusCalls === 1 ? { state: 'pending' } : { state: 'complete', result: { path: '/new.md' } };
    }
  });
  const pending = invokeDocumentMutation('rename_memo_title', { filePath: '/old.md', title: 'new' });
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toEqual({ path: '/new.md' });
  expect(invoke.mock.calls.filter(([command]) => command === 'rename_memo_title')).toHaveLength(1);
  const operationId = invoke.mock.calls[0][1].operationId;
  expect(invoke).toHaveBeenCalledWith('acknowledge_document_operation', { operationId });
});

it('surfaces a confirmed failure and releases its receipt', async () => {
  invoke.mockImplementation(async command => {
    if (command === 'write_document') throw new Error('disk full');
    if (command === 'document_operation_status') return { state: 'failed', error: 'disk full' };
  });
  await expect(invokeDocumentMutation('write_document', {})).rejects.toThrow('disk full');
  expect(invoke).toHaveBeenCalledWith('acknowledge_document_operation', expect.any(Object));
});

it('queries a receipt when the original invoke never resolves', async () => {
  vi.useFakeTimers();
  invoke.mockImplementation(command => {
    if (command === 'rename_file') return new Promise(() => {});
    if (command === 'document_operation_status') return Promise.resolve({ state: 'complete', result: '/confirmed.md' });
    return Promise.resolve();
  });
  const pending = invokeDocumentMutation('rename_file', {});
  await vi.advanceTimersByTimeAsync(1500);
  expect(await pending).toBe('/confirmed.md');
  expect(invoke.mock.calls.filter(([command]) => command === 'rename_file')).toHaveLength(1);
});

it('keeps a late-delivered request active when its receipt is initially missing', async () => {
  vi.useFakeTimers(); let finish!: (value: string) => void;
  invoke.mockImplementation(command => {
    if (command === 'write_document') return new Promise(resolve => { finish = resolve; });
    if (command === 'document_operation_status') return Promise.resolve({ state: 'missing' });
    return Promise.resolve();
  });
  let complete = false;
  const pending = invokeDocumentMutation('write_document', {}).then(value => { complete = true; return value; });
  await vi.advanceTimersByTimeAsync(2000); expect(complete).toBe(false);
  finish('saved'); expect(await pending).toBe('saved');
  const count = invoke.mock.calls.length; await vi.advanceTimersByTimeAsync(1000);
  expect(invoke.mock.calls).toHaveLength(count);
});
