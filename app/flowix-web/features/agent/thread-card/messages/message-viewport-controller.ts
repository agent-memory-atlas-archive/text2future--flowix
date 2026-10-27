import { traceMessageViewport } from "./message-viewport-diagnostics";

export interface ConversationMessageStateSnapshot {
  loadingMore: boolean;
  hasMoreHistory: boolean;
}

export interface MessageViewportControllerOptions {
  body: HTMLElement;
  bottomFollowThresholdPx: number;
  topHistoryLoadThresholdPx: number;
  scrollDeltaEpsilonPx: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  isCollapsed: () => boolean;
  isFullscreen: () => boolean;
  getRuntimeThreadId: () => string | null;
  getConversationMessageState: () => ConversationMessageStateSnapshot | null;
  loadMoreMessages: (threadId: string) => void;
}

export interface MessageRenderScrollState {
  previousScrollTop: number;
  shouldFollowStreaming: boolean;
}

export interface MessageRenderScrollOptions extends MessageRenderScrollState {
  isLoading: boolean;
}

export class MessageViewportController {
  private readonly body: HTMLElement;
  private readonly bottomFollowThresholdPx: number;
  private readonly topHistoryLoadThresholdPx: number;
  private readonly scrollDeltaEpsilonPx: number;
  private readonly onAtBottomChange?: (atBottom: boolean) => void;
  private readonly isCollapsed: () => boolean;
  private readonly isFullscreen: () => boolean;
  private readonly getRuntimeThreadId: () => string | null;
  private readonly getConversationMessageState: () => ConversationMessageStateSnapshot | null;
  private readonly loadMoreMessages: (threadId: string) => void;

  private resizeObserver: ResizeObserver | null = null;
  private contentObserver: MutationObserver | null = null;

  private prevCollapsed = false;
  private shouldFollowBottom = true;
  private userDetachedFromBottom = false;

