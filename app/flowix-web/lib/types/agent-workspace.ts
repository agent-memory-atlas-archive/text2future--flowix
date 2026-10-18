/** Device-local workspace DTOs. */

/** Notebook-local mount data read from local.db. The notebook itself is cwd;
 * `addDirs` contains only additional runtime roots. */
export interface NotebookAddDir {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  missing?: boolean;
}

export interface NotebookWorkspaceConfig {
  version: 1;
  revision: number;
  addDirs: NotebookAddDir[];
}

/** Authoritative device-local workspace read from local.db. */
export interface AgentWorkspaceSnapshot {
  notebooks: Array<{ id: string; name: string; path: string }>;
  notebookConfigs: Record<string, NotebookWorkspaceConfig>;
}

/** Derived resource metadata; these rows are never persisted independently. */
export interface AgentWorkspaceResource {
  id: string;
  path: string;
  name: string;
  enabled: boolean;
  missing: boolean;
}
