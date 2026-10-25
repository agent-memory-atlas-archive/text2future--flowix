import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { OverlayScrollbar, type OverlayScrollbarHandle } from './overlay-scrollbar';

it.each(['hidden', 'clip', 'auto', 'scroll'])(
  'respects overflow-x: %s when forwarding wheel events from the thumb',
  async (overflowX) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const ref = { current: null as OverlayScrollbarHandle | null };
    try {
      await act(async () => root.render(<OverlayScrollbar ref={ref}><p>Content</p></OverlayScrollbar>));
      const scroller = ref.current!.getScroller()!;
      scroller.style.overflowX = overflowX;
      Object.defineProperties(scroller, {
        clientWidth: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, value: 300 },
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 300 },
      });
      ref.current!.update({ reveal: false, schedule: false });
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 30, deltaY: 40 });
      host.querySelector('.overlay-scrollbar-thumb--vertical')!.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      expect(scroller.scrollTop).toBe(40);
      expect(scroller.scrollLeft).toBe(overflowX === 'hidden' || overflowX === 'clip' ? 0 : 30);

      // Content-originated events must remain available to native/nested scrolling.
      const contentWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 20 });
      scroller.querySelector('p')!.dispatchEvent(contentWheel);
      expect(contentWheel.defaultPrevented).toBe(false);
      expect(scroller.scrollLeft).toBe(overflowX === 'hidden' || overflowX === 'clip' ? 0 : 30);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
