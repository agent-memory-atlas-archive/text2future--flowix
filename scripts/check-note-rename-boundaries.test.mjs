import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkNoteRenameBoundaries } from './check-note-rename-boundaries.mjs';

test('rejects renamed aliases, bracket access, destructuring, and raw IPC outside the adapter', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'flowix-rename-boundary-'));
  const webRoot = join(repoRoot, 'app/flowix-web');
  const write = async (path, content) => {
    const fullPath = join(webRoot, path);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  };
  try {
    await writeFile(join(repoRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true },
      include: ['app/flowix-web/**/*.ts'],
    }), 'utf8');
    await write('platform/tauri/client/desktop.ts', 'export const files = { rename: async (path: string) => path };\n');
    await write('features/document/use-cases/local-document-operations.ts', [
      "import { files } from '../../../platform/tauri/client/desktop';",
      "void files.rename('allowed');",
      'export function renameLocalDocumentFile() {}',
      'export function renameMarkdownTitle() {}',
    ].join('\n'));
    await write('features/bypass.ts', [
      "import { files as nativeFiles } from '../platform/tauri/client/desktop';",
      "import { renameLocalDocumentFile as rawDocumentRename, renameMarkdownTitle } from './document/use-cases/local-document-operations';",
      "import * as fileOperations from './document/public/file-operations-api';",
      "void nativeFiles.rename('property');",
      "void nativeFiles['rename']('bracket');",
      "const { rename: directRename } = nativeFiles; void directRename('destructured');",
      'void rawDocumentRename(); void renameMarkdownTitle();',
      'void fileOperations.renameLocalDocumentFile;',
    ].join('\n'));
    await write('features/raw-command.ts', "invoke('rename_file'); invoke('rename_memo_title');\n");
    await write('features/bypass.test.ts', "invoke('rename_file');\n");

    const violations = checkNoteRenameBoundaries({ repoRoot, webRoot });
    assert.equal(violations.length, 8, violations.join('\n'));
    assert.ok(violations.some((item) => item.includes('files.rename')));
    assert.ok(violations.some((item) => item.includes('bracket access')));
    assert.ok(violations.some((item) => item.includes('destructuring')));
    assert.equal(violations.filter((item) => item.includes('approved rename adapter')).length, 2);
    assert.ok(violations.some((item) => item.includes('namespace access')));
    assert.equal(violations.filter((item) => item.includes('raw rename IPC command')).length, 2);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
