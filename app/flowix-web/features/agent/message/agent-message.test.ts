import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import {
  getAgentMessageEndTimeText,
  getAgentMessageVisibleContent,
  shouldRenderAgentMessage,
} from "@features/agent/message/agent-message";

function errorMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg:deepseek-harness:r1:error:error",
    role: "assistant",
    content: "Request timed out.",
    timestamp: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("DeepSeek Harness reconnect error display", () => {
  it("keeps provider commentary visible in the normal transcript", () => {
    expect(
      shouldRenderAgentMessage(
        errorMessage({ messageType: "agent-commentary" }),
      ),
    ).toBe(true);
    expect(shouldRenderAgentMessage(errorMessage())).toBe(true);
  });

  it("does not throw when a persisted message has an invalid timestamp", () => {
    expect(
      getAgentMessageEndTimeText(errorMessage({ timestamp: "invalid" }), "zh-CN"),
    ).toBe("");
  });

  it("shows a localized reconnect message and the original failure reason", () => {
    expect(getAgentMessageVisibleContent(errorMessage(), "zh-CN")).toBe(
      "DeepSeek Harness 重连失败\n\n失败原因：Request timed out.",
    );
    expect(getAgentMessageVisibleContent(errorMessage(), "en-US")).toBe(
      "DeepSeek Harness reconnect failed\n\nFailure reason: Request timed out.",
    );
  });

  it("does not change ordinary assistant errors", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "assistant-1",
          content: "Request timed out.",
          notice: undefined,
        }),
        "zh-CN",
      ),
    ).toBe("Request timed out.");
  });

  it("keeps only the Harness error message and hides stderr/stack details", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          content: [
            "[HARNESS_RUN_FAILED] JSON-RPC input closed",
            "exit code: 1",
            "stderr tail:",
            "Error: dsh-jsonrpc-agent: plugin tree failed to load",
            "    at /local/path/app-boot/src/index.ts:800:11",
          ].join("\n"),
        }),
        "zh-CN",
      ),
    ).toBe("DeepSeek Harness 重连失败\n\n失败原因：JSON-RPC input closed");
  });

  it("shows only the upstream message from a status-prefixed JSON error", () => {
    const content =
      '402: {"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}';

    expect(
      getAgentMessageVisibleContent(errorMessage({ content }), "zh-CN"),
    ).toBe("DeepSeek Harness 重连失败\n\n失败原因：Insufficient Balance");
    expect(
      getAgentMessageVisibleContent(errorMessage({ content }), "en-US"),
    ).toBe(
      "DeepSeek Harness reconnect failed\n\nFailure reason: Insufficient Balance",
    );
  });

  it("parses a provider JSON error prefixed by an HTTP status and a space", () => {
    const content =
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"},"request_id":"07005fb7c16d866bd9b4e496c69f4058"}';

    expect(
      getAgentMessageVisibleContent(
        errorMessage({ id: "assistant-429-space", content, notice: undefined }),
        "zh-CN",
      ),
    ).toContain("已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)");
    expect(
      getAgentMessageVisibleContent(
        errorMessage({ id: "assistant-429-space-2", content, notice: undefined }),
        "zh-CN",
      ),
    ).not.toContain('{"type":"error"');
  });

  it("shows the upstream provider message before diagnostic metadata", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "msg:claude:run-1:error:error",
          content: "Claude Code CLI exited with status exit status: 1",
          errorDetails: {
            category: "rate_limited",
            statusCode: 429,
            requestId: "req-1",
            exitCode: 1,
            upstreamMessage: "5 hour usage limit reached",
            retryable: false,
          },
        }),
        "zh-CN",
      ),
    ).toBe(
      "5 hour usage limit reached\n\n请求受到限流，请等待配额恢复后重试。\n\nHTTP 429 · 请求 ID：req-1",
    );

    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "msg:claude:run-1:error:error-en",
          content: "rate limited",
          errorDetails: {
            category: "rate_limited",
            statusCode: 429,
            retryAfter: "60s",
            requestId: "req-1",
            retryable: true,
          },
        }),
        "en-US",
      ),
    ).toBe(
      "rate limited\n\nThe request was rate limited. Retry after the quota recovers.\n\nHTTP 429 · Request ID: req-1 · Retry after: 60s",
    );
  });

  it("does not wrap a persisted DSH quota error as a reconnect failure", () => {
    const content = getAgentMessageVisibleContent(
      errorMessage({
        content: "DeepSeek Harness turn failed (failed)",
        errorDetails: {
          category: "quota_exhausted",
          statusCode: 429,
          requestId: "req-2056",
          upstreamMessage: "Token Plan exhausted",
          retryable: false,
        },
      }),
      "zh-CN",
    );
    expect(content).toContain("Token Plan exhausted");
    expect(content).not.toContain("重连失败");
    expect(content).not.toContain("HTTP 429");
    expect(content).not.toContain("req-2056");
  });

  it("also hides diagnostics for the same DSH error after history refresh", () => {
    const content = getAgentMessageVisibleContent(
      errorMessage({
        id: "thread-a-turn-1-error",
        content: "Token Plan exhausted",
        errorDetails: {
          category: "quota_exhausted",
          statusCode: 429,
          requestId: "req-2056",
          upstreamMessage: "Token Plan exhausted",
          source: "dsh-history",
          exitCode: 1,
          retryable: false,
        },
      }),
      "zh-CN",
    );
    expect(content).toBe(
      "Token Plan exhausted",
    );
  });

  it("shows only the original Codex quota error without Flowix guidance", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "msg:codex:run-1:error:error",
          content: "Insufficient Balance",
          errorDetails: {
            category: "quota_exhausted",
            upstreamMessage: "Insufficient Balance",
            retryable: false,
          },
        }),
        "zh-CN",
      ),
    ).toBe("Insufficient Balance");
  });

  it("does not show the CLI exit status for a Codex interruption", () => {
    const content = getAgentMessageVisibleContent(
      errorMessage({
        id: "msg:codex:run-1:error:error",
        content: "Codex turn interrupted",
        errorDetails: {
          category: "unknown",
          exitCode: 1,
          upstreamMessage: "Codex turn interrupted",
          retryable: false,
        },
      }),
      "zh-CN",
    );

    expect(content).toBe(
      "Codex turn interrupted",
    );
    expect(content).not.toContain("CLI 退出状态");
  });

  it("removes the legacy Claude/Codex process wrapper when details are absent", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "assistant-2",
          content:
            "Claude Code CLI exited with status exit status: 1: 5 hour usage limit reached",
        }),
        "zh-CN",
      ),
    ).toBe("5 hour usage limit reached");
  });

  it("extracts detail from a standalone Codex JSON error", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "assistant-codex-error",
          content:
            '{"detail":"The \'inherit\' model is not supported when using Codex with a ChatGPT account."}',
        }),
        "zh-CN",
      ),
    ).toBe(
      "The 'inherit' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("extracts detail from a status-prefixed historical provider JSON error", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "thread-1-turn-1-error",
          content:
            '429: {"message":"Token Plan usage limit reached","type":"","code":""}',
        }),
        "zh-CN",
      ),
    ).toBe("Token Plan usage limit reached");
  });
});

