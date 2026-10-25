import type { AgentTypeKey } from "@/types/agent";
import type { ThreadListItem } from "@/types";
import { decodeHtmlEntities } from "@tiptap/core";
import { translate, type AppLanguage, type I18nKey } from "@/lib/i18n";
import { stripSystemBlock } from "@features/agent/message";
import { getCurrentAppLanguage } from "@features/preferences/public/runtime-api";
import { marked } from "marked";

/** 读取当前 AppLanguage ── zustand store 不在 React 树里也能用 .getState()。 */
function getLanguage(): AppLanguage {
  return getCurrentAppLanguage();
}

function isExternalAgentType(_type: AgentTypeKey): boolean {
  return true;
}

// Keep runtime/session fallback titles separate from the thread-card title.
// The exhaustive Record makes adding a new agent type fail here until its
// title has been reviewed and localized.
const AGENT_SESSION_TITLE_KEYS: Record<AgentTypeKey, I18nKey> = {
  codex: "agent.codexSession.title",
  claudecode: "agent.claudeSession.title",
  hermes: "agent.hermesSession.title",
  opencode: "agent.opencodeSession.title",
  pi: "agent.piSession.title",
  dsh: "agent.deepseekHarnessSession.title",
};

const AGENT_THREAD_CARD_TITLE_KEYS: Record<AgentTypeKey, I18nKey> = {
  ...AGENT_SESSION_TITLE_KEYS,
  dsh: "agent.deepseekHarnessChat.title",
};

function translateAgentTitle(
  type: AgentTypeKey,
  titleKeys: Record<AgentTypeKey, I18nKey>,
): string {
  return translate(getLanguage(), titleKeys[type]);
}

function defaultExternalThreadTitle(type: AgentTypeKey): string {
  return translateAgentTitle(type, AGENT_SESSION_TITLE_KEYS);
}

function defaultThreadTitle(type: AgentTypeKey): string {
  return translateAgentTitle(type, AGENT_THREAD_CARD_TITLE_KEYS);
}

/**
 * Strip 系统块 + 折叠空白 ── 历史 thread title 进入 store 之前统一标准化,
 * 避免 stray 空白字符引起 "为什么它看起来不一样" 这类查找困难的小问题。
 */
function normalizeThreadTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

/** 标题字数上限，按 Unicode code point 计数。 */
const DERIVED_TITLE_MAX_CHARS = 100;

interface MarkdownTextToken {
  type?: string;
  text?: string;
  raw?: string;
  tokens?: MarkdownTextToken[];
  items?: MarkdownTextToken[];
  header?: MarkdownTextToken[];
  rows?: MarkdownTextToken[][];
}

function wikiLinkDisplayText(rawTarget: string): string {
  const aliasSeparator = rawTarget.indexOf("|");
  const target = (aliasSeparator >= 0
    ? rawTarget.slice(0, aliasSeparator)
    : rawTarget).trim();
  const alias = aliasSeparator >= 0
    ? rawTarget.slice(aliasSeparator + 1).trim()
    : "";
  if (alias) return alias;

  const path = target.split("#", 1)[0].replace(/\\/g, "/");
  const segments = path.split("/").filter(Boolean);
  const filename = segments[segments.length - 1] ?? path;
  try {
    return decodeURIComponent(filename).replace(/\.md$/i, "") || target;
  } catch {
    return filename.replace(/\.md$/i, "") || target;
  }
}

function replaceWikiLinkLabels(text: string): string {
  return text.replace(
    /\[\[([^\]\n]+)\]\]/g,
    (_match, target: string) => wikiLinkDisplayText(target),
  );
}

/** Turn Markdown tokens into their visible text, keeping link labels and dropping destinations. */
function markdownTokenText(token: MarkdownTextToken): string {
  if (token.type === "space" || token.type === "br") return " ";
  if (token.type === "hr") return "";
  if (token.type === "image" || token.type === "code" || token.type === "codespan") {
    return token.text ?? "";
  }
  if (token.type === "html") {
    return replaceWikiLinkLabels(
      decodeHtmlEntities((token.raw ?? "").replace(/<[^>]*>/g, " ")),
    );
  }
  if (token.type === "table") {
    const rows = [token.header ?? [], ...(token.rows ?? [])];
    return rows
      .map((row) => row.map(markdownTokenText).join(" "))
      .join(" ");
  }
  if (token.items) return token.items.map(markdownTokenText).join(" ");
  if (token.tokens) return token.tokens.map(markdownTokenText).join("");
  return typeof token.text === "string"
    ? replaceWikiLinkLabels(decodeHtmlEntities(token.text))
    : "";
}

/** Extract visible Markdown text. Wiki links use their alias or note filename. */
function extractTitleText(markdown: string): string {
  try {
    const tokens = marked.lexer(markdown, {
      gfm: true,
      breaks: true,
    }) as MarkdownTextToken[];
    return tokens.map(markdownTokenText).join(" ");
  } catch {
    // Title extraction must never prevent the first message from being sent.
    return markdown;
  }
}

/**
 * 从一段 prompt 文本派生可显示标题: strip 系统块 → 提取 Markdown 可见文本
 * → 折叠空白 → 截断到 100 个 Unicode 字符。
 * 空则回退 `fallback`。首条 user 消息是跨 agent (flowix / claude / codex /
 * hermes / opencode) 唯一共有的标题信号, 故标题恢复统一走这条路径。
 *
 * `thread-card` 的 card 视图与 title-edit-controller 共用此实现, 避免截断
 * 长度 / 清洗规则漂移。
 */
export function deriveThreadTitleFromPrompt(
  prompt: string,
  fallback = "",
): string {
  const title = extractTitleText(stripSystemBlock(prompt))
    .replace(/\s+/g, " ")
    .trim();
  return title
    ? Array.from(title).slice(0, DERIVED_TITLE_MAX_CHARS).join("").trimEnd()
    : fallback;
}

/**
 * 所有 conversation title 都持久化到产品 SQLite `threads.title`。
 * Codex / Claude 等 runtime 文件只提供消息历史，不能成为标题真源。
 */
function canPersistThreadTitle(_type: AgentTypeKey): boolean {
  return true;
}

/**
 * 三段 fallback 拿到 thread 的可显示标题:
 * 1. 真实 threadLists 中的 title
 * 2. product threadId 对应的 currentThreadTitles 标题
 * 3. runtime 的 default title / "新会话" i18n 文本
 *
 * reconcileRunningRunsFromSnapshot 走这条路径生成 thread card 标题。
 */
function getConversationTitleForThread(
  state: {
    threadLists: Partial<Record<AgentTypeKey, ThreadListItem[]>>;
    currentThreadTitles: Partial<Record<string, string | undefined>>;
  },
  type: AgentTypeKey,
  threadId: string,
): string {
  const list = state.threadLists[type] ?? [];
  const fromList = list.find((item) => item.threadId === threadId)?.title;
  if (fromList !== undefined) return fromList;
  const fromThread = state.currentThreadTitles[threadId];
  if (fromThread !== undefined) return fromThread;
  return isExternalAgentType(type)
    ? defaultExternalThreadTitle(type)
    : translate(getLanguage(), "agent.chat.newConversation");
}

export {
  canPersistThreadTitle,
  defaultExternalThreadTitle,
  defaultThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  isExternalAgentType,
  normalizeThreadTitle,
};
