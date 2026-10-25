import { ContentIcon } from '@features/content/public/content-api';
import { getPropertyIconOption } from '@features/document/public/property-display-api';
import { getNotebookIconOption, NotebookIcon } from './notebook-icon';

/** Render a resolved `flowix_icon`; absent or unknown values use the default note glyph. */
export function NotebookNoteIcon({ icon, className }: { icon: string | null; className?: string }) {
  const value = icon?.trim();
  const propertyIcon = value ? getPropertyIconOption(value) : null;
  if (propertyIcon) {
    return <img src={propertyIcon.src} alt="" aria-hidden="true" draggable={false} className={className} />;
  }
  const notebookIcon = value ? getNotebookIconOption(value) : null;
  if (notebookIcon) {
    return <NotebookIcon icon={notebookIcon.id} className={className} imageClassName="h-full w-full" disableTitle />;
  }
  return <ContentIcon content={{ kind: 'note' }} className={className} />;
}
