import { resolveNotebookAgentFiles } from '@/lib/agent-access-defaults';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { normalizeWorkspacePath } from '@features/agent/runtime/workspace-path';

export interface WorkspaceAgentRepository {
  path: string;
  name: string;
  missing: boolean;
}

/** Restore a persisted conversation through the Agent-owned session lifecycle. */
export async function hydrateWorkspaceAgentConversation(instanceId: string) {
  return useAgentSessionStore.getState().hydrateInstance(instanceId);
}

/** Resolve resource roots without exposing Agent access configuration stores. */
export function getWorkspaceAgentResourceFolders(notebookId: string | null): string[] {
  const access = useAgentAccessStore.getState();
  return resolveNotebookAgentFiles(
    access.config,
    access.notebookConfigs,
    notebookId,
  )?.folders ?? [];
}

/** Resolve the same notebook-scoped repository list used by Agent access settings. */
export function getWorkspaceAgentRepositories(
  notebookId: string | null,
): WorkspaceAgentRepository[] {
  if (!notebookId) return [];
  const access = useAgentAccessStore.getState();
  const paths = resolveNotebookAgentFiles(
    access.config,
    access.notebookConfigs,
    notebookId,
  )?.folders ?? [];
  const localDirectories = access.notebookConfigs[notebookId]?.addDirs ?? [];
  return paths.map((path) => {
    const key = normalizeWorkspacePath(path).toLowerCase();
    const local = localDirectories.find(
      (item) => normalizeWorkspacePath(item.path).toLowerCase() === key,
    );
    const entry = access.config.entries.find(
      (item) => normalizeWorkspacePath(item.path).toLowerCase() === key,
    );
    const trimmed = path.replace(/[\\/]+$/, '');
    return {
      path,
      name: local?.label?.trim()
        || entry?.name?.trim()
        || trimmed.split(/[\\/]/).pop()
        || trimmed,
      missing: entry ? entry.missing === true : true,
    };
  });
}
