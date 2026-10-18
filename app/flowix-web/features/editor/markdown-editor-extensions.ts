import { Editor, Extension, renderNestedMarkdownContent } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { ListItem } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { AttachmentLink } from '@features/editor/extensions/attachment-link';
import { FlowixHighlight } from '@features/editor/extensions/flowix-text-mark';
import { Tag } from '@features/editor/extensions/tag';
import MarkdownPaste from '@features/editor/extensions/markdown-paste';
import ManagedPasteRules from '@features/editor/extensions/paste-rules';
import { LinkSelectionHighlight, MarkdownLink } from '@features/editor/extensions/markdown-link';
import { NoteReference } from '@features/editor/extensions/note-link';
import { NoteMention, WikiNoteMention } from '@features/editor/extensions/note-mention';
import { TagMention } from '@features/editor/extensions/tag-mention';
import { CodeBlockShikiBase } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki-base';
import { MarkdownEscape, LegacyAdjacentStrongMarkdown } from './markdown-parser-core-extensions';
import { MathBlock } from '@features/editor/extensions/math-block';
import { WebCard } from '@features/editor/extensions/web-card';
import { TableReference } from '@features/multidimensional-table/table-reference-node';
import { MediaLibraryReference } from '@features/media-library/media-library-reference-node';
import { SearchAndReplace } from '@features/editor/extensions/search-replace';
import Frontmatter from '@features/editor/extensions/frontmatter';
import { MenuPinExtension } from '@features/editor/extensions/menu-pin';
import { BlockDragExtension } from '@features/editor/extensions/block-drag';
import { ListTypeShortcuts } from '@features/editor/extensions/list-transforms';
import { SlashMenu } from '@features/editor/extensions/slash-menu';
import { AgentThreadCard } from '@features/agent/thread-card';
import { TabAgentRun } from '@features/editor/extensions/tab-agent-run';
import { TabCharacter } from '@features/editor/extensions/tab-character';
import { tableNeedsHtml } from '@features/editor/extensions/table/flowix-table';
import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import { StableCaret } from '@features/editor/extensions/stable-caret';
import { MarkdownParagraph, MarkdownTaskItem } from './markdown-parser-common-extensions';
import type { WorkspaceHostId } from '@features/workspace/public/host-api';

interface NestedListMarkdownContext {
  parentType?: string;
  index: number;
  meta?: { parentAttrs?: { start?: number } };
}

type MarkdownRenderContext = {
  parentType?: string | null;
  index?: number;
  meta?: {
    parentAttrs?: {
      start?: number;
    };
  };
};

type MarkdownNodeLike = {
  type?: string;
  text?: string;
  content?: unknown;
};

const TABLE_CELL_PARENT_TYPES = new Set(['tableCell', 'tableHeader']);
const LIST_ITEM_PARENT_TYPES = new Set(['listItem', 'taskItem']);
const EMPTY_MARKDOWN_PLACEHOLDER_RE = /&(?:amp;)?nbsp;/gi;
const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';

function stripEmptyMarkdownPlaceholders(value: string): string {
  return value
    .replace(/\u00a0/g, '')
    .replace(EMPTY_MARKDOWN_PLACEHOLDER_RE, '')
    .trim();
}

export function isEmptyMarkdownPlaceholderOnly(value: string): boolean {
  return stripEmptyMarkdownPlaceholders(value) === '';
}

function getParentType(ctx: MarkdownRenderContext): string {
  return ctx.parentType || '';
}

function isTableCellContext(ctx: MarkdownRenderContext): boolean {
  return TABLE_CELL_PARENT_TYPES.has(getParentType(ctx));
}

function isListItemLeadingParagraphContext(ctx: MarkdownRenderContext): boolean {
  return LIST_ITEM_PARENT_TYPES.has(getParentType(ctx)) && ctx.index === 0;
}

function shouldDropEmptyParagraph(ctx: MarkdownRenderContext): boolean {
  return isTableCellContext(ctx) || isListItemLeadingParagraphContext(ctx);
}

function renderEmptyParagraphMarkdown(ctx: MarkdownRenderContext): string {
  return shouldDropEmptyParagraph(ctx) ? '' : EMPTY_PARAGRAPH_MARKDOWN;
}

function isEmptyParagraphPlaceholderTextNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;

  const maybeNode = node as MarkdownNodeLike;
  return maybeNode.type === 'text' &&
    typeof maybeNode.text === 'string' &&
    isEmptyMarkdownPlaceholderOnly(maybeNode.text);
}

