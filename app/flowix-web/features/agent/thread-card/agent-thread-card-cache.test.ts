import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HistoryLoadResult } from "@features/agent/store/thread-history-slice";
import { emptyProjection, type ThreadProjection } from "@features/agent/store/session-reducer";
import { isInitialConversationHistoryLoading } from "@features/agent/components/agent-conversation-history-loading";

const agentConversationStoreMock = vi.hoisted(() => ({
  // 测试内部消息 fixture 数据载体 (历史命名); 生产代码已不读 conv-store.
  messageStates: {},
}));
// Phase 5 (2026-08-03): cache helper now reads 唯一真源 threadProjections.
// Mock 这里让 loadMessages 同步更新 threadProjections 的对应 entry, 模拟
// 真实环境会话 store 的历史投影更新行为.
const sessionStoreMock = vi.hoisted(() => ({
  bindProviderSessionId: vi.fn(),
  updateThreadHistory: vi.fn<(threadId: string, updater: (projection: ThreadProjection) => Pick<ThreadProjection, 'messages' | 'pagination'>) => void>(),
  loadMessages: vi.fn(
    async (_typeKey: string, _threadId: string): Promise<HistoryLoadResult> => "ready",
  ),
  threadProjections: {} as Record<
    string,
    { messages: unknown[]; pagination: object; runs: object }
  >,
  sessionMeta: {
    externalSessionResolutions: {},
    activeAgentTypeKey: "dsh",
    threadTypes: {},
    threadLists: {},
    currentThreadTitles: {},
    activeThreadIds: {},
    lastRunningRunsReconciledAt: null,
    settings: {
      agentPermissionMode: "danger-full-access",
      agentCodexModel: "inherit",
      agentCodexReasoningEffort: "medium",
    },
  },
}));

vi.mock("@features/agent/store/agent-session-test-facade", () => ({
  useAgentConversationStore: {
    getState: () => agentConversationStoreMock,
  },
}));

vi.mock("@features/agent/store/agent-session-test-facade", () => ({
  useChatStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
  },
}));

vi.mock("@features/agent/store/agent-session-store", () => ({
  useAgentSessionStore: {
    getState: () => sessionStoreMock,
  },
}));

vi.mock("@features/agent/services/external-agent-runtime-service", () => ({
  isLocalExternalThreadId: vi.fn(
    (threadId: string, typeKey: string) =>
      threadId.startsWith(`${typeKey}-pending-`) ||
      threadId.startsWith(`${typeKey}-local-`),
  ),
  resolveExternalSessionId: vi.fn(async () => null),
}));

