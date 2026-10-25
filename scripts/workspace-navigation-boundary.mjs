import { posix } from 'node:path';

/** Resolve supported frontend aliases and relative imports before checking. */
export function isPrivateWorkspaceNavigationImport(importer, specifier) {
  if (importer.startsWith('features/workspace/')) return false;
  let target;
  if (specifier.startsWith('@features/')) target = `features/${specifier.slice(10)}`;
  else if (specifier.startsWith('@/')) target = specifier.slice(2);
  else if (specifier.startsWith('.')) target = posix.join(posix.dirname(importer), specifier);
  else return false;
  target = posix.normalize(target).replace(/\.(?:tsx?|jsx?)$/, '');
  return /^features\/workspace\/use-cases\/(?:workspace-navigation|surface-opening|browser-column-navigation|workspace-content-activation)$/.test(target);
}
