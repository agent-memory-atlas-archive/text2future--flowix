import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ flush: vi.fn(), invoke: vi.fn(), destroy: vi.fn(), close: vi.fn(), subscribe: vi.fn(), error: vi.fn() }));
vi.mock('@platform/tauri/core', () => ({ invoke: mocks.invoke }));
vi.mock('@platform/tauri/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.close, destroy: mocks.destroy }) }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: mocks.subscribe }));
vi.mock('@platform/tauri/runtime', () => ({ isTauriDesktopRuntime: () => true }));
vi.mock('@/lib/i18n', () => ({ translate: (_language: string, key: string) => key }));
vi.mock('@features/preferences/public/runtime-api', () => ({ getCurrentAppLanguage: () => 'en-US' }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
vi.mock('./document-session-service', () => ({ flushAllDocumentSessions: mocks.flush }));
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function install() { const module = await import('./document-shutdown'); module.installDocumentShutdown(); await tick(); return module; }
describe('desktop durability handshake', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.flush.mockResolvedValue(true); mocks.invoke.mockResolvedValue(true); mocks.destroy.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(() => {}); document.body.inert = false;
  });
  it('installs once and awaits slow persistence while leaving the page interactive', async () => {
    let finish!: (value: boolean) => void;
    mocks.flush.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const module = await install(); module.installDocumentShutdown();
    const event = { preventDefault: vi.fn() }; const closing = mocks.close.mock.calls[0][0](event); await tick();
    expect(event.preventDefault).toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).not.toHaveBeenCalled(); expect(document.body.inert).toBe(false);
    finish(true); await closing;
    expect(mocks.flush).toHaveBeenCalledTimes(2); expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it('keeps the window open when neither file nor recovery is durable', async () => {
    mocks.flush.mockResolvedValue(false); await install();
    await mocks.close.mock.calls[0][0]({ preventDefault: vi.fn() });
    expect(mocks.destroy).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalled();
    expect(document.body.inert).toBe(false);
  });
  it('restores interaction when another window cancels global exit', async () => {
    await install();
    const callback = (name: string) => mocks.subscribe.mock.calls.find(([event]) => event === name)![1];
    callback('document:prepare-exit')(7); await tick();
    expect(document.body.inert).toBe(true);
    callback('document:exit-cancelled')(7);
    expect(document.body.inert).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_shutdown', { request: 7, ready: true });
  });
  it('ignores a late completion after an exit request was cancelled', async () => {
    let finish!: (value: boolean) => void;
    mocks.flush.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await install();
    const callback = (name: string) => mocks.subscribe.mock.calls.find(([event]) => event === name)![1];
    callback('document:prepare-exit')(8); callback('document:exit-cancelled')(8);
    finish(true); await tick();
    expect(document.body.inert).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'finish_document_shutdown')).toBe(false);
  });
});
