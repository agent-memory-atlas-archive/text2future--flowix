import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateWorkspaceNavigationImport as blocked } from './workspace-navigation-boundary.mjs';

const importer = 'features/memo/components/tree.tsx';
test('blocks the entire navigation implementation, independent of imported symbol', () => {
  for (const module of ['workspace-navigation', 'surface-opening', 'browser-column-navigation', 'workspace-content-activation']) {
    for (const spec of [`@features/workspace/use-cases/${module}`, `@/features/workspace/use-cases/${module}.ts`, `../../workspace/use-cases/${module}`, `../../workspace/use-cases/${module}.js`]) {
      assert.equal(blocked(importer, spec), true, spec);
    }
  }
});
test('allows public seams, internal adapters, and unrelated modules', () => {
  assert.equal(blocked(importer, '@features/workspace/public/open-surface-api'), false);
  assert.equal(blocked('features/workspace/public/main-window-api.ts', '../use-cases/workspace-navigation'), false);
  assert.equal(blocked(importer, './workspace-navigation'), false);
  assert.equal(blocked(importer, 'react'), false);
});
