import { useAgentDataStore } from "@features/agent/store/agent-data-store";

export const NOTEBOOK_SKILLS_CHANGED_EVENT = "flowix:notebook-agent-skills-changed";

export interface NotebookSkillsChangedDetail {
  notebookId: string;
  notebookPath: string;
}

/** Invalidate shared catalogs before asking mounted skill views to reload. */
export function notifyNotebookSkillsChanged(detail: NotebookSkillsChangedDetail): void {
  const store = useAgentDataStore.getState();
  for (const agentType of ["codex", "dsh", "pi"] as const) {
    for (const scope of new Set([detail.notebookId, detail.notebookPath])) {
      store.invalidateSkillCatalog(agentType, scope);
    }
  }
  window.dispatchEvent(new CustomEvent(NOTEBOOK_SKILLS_CHANGED_EVENT, { detail }));
}
