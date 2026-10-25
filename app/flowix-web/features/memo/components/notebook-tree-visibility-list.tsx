import { useNoteStore } from '../store/note-store';
import { useNotebookTreeSections } from './use-notebook-tree-sections';
import { NotebookTreeCustomizeList } from './notebook-tree-customize-list';

export function NotebookTreeVisibilityList() {
  const notebookId = useNoteStore((state) => state.selectedNotebook?.id ?? null);
  const { sectionOrder, hiddenSections, updateSections } = useNotebookTreeSections(notebookId, true);

  return <NotebookTreeCustomizeList sectionOrder={sectionOrder} hiddenSections={hiddenSections} onChange={updateSections} itemClassName="pl-1" />;
}