function isEmptyParagraphForMarkdown(content: unknown[], ctx: MarkdownRenderContext): boolean {
  if (content.length === 0) return true;
  return shouldDropEmptyParagraph(ctx) && content.every(isEmptyParagraphPlaceholderTextNode);
}

const PreservedParagraph = MarkdownParagraph.extend({
  renderMarkdown(node, h, ctx: MarkdownRenderContext) {
    const content = Array.isArray(node.content) ? node.content : [];
    if (isEmptyParagraphForMarkdown(content, ctx)) {
      return renderEmptyParagraphMarkdown(ctx);
    }

    return h.renderChildren(content);
  },
});

/** Mark name used only while serializing ambiguous bold boundaries. */
const HTMLStrongFallback = Extension.create({
  name: 'htmlStrongFallback',
  renderMarkdown: (node, h) => `<strong>${h.renderChildren(node)}</strong>`,
  markdownOptions: {
    htmlReopen: {
      open: '<strong>',
      close: '</strong>',
    },
  },
});

function isUnicodeLetterOrNumber(value: string | undefined): boolean {
  return !!value && /^[\p{L}\p{N}]$/u.test(value);
}

function isUnicodePunctuation(value: string | undefined): boolean {
  // Marked's delimiter rules treat both Unicode punctuation and symbols as
  // punctuation around a closing `**`. Symbols include currency signs,
  // copyright marks, and emoji, all of which can trigger the same ambiguity.
  return !!value && /^[\p{P}\p{S}]$/u.test(value);
}

function markIsBold(mark: { type?: string }): boolean {
  return mark.type === 'bold' || mark.type === 'htmlStrongFallback';
}

/**
 * CommonMark rejects `**text。**下一句` because the closing delimiter is
 * followed immediately by a letter. Convert only those bold runs to inline
 * HTML, which is standard Markdown and remains portable across parsers.
 */
function markAmbiguousBoldRunsAsHtml(node: JSONContent): JSONContent {
  if (!Array.isArray(node.content)) return node;
  // HTML tables serialize native schema nodes, so Markdown-only marks must
  // never enter their subtrees (including nested tables).
  if (node.type === 'table' && tableNeedsHtml(node)) return node;

  const content = node.content.map(child => markAmbiguousBoldRunsAsHtml(child));
  if (node.type !== 'paragraph' && node.type !== 'heading') {
    return { ...node, content };
  }

  const nextContent = content.map(child => ({ ...child, marks: child.marks ? [...child.marks] : child.marks }));
  let index = 0;
  while (index < nextContent.length) {
    const child = nextContent[index];
    if (child.type !== 'text' || !child.marks?.some(markIsBold)) {
      index += 1;
      continue;
    }

    const runStart = index;
    while (
      index + 1 < nextContent.length
      && nextContent[index + 1].type === 'text'
      && nextContent[index + 1].marks?.some(markIsBold)
    ) {
      index += 1;
    }

    const lastText = nextContent[index].text ?? '';
    const followingText = nextContent[index + 1]?.type === 'text'
      ? nextContent[index + 1].text ?? ''
      : '';
    const lastCharacters = Array.from(lastText);
    const lastCharacter = lastCharacters[lastCharacters.length - 1];
    const followingCharacter = Array.from(followingText)[0];
    const isAmbiguous = isUnicodePunctuation(lastCharacter)
      && isUnicodeLetterOrNumber(followingCharacter);

    if (isAmbiguous) {
      for (let runIndex = runStart; runIndex <= index; runIndex += 1) {
        const marks = nextContent[runIndex].marks ?? [];
        nextContent[runIndex].marks = marks.map(mark => (
          mark.type === 'bold' ? { ...mark, type: 'htmlStrongFallback' } : mark
        ));
      }
    }

    index += 1;
  }

  return { ...node, content: nextContent };
}

export function serializeEditorMarkdown(editor: Editor): string {
  const json = markAmbiguousBoldRunsAsHtml(editor.getJSON());
  return editor.markdown?.serialize(json) ?? editor.getMarkdown();
}

function isEmptyParagraphNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;

  const maybeNode = node as { type?: string; content?: unknown };
  if (maybeNode.type !== 'paragraph') return false;
  if (!Array.isArray(maybeNode.content) || maybeNode.content.length === 0) return true;
  return maybeNode.content.every(isEmptyParagraphPlaceholderTextNode);
}

