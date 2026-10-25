import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAgentConfig, upsertAgentConfig, type AgentConfigStore } from './save-agent-config';
import type { AgentConfig } from '@platform/tauri/client';

const config: AgentConfig = { provider: 'custom', providerId: 'route', model: 'model', apiUrl: 'https://example.com', apiKeys: {} };
function createStore() {
  return {
    set: vi.fn().mockResolvedValue(undefined), add: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ model: config }),
    list: vi.fn().mockResolvedValue([{ model: config }]),
  } satisfies AgentConfigStore;
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('saving model settings', () => {
  it.each([true, false])('keeps a committed save successful when directory refresh fails, append=%s', async (append) => {
    const store = createStore();
    store.list.mockRejectedValue(new Error('read failed'));
    const result = await saveAgentConfig(store, config, { append, refreshDirectory: true });
    expect(result).toEqual({ config, listed: null, refreshFailed: true });
    expect(append ? store.add : store.set).toHaveBeenCalledExactlyOnceWith(config);
    expect(append ? store.set : store.add).not.toHaveBeenCalled();
  });

  it('propagates a write failure and never attempts a refresh', async () => {
    const store = createStore();
    const failure = new Error('write failed');
    store.add.mockRejectedValue(failure);
    await expect(saveAgentConfig(store, config, { append: true, refreshDirectory: true })).rejects.toBe(failure);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('uses normalized persisted configuration after a successful refresh', async () => {
    const store = createStore();
    const persisted = { ...config, credentialConfigured: true };
    store.list.mockResolvedValue([{ model: persisted }]);
    expect(await saveAgentConfig(store, config, { append: true, refreshDirectory: true }))
      .toEqual({ config: persisted, listed: [persisted], refreshFailed: false });
  });

  it('does not report a committed append as failed when the fallback read fails', async () => {
    const store = createStore();
    store.list.mockResolvedValue([]);
    store.get.mockRejectedValue(new Error('read failed'));
    const result = await saveAgentConfig(store, config, { append: true, refreshDirectory: true });
    expect(result.refreshFailed).toBe(true);
    expect(result.config).toBe(config);
    expect(store.add).toHaveBeenCalledTimes(1);
  });

  it('uses set when append is unavailable and skips optional directory reads', async () => {
    const store = createStore();
    const { add: _add, ...withoutAppend } = store;
    const result = await saveAgentConfig(withoutAppend, config, { append: true, refreshDirectory: false });
    expect(result.refreshFailed).toBe(false);
    expect(store.set).toHaveBeenCalledExactlyOnceWith(config);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('updates the local directory without duplicating the saved route', () => {
    const other = { ...config, providerId: 'other' };
    expect(upsertAgentConfig([other], config)).toEqual([other, config]);
    expect(upsertAgentConfig([other, { ...config, model: 'old' }], config)).toEqual([other, config]);
  });
});
