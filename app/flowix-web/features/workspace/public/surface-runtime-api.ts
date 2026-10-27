/**
 * Web-surface runtime contract. The surface layer owns rendering and only needs
 * the pure navigation state machine plus its type, not the whole workspace model.
 */
export type { WorkspaceWebRuntime } from '../model/surface-contract';
export {
  createWorkspaceWebRuntime,
  navigateWorkspaceWebRuntime,
  moveWorkspaceWebHistory,
  reloadWorkspaceWebRuntime,
  replaceWorkspaceWebRuntimeUrl,
} from '../model/web-navigation';
