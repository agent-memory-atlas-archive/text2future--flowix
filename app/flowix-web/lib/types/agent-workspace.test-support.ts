/** Historical config fixtures retained for workspace import regression tests. */
import type { FilesConfig } from '@/types/agent';

export type AgentAccessKind = "notebook" | "folder";

export interface AgentAccessEntry {
  id: string;
  kind: AgentAccessKind;
  path: string;
  name: string;
  enabled: boolean;
  /** @deprecated Workspace selection is notebook-owned; retained for v1 JSON. */
  workspace?: boolean;
  addedAt: number;
  updatedAt: number;
  /** 运行时由后端重算: 该 path 在磁盘上是否还存在。 失联目录保留在列表,
   *  UI 据此灰显 + 强制禁用勾选框。 */
  missing: boolean;
}

/**
 * Legacy notebook-indexed files defaults. This type is retained so old config
 * files can be read and migrated; it is no longer the write target.
 *
 * The backend migrates old shapes into notebook-local add-dir configs.
 */
export type AgentAccessFilesDefaults = Record<string, FilesConfig>;

export interface AgentAccessDefaults {
  files?: AgentAccessFilesDefaults;
}

export interface AgentAccessConfig {
  version: number; // 当前 = 1
  entries: AgentAccessEntry[];
  defaults?: AgentAccessDefaults;
}
