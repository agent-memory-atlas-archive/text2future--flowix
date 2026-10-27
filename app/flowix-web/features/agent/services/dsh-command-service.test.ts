import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), reload: vi.fn(async () => []), onError: vi.fn(), listSkills: vi.fn(),
}));
vi.mock("@features/agent/store/agent-client", () => ({
  agentClient: { executeDeepSeekHarnessCommand: mocks.execute, listDeepSeekHarnessSkills: mocks.listSkills },
}));
vi.mock("@features/agent/store/agent-session-store", () => ({
  useAgentSessionStore: { getState: () => ({
    sessionMeta: { settings: {} }, threadProjections: {},
    reloadMessagesFromHistory: mocks.reload,
  }) },
}));
vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: { getState: () => ({ selectedNotebook: null, notebooks: [] }) },
}));
vi.mock("@features/agent/runtime/agent-runtime-spec", () => ({
  buildAgentRuntimeConfig: () => ({}),
  getAgentAccessOptions: () => [],
  getAgentModeOptions: () => [],
}));

import { listDshSkills, runDshCommand } from "./dsh-command-service";
import { agent } from "@platform/tauri/client/agent";

describe("DSH skill display names", () => {
  it("applies project display-name by path without renaming a same-named global skill", async () => {
    const root = "/notes/开发任务管理";
    mocks.listSkills.mockResolvedValueOnce({ skills: [
      { name: "story-long-analyze", description: "Local", path: `${root}/.agents/skills/story-long-analyze/SKILL.md` },
      { name: "story-long-analyze", description: "Global", path: "/global/story-long-analyze/SKILL.md" },
    ] });
    const local = vi.spyOn(agent, "readNotebookAgentSkills").mockResolvedValue([{
      id: "story-long-analyze", name: "长篇小说拆文", description: "Local", enabled: true,
      path: ".agents/skills/story-long-analyze/SKILL.md", body: "Instructions",
      frontmatter: { "display-name": "长篇小说拆文" },
    }]);
    try {
      const skills = await listDshSkills({ threadId: "thread-1", runtimeConfig: {
        workspaceSnapshot: { version: 1, cwd: root, notebookPath: root, workspacePaths: [], capturedAt: 0 },
      } });
      expect(local).toHaveBeenCalledWith(root);
      expect(skills[0].displayName).toBe("长篇小说拆文");
      expect(skills[1].displayName).toBeUndefined();
    } finally {
      local.mockRestore();
    }
  });
});

describe("DSH command acceptance", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const input = {
    command: "/plan", ensureConversation: async () => ({ threadId: "thread-1" }),
    rejectOnFailure: true,
  };

  it("rejects explicit command errors rather than clearing the composer's snapshot", async () => {
    mocks.execute.mockResolvedValueOnce({ execution: { result: { kind: "error", text: "command rejected" } } });
    await expect(runDshCommand(input)).rejects.toThrow("command rejected");
  });

  it("propagates IPC failures to the submission coordinator", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("IPC rejected"));
    await expect(runDshCommand(input)).rejects.toThrow("IPC rejected");
  });

  it("does not revoke command acceptance when only history refresh fails", async () => {
    mocks.execute.mockResolvedValueOnce({ execution: { result: { kind: "success" } } });
    mocks.reload.mockRejectedValueOnce(new Error("history unavailable"));
    await expect(runDshCommand(input)).resolves.toBeUndefined();
  });
});
