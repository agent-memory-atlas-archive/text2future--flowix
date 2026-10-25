/** Stable navigation commands consumed by note-oriented features. */
export {
  clearWorkspaceDocument,
  replaceExternalDocumentPath,
  historyEntryFromWorkColumnTarget,
} from '@features/workspace/use-cases/workspace-navigation';
export { openWorkspaceSurface } from './open-surface-api';
export type { OpenWorkspaceSurfaceRequest } from './open-surface-api';
export type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
