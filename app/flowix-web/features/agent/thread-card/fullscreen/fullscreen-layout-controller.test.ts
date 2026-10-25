import { afterEach, describe, expect, it, vi } from "vitest";

import { FullscreenLayoutController } from "@features/agent/thread-card/fullscreen/fullscreen-layout-controller";

describe("FullscreenLayoutController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("pins the card to the visible document container bounds", () => {
    const container = document.createElement("div");
    container.className = "document-container";
    const card = document.createElement("div");
    container.appendChild(card);
    document.body.appendChild(container);

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 48,
      left: 320,
      width: 960,
      height: 720,
      right: 1280,
      bottom: 768,
      x: 320,
      y: 48,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    let fullscreen = true;
    const controller = new FullscreenLayoutController({
      dom: card,
      isFullscreen: () => fullscreen,
      isDestroyed: () => false,
      minExitTopPx: 0,
      maxExitTopPx: 0,
      exitTopRatio: 0,
      scrollDeltaEpsilonPx: 0,
    });

    controller.enter();

    expect(card.style.getPropertyValue("--atc-fullscreen-top")).toBe("48px");
    expect(card.style.getPropertyValue("--atc-fullscreen-left")).toBe("320px");
    expect(card.style.getPropertyValue("--atc-fullscreen-width")).toBe("960px");
    expect(card.style.getPropertyValue("--atc-fullscreen-height")).toBe("720px");

    fullscreen = false;
    controller.exit();
    expect(card.style.getPropertyValue("--atc-fullscreen-height")).toBe("");
  });

  it("tracks document container bounds changed by sidebar layout", () => {
    const container = document.createElement("div");
    container.className = "document-container";
    const card = document.createElement("div");
    container.appendChild(card);
    document.body.appendChild(container);

    let rect = {
      top: 48,
      left: 320,
      width: 960,
      height: 720,
      right: 1280,
      bottom: 768,
      x: 320,
      y: 48,
      toJSON: () => ({}),
    };
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => rect);

    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const controller = new FullscreenLayoutController({
      dom: card,
      isFullscreen: () => true,
      isDestroyed: () => false,
      minExitTopPx: 0,
      maxExitTopPx: 0,
      exitTopRatio: 0,
      scrollDeltaEpsilonPx: 0,
    });

    controller.enter();
    rect = { ...rect, left: 80, width: 1200, right: 1280, x: 80 };
    frames.shift()?.(performance.now());

    expect(card.style.getPropertyValue("--atc-fullscreen-left")).toBe("80px");
    expect(card.style.getPropertyValue("--atc-fullscreen-width")).toBe("1200px");
    // The sync must not schedule a follow-up frame: the old implementation kept
    // a requestAnimationFrame loop alive for the whole fullscreen session.
    expect(frames).toHaveLength(0);

    controller.dispose();
  });

  it("resyncs from ResizeObserver callbacks coalesced into a single frame", () => {
    const container = document.createElement("div");
    container.className = "document-container";
    const card = document.createElement("div");
    container.appendChild(card);
    document.body.appendChild(container);

    let rect = {
      top: 48,
      left: 320,
      width: 960,
      height: 720,
      right: 1280,
      bottom: 768,
      x: 320,
      y: 48,
      toJSON: () => ({}),
    };
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => rect);

    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    // jsdom ships no ResizeObserver. vitest's stubGlobal writes to globalThis
    // while the controller probes `"ResizeObserver" in window`, so install it on
    // both facades instead of assuming they are the same object.
    const observerCallbacks: ResizeObserverCallback[] = [];
    const originalResizeObserver = window.ResizeObserver;
    const TestResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observerCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    });

    try {
      const controller = new FullscreenLayoutController({
        dom: card,
        isFullscreen: () => true,
        isDestroyed: () => false,
        minExitTopPx: 0,
        maxExitTopPx: 0,
        exitTopRatio: 0,
        scrollDeltaEpsilonPx: 0,
      });

      controller.enter();
      expect(observerCallbacks).toHaveLength(1);
      // enter() defers exactly one sync; flush it so the coalescing assertion
      // below sees only frames requested by the observer path.
      frames.shift()?.(performance.now());
      frames.length = 0;

      rect = { ...rect, left: 80, width: 1200, right: 1280, x: 80 };
      const notify = observerCallbacks[0];
      notify([], {} as ResizeObserver);
      notify([], {} as ResizeObserver);

      expect(frames).toHaveLength(1);

      frames.shift()?.(performance.now());
      expect(card.style.getPropertyValue("--atc-fullscreen-left")).toBe("80px");
      expect(card.style.getPropertyValue("--atc-fullscreen-width")).toBe("1200px");

      controller.dispose();
    } finally {
      if (originalResizeObserver) window.ResizeObserver = originalResizeObserver;
      else delete (window as Window & { ResizeObserver?: unknown }).ResizeObserver;
    }
  });
});
