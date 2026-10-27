import { describe, expect, it, vi } from "vitest";
import { MessageViewportController } from "@features/agent/thread-card/messages/message-viewport-controller";

function createController(onAtBottomChange?: (atBottom: boolean) => void) {
  const body = document.createElement("div");
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1000 },
  });

  return {
    body,
    controller: new MessageViewportController({
      body,
      onAtBottomChange,
      bottomFollowThresholdPx: 64,
      topHistoryLoadThresholdPx: 64,
      scrollDeltaEpsilonPx: 2,
      isCollapsed: () => false,
      isFullscreen: () => false,
      getRuntimeThreadId: () => null,
      getConversationMessageState: () => null,
      loadMoreMessages: vi.fn(),
    }),
  };
}

describe("MessageViewportController run-end scroll behavior", () => {
  it("preserves an upward reading position when streaming ends", () => {
    const { body, controller } = createController();
    body.scrollTop = 300;
    controller.handleScroll();

    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: false, ...scrollState });

    expect(body.scrollTop).toBe(300);
  });

  it("continues following the bottom when the user was already there", () => {
    const { body, controller } = createController();
    body.scrollTop = 600;
    controller.handleScroll();

    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: false, ...scrollState });

    expect(body.scrollTop).toBe(1000);
  });

  it("detaches from the bottom on a small upward wheel gesture", () => {
    const { body, controller } = createController();
    body.scrollTop = 600;
    controller.handleScroll();

    controller.handleUserScrollIntent(-12);
    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: true, ...scrollState });

    expect(body.scrollTop).toBe(600);
  });
});


it("does not restore a request-time position after a failed history load", () => {
  const body = document.createElement("div");
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  const loadMore = vi.fn();
  const controller = new MessageViewportController({
    body, bottomFollowThresholdPx: 64, topHistoryLoadThresholdPx: 48, scrollDeltaEpsilonPx: 0.5,
    isCollapsed: () => false, isFullscreen: () => true, getRuntimeThreadId: () => "thread",
    getConversationMessageState: () => ({ loadingMore: false, hasMoreHistory: true, oldestSequence: 10 }),
    loadMoreMessages: loadMore,
  });
  body.scrollTop = 20;
  controller.handleScroll();
  expect(loadMore).toHaveBeenCalledOnce();
  // The failed request changed no rows. A later update must preserve the
  // reader's new position, rather than the position when the request began.
  body.scrollTop = 250;
  controller.handleScroll();
  controller.applyAfterRender({ isLoading: false, ...controller.captureRenderScrollState() });
  expect(body.scrollTop).toBe(250);
});

it("updates bottom visibility after layout changes without a scroll event", async () => {
  let notifyResize = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  try {
    const onAtBottomChange = vi.fn();
    const { body, controller } = createController(onAtBottomChange);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);

    // Expanding the viewport removes overflow without changing scrollTop.
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 1200 });
    notifyResize();
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);

    const list = document.createElement("div");
    body.append(list);
    await Promise.resolve();
    expect(observe).toHaveBeenCalledWith(list);

    // Content growing beyond the viewport makes the button useful again.
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1600 });
    notifyResize();
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
    body.scrollTop = 400;
    notifyResize();
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);

    controller.dispose();
    expect(disconnect).toHaveBeenCalled();
    observe.mockClear();
    body.append(document.createElement("div"));
    await Promise.resolve();
    expect(observe).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
