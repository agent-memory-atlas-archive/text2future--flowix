import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
import type { Notebook } from '@features/memo/store/memo-store';

/** Open notebook Markdown through the shared path document surface. */
export async function openNotebookNote(
  path: string,
  notebook: Notebook,
  options: { destination?: 'main-third'; history?: 'push' | 'skip'; initialFocus?: 'title' | 'body'; mayBePlugin?: boolean } = {},
): Promise<WorkspaceContentLocation | null> {
  return openExternalTarget(path, {
    scopePath: notebook.path,
    destination: options.destination,
    history: options.history,
    initialFocus: options.initialFocus,
  });
}