  constructor(options: MessageViewportControllerOptions) {
    this.body = options.body;
    this.bottomFollowThresholdPx = options.bottomFollowThresholdPx;
    this.topHistoryLoadThresholdPx = options.topHistoryLoadThresholdPx;
    this.scrollDeltaEpsilonPx = options.scrollDeltaEpsilonPx;
    this.onAtBottomChange = options.onAtBottomChange;
    this.isCollapsed = options.isCollapsed;
    this.isFullscreen = options.isFullscreen;
    this.getRuntimeThreadId = options.getRuntimeThreadId;
    this.getConversationMessageState = options.getConversationMessageState;
    this.loadMoreMessages = options.loadMoreMessages;
    this.notifyAtBottom();
    // Layout can reach the bottom without a scroll event (viewport expansion,
    // folded tool output, or asynchronously loaded message content).
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.notifyAtBottom());
      this.observeContentSize();
      this.contentObserver = new MutationObserver(() => this.observeContentSize());
      this.contentObserver.observe(this.body, { childList: true });
    }
  }

  private observeContentSize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(this.body);
    for (const child of this.body.children) {
      this.resizeObserver?.observe(child);
    }
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.contentObserver?.disconnect();
  }

  handleScroll(): void {
    const bottomDistance = this.getBottomDistance();
    const atBottom = bottomDistance <= this.scrollDeltaEpsilonPx;
    if (this.userDetachedFromBottom) {
      // Keep an explicit upward gesture detached even if the first scroll
      // event arrives before scrollTop has moved outside the follow margin.
      // Only reaching the actual bottom re-arms automatic following.
      if (atBottom) {
        this.userDetachedFromBottom = false;
        this.shouldFollowBottom = true;
      } else {
        this.shouldFollowBottom = false;
      }
    } else {
      this.shouldFollowBottom = bottomDistance <= this.bottomFollowThresholdPx;
    }
    this.onAtBottomChange?.(atBottom);
    this.requestMoreHistoryIfNeeded();
  }

  /**
   * Records explicit upward scrolling before the browser dispatches the
   * resulting scroll event. This is intentionally separate from
   * handleScroll(): scroll events can be caused by our own scrollTop writes,
   * while a wheel-up event is unambiguously user intent.
   */
  handleUserScrollIntent(deltaY: number): void {
    if (deltaY < 0) {
      this.userDetachedFromBottom = true;
      this.shouldFollowBottom = false;
    }
  }

  captureRenderScrollState(): MessageRenderScrollState {
    // 流式跟随态(shouldFollowBottom=true)下 previousScrollTop 与
    // wasNearBottom 都不会被消费 ── applyAfterRender 走 scrollToBottom 而非
    // preserveScrollTop。跳过这两次 layout 读取, 避免流式期间每帧触发同步
    // reflow(body.scrollTop / scrollHeight 读取会强制全 body layout)。
    if (this.shouldFollowBottom) {
      return { previousScrollTop: 0, shouldFollowStreaming: true };
    }
    return {
      previousScrollTop: this.body.scrollTop,
      // This is the latched follow decision, not a fresh distance check.
      // A user gesture may have detached us while the viewport is still
      // inside the bottom margin.
      shouldFollowStreaming: this.shouldFollowBottom,
    };
  }

  resetForHiddenMessages(): void {
    this.userDetachedFromBottom = false;
    this.shouldFollowBottom = true;
    this.notifyAtBottom();
  }

  resetForEmptyMessages(): void {
    this.userDetachedFromBottom = false;
    this.shouldFollowBottom = true;
    this.notifyAtBottom();
  }

  applyAfterRender(options: MessageRenderScrollOptions): void {
    if (this.isCollapsed()) {
      this.prevCollapsed = this.isCollapsed();
      this.notifyAtBottom();
      return;
    }

    if (options.isLoading) {
      if (options.shouldFollowStreaming) {
        this.scrollToBottom();
      } else {
        this.preserveScrollTop(options.previousScrollTop);
      }
    } else if (this.prevCollapsed) {
      this.body.scrollTop = 0;
      const bottomDistance = this.getBottomDistance();
      this.shouldFollowBottom = bottomDistance <= this.bottomFollowThresholdPx;
      this.onAtBottomChange?.(bottomDistance <= this.scrollDeltaEpsilonPx);
    } else if (options.shouldFollowStreaming) {
      // Keep following only when the user was already following the bottom.
      // If they scrolled up while the response was streaming, preserve that
      // reading position when the run-end render finalizes the last message.
      this.scrollToBottom();
    } else {
      this.preserveScrollTop(options.previousScrollTop);
    }

    this.prevCollapsed = this.isCollapsed();
  }

  scrollToBottom(forceFollow = true): void {
    // 写 scrollHeight(浏览器 clamp 到 scrollHeight - clientHeight = 底部)。
    // 注意: 不能用 Number.MAX_SAFE_INTEGER 依赖浏览器 clamp ── WebKit 的
    // 滚动内部精度(LayoutUnit)无法表示 2^53 那么大的值, 大概率被截断成 0,
    // 反而把列表留在顶部(每次 DOM 重建后 scrollTop 被重置为 0, scrollToBottom
    // 又没真正生效)。读 scrollHeight 确实触发一次 layout, 但这一帧本来就要
    // 因 innerHTML 写入而 layout, 不额外增加 thrashing; 真正的 reflow 收益在
    // captureRenderScrollState 跟随态跳过两次 layout 读取。
    this.body.scrollTop = this.body.scrollHeight;
    if (forceFollow) {
      this.userDetachedFromBottom = false;
      this.shouldFollowBottom = true;
    }
    this.onAtBottomChange?.(true);
  }

  scrollToBottomSmooth(): void {
    this.body.scrollTo({ top: this.body.scrollHeight, behavior: "smooth" });
  }

  private getBottomDistance(): number {
    return Math.max(
      0,
      this.body.scrollHeight - this.body.clientHeight - this.body.scrollTop,
    );
  }

  private notifyAtBottom(): void {
    this.onAtBottomChange?.(this.getBottomDistance() <= this.scrollDeltaEpsilonPx);
  }

  private preserveScrollTop(scrollTop: number): void {
    // Rewriting the same offset can interrupt native momentum scrolling.
    if (Math.abs(this.body.scrollTop - scrollTop) > this.scrollDeltaEpsilonPx) {
      this.body.scrollTop = scrollTop;
    }
    const bottomDistance = this.getBottomDistance();
    this.shouldFollowBottom = this.userDetachedFromBottom
      ? false
      : bottomDistance <= this.bottomFollowThresholdPx;
    this.onAtBottomChange?.(bottomDistance <= this.scrollDeltaEpsilonPx);
  }

  private requestMoreHistoryIfNeeded(): void {
    if (this.isCollapsed() && !this.isFullscreen()) return;
    // Keep one viewport of history ahead of the reader instead of waiting
    // until the last few pixels. The Store coalesces concurrent page reads.
    const threshold = Math.max(this.topHistoryLoadThresholdPx, this.body.clientHeight);
    if (this.body.scrollTop > threshold) return;

    const threadId = this.getRuntimeThreadId();
    if (!threadId) return;

    const state = this.getConversationMessageState();
    if (
      !state ||
      state.loadingMore ||
      !state.hasMoreHistory
    ) {
      return;
    }

    traceMessageViewport(this.body);
    this.loadMoreMessages(threadId);
  }
}
