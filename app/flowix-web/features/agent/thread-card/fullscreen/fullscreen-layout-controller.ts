import type { ScrollSnapshot } from "@features/agent/thread-card/agent-thread-card-dom";
import {
  adjustEditorScrollToCardTop,
  captureAgentThreadCardScrollSnapshot,
  getAgentThreadCardEditorScrollContainer,
  getFullscreenExitFallbackTop,
  restoreAgentThreadCardScrollSnapshotAfterFocusChange,
} from "@features/agent/thread-card/fullscreen/fullscreen-scroll";

export interface FullscreenLayoutControllerOptions {
  dom: HTMLElement;
  isFullscreen: () => boolean;
  isDestroyed: () => boolean;
  minExitTopPx: number;
  maxExitTopPx: number;
  exitTopRatio: number;
  scrollDeltaEpsilonPx: number;
}

export class FullscreenLayoutController {
  private readonly dom: HTMLElement;
  private readonly isFullscreen: () => boolean;
  private readonly isDestroyed: () => boolean;
  private readonly minExitTopPx: number;
  private readonly maxExitTopPx: number;
  private readonly exitTopRatio: number;
  private readonly scrollDeltaEpsilonPx: number;
  private fullscreenContainer: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private boundsSyncFrame: number | null = null;
  private lastFullscreenBounds: string | null = null;
  private readonly syncFullscreenBounds = (): void => {
    const container = this.fullscreenContainer;
    if (!container || !this.isFullscreen()) return;

    const rect = container.getBoundingClientRect();
    const boundsKey = `${rect.top}:${rect.left}:${rect.width}:${rect.height}`;
    if (boundsKey === this.lastFullscreenBounds) return;
    this.lastFullscreenBounds = boundsKey;
    this.dom.style.setProperty("--atc-fullscreen-top", `${rect.top}px`);
    this.dom.style.setProperty("--atc-fullscreen-left", `${rect.left}px`);
    this.dom.style.setProperty("--atc-fullscreen-width", `${rect.width}px`);
    this.dom.style.setProperty("--atc-fullscreen-height", `${rect.height}px`);
  };
  /**
   * Coalesces observer bursts into one layout read on the next frame.
   *
   * The card is `position: fixed` (it has to escape the editor's scroll/clip
   * ancestors), so the work column's box has to be pushed into CSS variables
   * from JS. This used to run as a permanent `requestAnimationFrame` loop for
   * as long as the card stayed fullscreen — one `getBoundingClientRect()` every
   * frame, forever, even when nothing moved, which also kept the page from ever
   * going idle.
   *
   * Every input that can actually move or resize the work column ends in a
   * layout pass and fires the `ResizeObserver` below (memo-list toggle, column
   * drag, browser-column toggle, statusbar height, window resize) or the window
   * `resize` listener. A single coalesced frame keeps the ordering the loop
   * provided — read *after* the layout pass — without polling.
   */
  private readonly scheduleBoundsSync = (): void => {
    if (this.boundsSyncFrame !== null) return;
    this.boundsSyncFrame = window.requestAnimationFrame(() => {
      this.boundsSyncFrame = null;
      this.syncFullscreenBounds();
    });
  };

  private returnAnchor: {
    scrollContainer: HTMLElement;
    topWithinContainer: number;
  } | null = null;

  constructor(options: FullscreenLayoutControllerOptions) {
    this.dom = options.dom;
    this.isFullscreen = options.isFullscreen;
    this.isDestroyed = options.isDestroyed;
    this.minExitTopPx = options.minExitTopPx;
    this.maxExitTopPx = options.maxExitTopPx;
    this.exitTopRatio = options.exitTopRatio;
    this.scrollDeltaEpsilonPx = options.scrollDeltaEpsilonPx;
  }

  enter(): void {
    const container = this.dom.closest<HTMLElement>(".document-container");
    this.fullscreenContainer = container;
    if (!container) return;

    this.syncFullscreenBounds();
    window.addEventListener("resize", this.scheduleBoundsSync);
    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(this.scheduleBoundsSync);
      this.resizeObserver.observe(container);
    }
    // One deferred pass: leaving the document flow can change the editor's
    // scrollbar (and therefore the container width) after this frame.
    this.scheduleBoundsSync();
  }

  exit(): void {
    this.stopTrackingFullscreenBounds();
    this.restoreReturnAnchor();
  }

  dispose(): void {
    this.stopTrackingFullscreenBounds();
    this.returnAnchor = null;
  }

  captureReturnAnchor(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer) {
      this.returnAnchor = null;
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    this.returnAnchor = {
      scrollContainer,
      topWithinContainer: cardRect.top - containerRect.top,
    };
  }

  captureScrollSnapshot(): ScrollSnapshot {
    return captureAgentThreadCardScrollSnapshot(this.getEditorScrollContainer());
  }

  restoreScrollSnapshotAfterFocusChange(snapshot: ScrollSnapshot): void {
    restoreAgentThreadCardScrollSnapshotAfterFocusChange(snapshot);
  }

  getEditorScrollContainer(): HTMLElement | null {
    return getAgentThreadCardEditorScrollContainer(this.dom);
  }

  private stopTrackingFullscreenBounds(): void {
    window.removeEventListener("resize", this.scheduleBoundsSync);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.boundsSyncFrame !== null) {
      window.cancelAnimationFrame(this.boundsSyncFrame);
      this.boundsSyncFrame = null;
    }
    this.fullscreenContainer = null;
    this.lastFullscreenBounds = null;
    this.dom.style.removeProperty("--atc-fullscreen-top");
    this.dom.style.removeProperty("--atc-fullscreen-left");
    this.dom.style.removeProperty("--atc-fullscreen-width");
    this.dom.style.removeProperty("--atc-fullscreen-height");
  }

  private restoreReturnAnchor(): void {
    const anchor = this.returnAnchor;
    this.returnAnchor = null;

    window.requestAnimationFrame(() => {
      if (this.isDestroyed() || this.isFullscreen()) return;
      if (!anchor || !anchor.scrollContainer.isConnected || !this.dom.isConnected) {
        this.scrollCardToExitFallbackPosition();
        return;
      }

      const scrollContainer = anchor.scrollContainer;

      const containerRect = scrollContainer.getBoundingClientRect();
      const cardRect = this.dom.getBoundingClientRect();
      this.adjustEditorScrollToCardTop(
        scrollContainer,
        cardRect.top - containerRect.top,
        anchor.topWithinContainer,
      );
    });
  }

  private scrollCardToExitFallbackPosition(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer || !scrollContainer.isConnected || !this.dom.isConnected)
      return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    const targetTop = getFullscreenExitFallbackTop({
      containerHeight: containerRect.height,
      minTopPx: this.minExitTopPx,
      maxTopPx: this.maxExitTopPx,
      topRatio: this.exitTopRatio,
    });
    this.adjustEditorScrollToCardTop(
      scrollContainer,
      cardRect.top - containerRect.top,
      targetTop,
    );
  }

  private adjustEditorScrollToCardTop(
    scrollContainer: HTMLElement,
    currentTopWithinContainer: number,
    targetTopWithinContainer: number,
  ): void {
    adjustEditorScrollToCardTop({
      scrollContainer,
      currentTopWithinContainer,
      targetTopWithinContainer,
      epsilonPx: this.scrollDeltaEpsilonPx,
    });
  }
}