const PreservedListItem = ListItem.extend({
  renderMarkdown(node, h, ctx) {
    const content = Array.isArray(node.content) ? node.content : [];

    if (content.length === 1 && isEmptyParagraphNode(content[0])) {
      if (ctx?.parentType === 'orderedList') {
        const start = ctx.meta?.parentAttrs?.start || 1;
        return `${start + ctx.index}. ${EMPTY_PARAGRAPH_MARKDOWN}`;
      }

      return '-';
    }

    return renderNestedMarkdownContent(
      node,
      h,
      (context: NestedListMarkdownContext) => {
        if (context.parentType === 'bulletList') {
          return '- ';
        }
        if (context.parentType === 'orderedList') {
          const start = context.meta?.parentAttrs?.start || 1;
          return `${start + context.index}. `;
        }
        return '- ';
      },
      ctx,
    );
  },
});

const PreservedTaskItem = MarkdownTaskItem.extend({
  renderMarkdown(node, h) {
    const checkedChar = node.attrs?.checked ? 'x' : ' ';
    const prefix = `- [${checkedChar}] `;
    const content = Array.isArray(node.content) ? node.content : [];

    if (!isEmptyParagraphNode(content[0])) {
      return renderNestedMarkdownContent(node, h, prefix);
    }

    const nestedContent = content.slice(1);
    let output = nestedContent.length === 0 ? `${prefix}${EMPTY_PARAGRAPH_MARKDOWN}` : prefix;

    nestedContent.forEach((child, index) => {
      const childContent = h.renderChild?.(child, index + 1) ?? h.renderChildren([child]);
      if (childContent === undefined || childContent === null) return;

      const indentedChild = childContent
        .split('\n')
        .map(line => h.indent(line || ''))
        .join('\n');

      output += child.type === 'paragraph' ? `\n\n${indentedChild}` : `\n${indentedChild}`;
    });

    return output;
  },
});

export interface MarkdownEditorExtensionContext {
  ownerPath?: string;
  getOwnerPath: () => string | undefined;
  getAttachmentNotebookId: () => string | undefined;
  propertyTargetId?: string;
  onViewSourceMode?: () => void;
  transitionId?: number | null;
  workspaceHost: WorkspaceHostId;
  getPlaceholder: () => string;
}

/** Full interactive editor registry; parser specs are shared through pure Markdown modules. */
export function createMarkdownEditorExtensions({
  ownerPath,
  getOwnerPath,
  getAttachmentNotebookId,
  propertyTargetId,
  onViewSourceMode,
  transitionId,
  workspaceHost,
  getPlaceholder,
}: MarkdownEditorExtensionContext, codeBlockExtension = CodeBlockShikiBase) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      dropcursor: false,
      gapcursor: false,
      link: false,
      codeBlock: false,
      paragraph: false,
      listItem: false,
    }),
    PreservedParagraph,
    PreservedListItem,
    MarkdownEscape,
    HTMLStrongFallback,
    LegacyAdjacentStrongMarkdown,
    AttachmentLink.configure({ ownerPath, getOwnerPath, getNotebookId: getAttachmentNotebookId }),
    MarkdownLink,
    LinkSelectionHighlight,
    codeBlockExtension.configure({ traceId: transitionId }),
    MathBlock,
    WebCard,
    TableReference,
    MediaLibraryReference,
    FlowixHighlight.configure({ multicolor: true }),
    createTablePlugin(),
    TaskList,
    PreservedTaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    Placeholder.configure({
      showOnlyCurrent: true,
      // Node selections have no text caret, so suppress the placeholder on
      // the empty paragraph immediately before a selected media node.
      placeholder: ({ editor, node, pos }) => {
        const selection = editor.state.selection;
        if (
          selection instanceof NodeSelection &&
          selection.from === pos + node.nodeSize
        ) {
          return '';
        }
        return getPlaceholder();
      },
    }),
    Tag,
    ManagedPasteRules.configure({ ownerPath, getOwnerPath }),
    MarkdownPaste,
    Frontmatter.configure({
      propertyTargetId,
      onViewSourceMode,
      getAttachmentNotebookId,
    }),
    NoteReference,
    NoteMention,
    WikiNoteMention,
    TagMention,
    StableCaret,
    AgentThreadCard.configure({ workspaceHost }),
    SlashMenu,
    TabCharacter,
    TabAgentRun,
    SearchAndReplace,
    MenuPinExtension,
    BlockDragExtension,
    ListTypeShortcuts,
  ];
}
