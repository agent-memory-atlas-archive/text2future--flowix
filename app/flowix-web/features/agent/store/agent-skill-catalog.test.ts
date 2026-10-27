import { describe, expect, it } from "vitest";
import { useAgentDataStore, type AgentCatalogSkill } from "./agent-data-store";

function deferred() {
  let resolve!: (items: AgentCatalogSkill[]) => void;
  const promise = new Promise<AgentCatalogSkill[]>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("skill catalog invalidation", () => {
  it("prevents an invalidated prefetch from creating a fresh stale cache without a mounted menu", async () => {
    const store = useAgentDataStore.getState();
    const scope = "invalidate-pending-prefetch";
    const old = deferred();
    const pending = store.loadSkillCatalog("codex", scope, () => old.promise);
    store.invalidateSkillCatalog("codex", scope);
    old.resolve([{ name: "old-skill", description: "Old" }]);
    await pending;
    expect(useAgentDataStore.getState().agents.codex.catalog.skillsByNotebookId[scope]?.updatedAt ?? 0).toBe(0);
    const fresh = [{ name: "installed-skill", description: "Installed" }];
    expect(await store.loadSkillCatalog("codex", scope, async () => fresh)).toEqual(fresh);
  });

  it("keeps the replacement request pending when an invalidated request finishes", async () => {
    const store = useAgentDataStore.getState();
    const scope = "invalidate-replacement-pending";
    const old = deferred();
    const fresh = deferred();
    const first = store.loadSkillCatalog("codex", scope, () => old.promise);
    store.invalidateSkillCatalog("codex", scope);
    const replacement = store.loadSkillCatalog("codex", scope, () => fresh.promise);
    old.resolve([{ name: "old-skill", description: "Old" }]);
    await first;
    const joined = store.loadSkillCatalog("codex", scope, async () => { throw new Error("must reuse replacement"); });
    expect(joined).toBe(replacement);
    const items = [{ name: "installed-skill", description: "Installed" }];
    fresh.resolve(items);
    expect(await replacement).toEqual(items);
    expect(await joined).toEqual(items);
  });
});
