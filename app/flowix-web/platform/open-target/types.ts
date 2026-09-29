export interface ExternalMarkdownOpenRequest {
  filePaths: string[];
  destination?: 'main-third' | 'browser-column';
}

export const FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT = 'flowix:external-markdown-open';