describe('ordinary assistant content survives cloud error presentation', () => {
  it.each([
    ['assistant-live', '这是一条正常回复'],
    ['assistant-history', '这是历史对话中的回答\n\n- 第一项\n- 第二项'],
    ['assistant-stream', '正在生成的部分内容'],
    ['assistant-code', '```ts\nconst message = "hello";\n```'],
    ['assistant-auth-explanation', '出现 cloud API error 401 UNAUTHORIZED 时，请检查登录状态'],
    ['assistant-token-explanation', 'INVALID_REFRESH_TOKEN 表示刷新令牌已失效'],
    ['assistant-credit-example', '错误码 INSUFFICIENT_CREDITS 表示余额不足'],
    ['assistant-model-example', '```text\nMODEL_NOT_FOUND\nCLOUD_MODELS_DISABLED\nMODEL_PRICING_NOT_CONFIGURED\n```'],
    ['assistant-quoted-error', 'cloud API error 401 UNAUTHORIZED: quoted example'],
  ])('preserves %s verbatim', (id, content) => {
    expect(getAgentMessageVisibleContent({
      id, role: 'assistant', content, timestamp: '2026-10-24T00:00:00.000Z',
    }, 'zh-CN')).toBe(content);
  });
});


describe('Cloud error rows', () => {
  it.each([
    ['error-cloud', 'cloud API error 401 UNAUTHORIZED: expired', '登录已过期，请重新登录'],
    ['thread-turn-error', 'cloud API error 500 INTERNAL_ERROR: database details', '无法连接云模型，请稍后重试'],
    ['error-membership', 'cloud API error 403 MEMBERSHIP_REQUIRED: inactive', '此模型需要有效的 Flowix Cloud 会员'],
  ])('translates %s without exposing technical details', (id, content, expected) => {
    const visible = getAgentMessageVisibleContent({ id, role: 'assistant', content, errorDetails: { category: 'provider', retryable: false }, timestamp: '2026-10-24T00:00:00.000Z' }, 'zh-CN');
    expect(visible).toContain(expected);
    expect(visible).not.toMatch(/cloud API error|database details|UNAUTHORIZED/);
  });
});
