import { describe, expect, it, vi } from 'vitest';
import { EventDispatcher } from './event-dispatcher';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

describe('event subscriber isolation', () => {
  it.each(['filter', 'handler'] as const)('continues delivery after a %s throws', (stage) => {
    const dispatcher = new EventDispatcher<string>();
    const fail = () => { throw new Error('broken consumer'); };
    const receive = vi.fn();
    dispatcher.subscribe(stage === 'handler' ? fail : vi.fn(), stage === 'filter' ? fail : undefined);
    dispatcher.subscribe(receive);
    expect(() => dispatcher.dispatch('updated')).not.toThrow();
    expect(receive).toHaveBeenCalledWith('updated');
  });

  it('keeps filtered consumers out of delivery without suppressing other consumers', () => {
    const dispatcher = new EventDispatcher<string>();
    const filtered = vi.fn();
    const receive = vi.fn();
    dispatcher.subscribe(filtered, () => false);
    dispatcher.subscribe(receive);
    dispatcher.dispatch('updated');
    expect(filtered).not.toHaveBeenCalled();
    expect(receive).toHaveBeenCalledOnce();
  });
});
