import type { ContentIdentity } from '../model/surface-identity';
import { getWorkspaceSurfaceLifecycle } from '../store/surface-lifecycle-store';
import { findWorkspaceContentLocations } from './workspace-content-activation';

export async function flushBrowserViewBeforeOpeningWork(identity: ContentIdentity): Promise<boolean> {
  const browserLocation = findWorkspaceContentLocations(identity).browserColumn;
  if (!browserLocation) return true;
  const lifecycle = getWorkspaceSurfaceLifecycle(browserLocation.surfaceId);
  if (lifecycle?.status === 'ready' && lifecycle.flush) {
    try { return await lifecycle.flush(); }
    catch { return false; }
  }
  return true;
}
