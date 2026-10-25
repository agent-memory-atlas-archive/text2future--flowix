import { Globe, MessageCirclePlus } from 'lucide-react';
import { ContentIcon, classifyFileContent } from '@features/content/public/content-api';
import { AgentIcon } from '@features/agent/public/shell-api';
import { NotebookNoteIcon } from '@features/memo/public/shell-api';
import type { BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import type { AgentTypeKey } from '@/types/agent';

const MAX_INLINE_ICON_LENGTH = 64 * 1024;

function contentIconImageSource(icon: string | null): string | null {
  if (!icon) return null;
  if (/^https?:\/\//i.test(icon)) return icon;
  if (icon.length <= MAX_INLINE_ICON_LENGTH
    && /^data:image\/(?:svg\+xml|png|jpe?g|gif|webp|avif)(?:;[^,]*)?,/i.test(icon)) return icon;
  return null;
}

export function BrowserContentIcon({ entry, agentTypeKey, noteIcon }: {
  entry: BrowserColumnEntry;
  agentTypeKey?: AgentTypeKey;
  noteIcon?: string | null;
}) {
  if (entry.target.kind === 'agent_conversation') {
    return agentTypeKey ? <AgentIcon typeKey={agentTypeKey} alt="" className="h-3.5 w-3.5" /> : <MessageCirclePlus className="h-3.5 w-3.5" />;
  }
  if (entry.target.kind === 'web') {
    const imageSource = contentIconImageSource(entry.icon);
    return imageSource ? (
      <span className="relative flex h-4 w-4 items-center justify-center">
        <Globe className="h-3.5 w-3.5" />
        <img
          src={imageSource}
          alt=""
          className="absolute h-3.5 w-3.5 rounded-sm"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      </span>
    ) : <Globe className="h-3.5 w-3.5" />;
  }
  if (entry.target.kind === 'media') {
    return <ContentIcon content={{ kind: 'file', path: entry.target.filePath }} className="h-3.5 w-3.5 opacity-100" />;
  }
  if (entry.target.kind === 'folder-collection') {
    return <ContentIcon content={{ kind: 'folder' }} className="h-3.5 w-3.5 opacity-100" />;
  }
  if (entry.target.kind === 'file-browser') {
    if (entry.target.collectionType === 'table') {
      return <ContentIcon content={{ kind: 'multidimensional-table' }} className="h-3.5 w-3.5 opacity-100" />;
    }
    if (entry.target.collectionType === 'media_library') {
      return <ContentIcon content={{ kind: 'media-library' }} className="h-3.5 w-3.5 opacity-100" />;
    }
    const path = entry.target.activeFilePath;
    if (!path) return <ContentIcon content={{ kind: 'folder' }} className="h-3.5 w-3.5 opacity-100" />;
    if (classifyFileContent(path) === 'note') {
      return <NotebookNoteIcon icon={noteIcon ?? null} className="h-3.5 w-3.5 opacity-100" />;
    }
    return <ContentIcon content={{ kind: 'file', path }} className="h-3.5 w-3.5 opacity-100" />;
  }
  return <ContentIcon content={{ kind: 'web' }} className="h-3.5 w-3.5 opacity-100" />;
}

