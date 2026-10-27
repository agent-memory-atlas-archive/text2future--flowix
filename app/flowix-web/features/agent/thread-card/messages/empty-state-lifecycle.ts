/** Resources outside the root (sibling panels, body popovers, requests) share its lifetime. */
interface EmptyStateLifecycle {
  canReuse: () => boolean;
  refresh: () => void;
  dispose: () => void;
}

const lifecycles = new WeakMap<HTMLElement, EmptyStateLifecycle>();

export function registerEmptyStateLifecycle(root: HTMLElement, lifecycle: EmptyStateLifecycle): void {
  lifecycles.set(root, lifecycle);
}

export function reuseEmptyState(root: HTMLElement): boolean {
  const lifecycle = lifecycles.get(root);
  if (!lifecycle?.canReuse()) return false;
  lifecycle.refresh();
  return true;
}

export function disposeEmptyState(root: HTMLElement): void {
  const lifecycle = lifecycles.get(root);
  // Remove first: disposal is idempotent even if both owners release the root.
  lifecycles.delete(root);
  lifecycle?.dispose();
}
