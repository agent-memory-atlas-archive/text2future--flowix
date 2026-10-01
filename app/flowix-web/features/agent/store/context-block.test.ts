import { beforeEach, describe, expect, it, vi } from "vitest";

const memoState = vi.hoisted(() => ({
  selectedNotebook: null as { path?: string } | null,
  selectedMemo: null,
}));

const tagState = vi.hoisted(() => ({
  activeFilter: "all" as string,
  selectedTagId: null as string | null,
  tags: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@features/document", () => ({
  getActiveDocumentDraft: () => null,
  useDocumentStore: {
    getState: () => ({ currentDocumentPath: "" }),
  },
}));
vi.mock("@features/document/store/document-session-service", () => ({
  getActiveDocumentDraft: () => null,
}));
vi.mock("@features/document/store/document-store", () => ({
  useDocumentStore: {
    getState: () => ({ currentDocumentPath: "" }),
  },
}));

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: {
    getState: () => memoState,
  },
}));

vi.mock("@features/memo/store/tag-store", () => ({
  useTagStore: {
    getState: () => tagState,
  },
}));

describe("appendFirstMessageContext", () => {
  beforeEach(() => {
    memoState.selectedNotebook = null;
    tagState.activeFilter = "all";
    tagState.selectedTagId = null;
    tagState.tags = [];
  });

  it("keeps note context but omits cwd and notebook-list metadata", async () => {
    const { appendFirstMessageContext } = await import(
      "@features/agent/store/context-block"
    );

    const result = appendFirstMessageContext(
      "question",
      true,
      "note preview",
      "codex",
    );

    expect(result).toContain("当前笔记内容（前500字）:");
    expect(result).toContain("note preview");
    expect(result).not.toContain("当前笔记路径:");
    expect(result).not.toContain("当前笔记本路径:");
    expect(result).not.toContain("全部笔记本路径:");
    expect(result).not.toContain("# flowix CLI");
  });

  it("keeps the CLI fallback for runtimes without native AGENTS loading", async () => {
    const { appendFirstMessageContext } = await import(
      "@features/agent/store/context-block"
    );

    const result = appendFirstMessageContext("question", true, "note", "claude");

    expect(result).toContain("# flowix CLI");
  });
});
