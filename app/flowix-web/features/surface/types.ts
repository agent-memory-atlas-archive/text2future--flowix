import type { ComponentProps } from 'react';
import type { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import type { DocumentContainer } from '@features/document/components/document-container';
import type {
  PluginDocumentViewProps,
  PluginWorkbenchProps,
} from '@features/plugin/public/surface-api';
import type { PluginArtifactRendererId } from '@features/plugin/plugin-note';
import type { MemoItem } from '@/types/memo-item';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { WorkColumnNavigationState } from '@features/workspace/store/work-column-target';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';

export type WorkColumnSurfaceCapability =
  | 'edit'
  | 'search'
  | 'memo-colors'
  | 'properties'
  | 'copy-content'
  | 'export-content'
  | 'save-template'
  | 'version-history'
  | 'fit'
  | 'zoom'
  | 'fullscreen'
  | 'open-source'
  | 'run-agent'
  | 'stream-conversation';

/** Visual chrome owned by the currently mounted surface. */
export type WorkColumnSurfaceChrome = 'document' | 'agent' | 'media';

export type WorkColumnEmptyReason =
  | 'no-target'
  | 'stale-context'
  | 'invalid-target'
  | 'invalid-artifact';

export type WorkColumnEmptyStateTone = 'document' | 'agent';

interface SurfaceBase {
  instanceKey: string;
}

interface FileSurfaceBase extends SurfaceBase {
  /** Runtime identity shared by every open surface showing the same local file. */
  fileIdentity: FileDisplayIdentity;
}

export type ExternalDocumentProps = Omit<ComponentProps<typeof DocumentContainer>, 'isExternalDocument' | 'fileIdentity'> & {
  isExternalDocument: true;
};

export interface NoteSurface extends FileSurfaceBase {
  kind: 'note';
  memoId: string;
  props: Omit<ComponentProps<typeof DocumentContainer>, 'isExternalDocument' | 'memoId' | 'fileIdentity'> & {
    isExternalDocument?: false;
  };
}

/** Markdown files opened as external documents, outside the memo model. */
export interface MDSurface extends FileSurfaceBase {
  kind: 'md';
  props: ExternalDocumentProps;
}

/** Plain-text/code documents opened from outside the notebook memo model. */
export interface CodeSurface extends FileSurfaceBase {
  kind: 'code';
  props: ExternalDocumentProps;
}

export interface ImageFileSurface extends FileSurfaceBase {
  kind: 'image-file';
  scopePath: string | null;
  props: ExternalDocumentProps;
}

export interface VideoFileSurface extends FileSurfaceBase {
  kind: 'video-file';
  scopePath: string | null;
  props: ExternalDocumentProps;
}

export interface HtmlFileSurface extends FileSurfaceBase {
  kind: 'html-file';
  scopePath: string | null;
  props: ExternalDocumentProps;
}

export interface UnavailableFileSurface extends FileSurfaceBase {
  kind: 'unavailable-file';
  props: ExternalDocumentProps;
}

export interface MediaResourceSurface extends FileSurfaceBase {
  kind: 'media';
  notebookId: string | null;
  notebookPath: string | null;
  resourceKind: 'image' | 'video';
}

export interface PluginArtifactSurfaceBase extends SurfaceBase {
  props: PluginDocumentViewProps;
  renderer: PluginArtifactRendererId | null;
}

export interface MindmapSurface extends PluginArtifactSurfaceBase {
  kind: 'mindmap';
  renderer: 'markmap';
}

export interface HtmlSurface extends PluginArtifactSurfaceBase {
  kind: 'html';
  renderer: 'html' | 'webpage';
}

export interface JsonSurface extends PluginArtifactSurfaceBase {
  kind: 'json';
  renderer: 'json-viewer';
}

export interface TextSurface extends PluginArtifactSurfaceBase {
  kind: 'text';
  renderer: 'text' | 'markdown';
}

export interface PluginArtifactSurface extends PluginArtifactSurfaceBase {
  kind: 'plugin-artifact';
}

export interface AgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: ComponentProps<typeof AgentConversationDetail>['instanceId'];
}

export interface PluginWorkbenchSurface extends SurfaceBase {
  kind: 'plugin-workbench';
  props: PluginWorkbenchProps;
}

export interface WebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
}

export type WorkColumnSurface =
  | NoteSurface
  | MDSurface
  | CodeSurface
  | ImageFileSurface
  | VideoFileSurface
  | HtmlFileSurface
  | UnavailableFileSurface
  | MediaResourceSurface
  | MindmapSurface
  | HtmlSurface
  | JsonSurface
  | TextSurface
  | PluginArtifactSurface
  | AgentConversationSurface
  | PluginWorkbenchSurface
  | WebSurface;

export type WorkColumnSurfaceKind = WorkColumnSurface['kind'];

export type WorkColumnContentPresentation =
  | {
      status: 'surface';
      surface: WorkColumnSurface;
    }
  | {
      status: 'empty';
      reason: WorkColumnEmptyReason;
      tone: WorkColumnEmptyStateTone;
      message: string;
    };

export type DocumentSurfaceIdentity =
  | {
      kind: 'memo';
      memoId: string;
      fileIdentity: FileDisplayIdentity;
      notebookId: string | null;
      notebookPath: string | null;
      transitionId: number | null;
    }
  | {
      kind: 'external';
      fileIdentity: FileDisplayIdentity;
      scopePath: string | null;
      transitionId: number | null;
    };

/** A document session contributes the surface matching its business identity. */
export type DocumentSurfaceContext =
  | {
      /** Identity captured from the document session, independent of props. */
      identity: Extract<DocumentSurfaceIdentity, { kind: 'memo' }>;
      memo: MemoItem | null;
      surface: NoteSurface;
    }
  | {
      /** Identity captured from the document session, independent of props. */
      identity: Extract<DocumentSurfaceIdentity, { kind: 'external' }>;
      instanceKey: string;
      memo: null;
      documentProps: ExternalDocumentProps;
    };

export interface PluginWorkbenchContext {
  plugin: PluginDescriptor;
  notebookPath: string | undefined;
  currentNotePath: string | null;
  currentNoteContent: string;
}

export interface ResolveWorkColumnContentInput {
  navigation: WorkColumnNavigationState;
  document?: DocumentSurfaceContext | null;
  pluginWorkbench?: PluginWorkbenchContext | null;
  emptyMessage: string;
}