describe("agent thread card cache helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentConversationStoreMock.messageStates = {};
    sessionStoreMock.threadProjections = {};
    sessionStoreMock.updateThreadHistory.mockImplementation((threadId, updater) => {
      const current = sessionStoreMock.threadProjections[threadId] as ThreadProjection | undefined;
      const projection = current ?? emptyProjection();
      sessionStoreMock.threadProjections[threadId] = { ...projection, ...updater(projection) };
    });
    // 模拟 loadMessages 路径: sessionStoreMock.loadMessages 被
    // mock 时, 同步把 messageStates 投影到 sessionStoreMock.threadProjections,
    // 模拟真实环境会话 store 的历史投影更新.
    sessionStoreMock.loadMessages.mockImplementation(
      async (_typeKey, threadId) => {
        const ms = (agentConversationStoreMock.messageStates as Record<
          string,
          { messages: unknown[] }
        >)[threadId];
        if (ms) {
          sessionStoreMock.threadProjections[threadId] = {
            messages: ms.messages,
            pagination: {
              oldestSequence: null,
              hasMoreHistory: false,
              loadingInitial: false,
              loadingMore: false,
            },
            runs: {
              isLoading: false,
              activeRunId: null,
              runs: {},
            },
          };
        }
        return "ready";
      },
    );
  });

  it("loads standard thread cache for non external agents", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "flowix-thread",
      typeKey: "dsh",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "dsh",
      "flowix-thread",
    );
    expect(result).toEqual({
      resolvedSessionId: null,
      loadedThreadId: "flowix-thread",
      messages: [],
    });
  });

  it("finishes detail history loading for a recovered local thread without a provider session", async () => {
    const { loadAgentThreadCardCache } = await import("./agent-thread-card-cache");
    const threadId = "codex-local-recovered-empty";
    await loadAgentThreadCardCache({ threadId, typeKey: "codex" });
    const projection = sessionStoreMock.threadProjections[threadId] as ThreadProjection;
    expect(projection.pagination).toMatchObject({ initialStatus: "ready", loadingInitial: false });
    expect(isInitialConversationHistoryLoading(threadId, projection.messages.length, projection.pagination.initialStatus)).toBe(false);
    expect(sessionStoreMock.loadMessages).not.toHaveBeenCalled();
  });

  it("preserves a live run while resolving an unbound local thread", async () => {
    const { loadAgentThreadCardCache } = await import("./agent-thread-card-cache");
    const threadId = "codex-local-live";
    const projection = emptyProjection();
    projection.runs.isLoading = true;
    projection.runs.activeRunId = "live-run";
    sessionStoreMock.threadProjections[threadId] = projection;
    await loadAgentThreadCardCache({ threadId, typeKey: "codex" });
    expect(sessionStoreMock.threadProjections[threadId].runs).toEqual(projection.runs);
    expect(sessionStoreMock.threadProjections[threadId].pagination).toEqual(projection.pagination);
  });

  it("binds a resolved Codex session before loading history under the product id", async () => {
    const { resolveExternalSessionId } =
      await import("@features/agent/services/external-agent-runtime-service");
    vi.mocked(resolveExternalSessionId).mockResolvedValueOnce(
      "codex-real-session",
    );
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "codex-local-inst-1",
      typeKey: "codex",
    });

    expect(result).toEqual({
      resolvedSessionId: "codex-real-session",
      loadedThreadId: "codex-local-inst-1",
      messages: [],
    });
    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "codex",
      "codex-local-inst-1",
    );
    expect(sessionStoreMock.bindProviderSessionId).toHaveBeenCalledWith(
      "codex-local-inst-1", "codex-real-session", "codex",
    );
    expect(sessionStoreMock.bindProviderSessionId.mock.invocationCallOrder[0])
      .toBeLessThan(sessionStoreMock.loadMessages.mock.invocationCallOrder[0]);
  });

  it("loads Codex history for a resolved session id", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "codex-real-session",
      typeKey: "codex",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "codex",
      "codex-real-session",
    );
    expect(result.loadedThreadId).toBe("codex-real-session");
  });

  it("loads Claude history for a resolved session id", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "claude-real-session",
      typeKey: "claudecode",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "claudecode",
      "claude-real-session",
    );
    expect(result.loadedThreadId).toBe("claude-real-session");
  });

  it("loads OpenCode history from the paginated thread message store", async () => {
    const messages = [
      { id: "user-1", role: "user", content: "hello", timestamp: "1" },
      { id: "assistant-1", role: "assistant", content: "hi", timestamp: "2" },
    ];
    sessionStoreMock.loadMessages.mockImplementationOnce(
      async (typeKey, threadId) => {
        expect(typeKey).toBe("opencode");
        expect(threadId).toBe("opencode-session-1");
        agentConversationStoreMock.messageStates = {
          "opencode-session-1": { messages },
        };
        // Phase 5 (2026-08-03): 同步投到 session-store 真源, 模拟
        // 会话 store 的历史投影更新行为，cache helper 读真源.
        sessionStoreMock.threadProjections["opencode-session-1"] = {
          messages,
          pagination: {
            oldestSequence: null,
            hasMoreHistory: false,
            loadingInitial: false,
            loadingMore: false,
          },
          runs: { isLoading: false, activeRunId: null, runs: {} },
        };
        return "ready";
      },
    );
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "opencode-session-1",
      typeKey: "opencode",
    });

    expect(sessionStoreMock.loadMessages).toHaveBeenCalledWith(
      "opencode",
      "opencode-session-1",
    );
    expect(result.messages).toEqual(messages);
  });
});


it("does not treat a failed history request as a successful empty cache", async () => {
  sessionStoreMock.loadMessages.mockResolvedValueOnce("error");
  const { loadAgentThreadCardCache } = await import("./agent-thread-card-cache");
  await expect(loadAgentThreadCardCache({ threadId: "failed-history", typeKey: "codex" }))
    .rejects.toThrow("Thread history load error");
});


it("shares session resolution and history loading across views of the same product thread", async () => {
  const { resolveExternalSessionId } = await import("@features/agent/services/external-agent-runtime-service");
  let resolve!: (sessionId: string) => void;
  vi.mocked(resolveExternalSessionId).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const { loadAgentThreadCardCache } = await import("./agent-thread-card-cache");
  const input = { threadId: "codex-local-shared-history", typeKey: "codex" as const };
  const first = loadAgentThreadCardCache(input);
  const second = loadAgentThreadCardCache(input);
  expect(second).toBe(first);
  const callsBefore = sessionStoreMock.loadMessages.mock.calls.length;
  resolve("native-shared-history");
  await Promise.all([first, second]);
  expect(sessionStoreMock.loadMessages.mock.calls.length).toBe(callsBefore + 1);
  expect(sessionStoreMock.loadMessages).toHaveBeenLastCalledWith("codex", input.threadId);
});
