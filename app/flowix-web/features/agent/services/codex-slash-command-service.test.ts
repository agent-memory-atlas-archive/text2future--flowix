import { describe, expect, it, vi } from "vitest";
import { agent } from "@platform/tauri/client/agent";

import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import {
  beginCodexSlashCommand,
  createCodexCommandLifecycle,
  finishCodexSlashCommand,
  hasPendingCodexCommand,
  listCodexSkillCatalog,
  listCodexSkills,
  parseCodexSkills,
} from "./codex-slash-command-service";

describe("listCodexSkillCatalog", () => {
  it("refreshes Codex discovery and uses project display-name for the matching skill path", async () => {
    const catalog = vi.spyOn(agent, "getCodexProjectSkills").mockResolvedValue({
      skills: [
        { name: "story-long-analyze", path: "/notebook/.agents/skills/story-long-analyze/SKILL.md" },
        { name: "story-long-analyze", path: "/global/story-long-analyze/SKILL.md" },
      ],
    });
    const localSkills = vi.spyOn(agent, "readNotebookAgentSkills").mockResolvedValue([{
      id: "story-long-analyze", name: "长篇小说拆文", description: "Analyze", enabled: true,
      body: "Instructions", path: ".agents/skills/story-long-analyze/SKILL.md",
      frontmatter: { name: "story-long-analyze", "display-name": "长篇小说拆文" },
    }]);
    try {
      const skills = await listCodexSkillCatalog("/notebook");
      expect(catalog).toHaveBeenCalledWith("/notebook", true);
      expect(skills[0].displayName).toBe("长篇小说拆文");
      expect(skills[1].displayName).toBeUndefined();
      const menuSkills = await listCodexSkills("/notebook");
      expect(menuSkills.find((skill) => skill.name === "story-long-analyze")?.displayName)
        .toBe("长篇小说拆文");
    } finally {
      catalog.mockRestore();
      localSkills.mockRestore();
    }
  });
});

describe("parseCodexSkills", () => {
  it("reads the current skills/list response grouped by cwd", () => {
    expect(parseCodexSkills({
      data: [{
        cwd: "/workspace/project",
        skills: [
          {
            name: "review-agent",
            description: "Review changes.",
            interface: {
              displayName: "Review Agent",
              shortDescription: "Find actionable review findings.",
            },
            scope: "system",
          },
          { name: "skill-creator", description: "Create a skill.", enabled: true },
        ],
      }],
      errors: [],
    })).toEqual([
      {
        name: "review-agent",
        description: "Review changes.",
        displayName: "Review Agent",
        shortDescription: "Find actionable review findings.",
        scope: "system",
      },
      { name: "skill-creator", description: "Create a skill." },
    ]);
  });

  it("accepts direct data and skills envelopes", () => {
    expect(parseCodexSkills({
      data: [{ name: "from-data", description: "Data" }],
    })).toEqual([{ name: "from-data", description: "Data" }]);
    expect(parseCodexSkills({
      skills: [{ name: "from-skills", description: "Skills" }],
    })).toEqual([{ name: "from-skills", description: "Skills" }]);
  });

  it("excludes disabled skills before deduplicating names and accepts unspecified enablement", () => {
    const skills = parseCodexSkills({ skills: [
      { name: "disabled", description: "Disabled", enabled: false },
      { name: "review", description: "Disabled duplicate", enabled: false },
      { name: "review", description: "Enabled review", enabled: true },
      { name: "legacy", description: "No enabled field" },
    ] });

    expect(skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "review", description: "Enabled review" },
      { name: "legacy", description: "No enabled field" },
    ]);
  });

  it("accepts nested skills envelopes and removes duplicate names", () => {
    expect(parseCodexSkills({
      data: {
        skills: {
          data: [
            { name: "nested", description: "Nested" },
            { name: "nested", description: "Duplicate" },
          ],
        },
      },
    })).toEqual([{ name: "nested", description: "Nested" }]);
  });

  it("ignores empty and malformed responses", () => {
    expect(parseCodexSkills(undefined)).toEqual([]);
    expect(parseCodexSkills({ data: [{ cwd: "/workspace/project", skills: [null, {}, { name: "" }] }] }))
      .toEqual([]);
  });
});

describe("Codex command lifecycle", () => {
  it("creates an immediately visible pending row and settles the same row", () => {
    const threadId = "codex-command-lifecycle-test";
    const command = "/goal set ship it";
    const lifecycle = createCodexCommandLifecycle(threadId);

    beginCodexSlashCommand(threadId, command, lifecycle);
    let projection = useAgentSessionStore.getState().threadProjections[threadId];
    expect(projection?.messages).toMatchObject([
      {
        id: `flowix:codex:command:pending:${lifecycle.commandId}`,
        content: command,
        isLoading: true,
      },
    ]);
    expect(hasPendingCodexCommand(threadId)).toBe(true);

    finishCodexSlashCommand(threadId, command, lifecycle, "error", "failed");
    projection = useAgentSessionStore.getState().threadProjections[threadId];
    expect(projection?.messages[0]).toMatchObject({
      content: command,
      isLoading: false,
      isCompleted: true,
    });
    expect(hasPendingCodexCommand(threadId)).toBe(false);

    useAgentSessionStore.getState().removeThreadProjection(threadId);
  });
});
