import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";
import folderOutlineSvg from "@/assets/folder-outline.svg?raw";
import {
  createInlineAtomCloseIcon,
  createInlineAtomNodeView,
  deleteInlineAtomNode,
  deleteAdjacentInlineAtom,
} from "@features/editor/extensions/shared/inline-atom-nodeview";

export interface ComposerFolderTokenValue {
  path: string;
  displayName?: string;
}

const FOLDER_HREF_PREFIX = "flowix://folder/";
const FOLDER_TOKEN_RE = /^\[([^\]\n]*)\]\(flowix:\/\/folder\/([^\s)]+)\)/i;
const FOLDER_TOKEN_GLOBAL_RE = /\[([^\]\n]*)\]\(flowix:\/\/folder\/([^\s)]+)\)/gi;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function encodePathSegments(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** Convert a repository path into a Markdown-safe absolute file URL. */
function toAbsoluteFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${encodeURIComponent(host)}/${encodePathSegments(segments.join("/"))}`;
  }
  const windowsDrive = /^([a-z]):\/(.*)$/i.exec(normalized);
  if (windowsDrive) {
    return `file:///${windowsDrive[1].toUpperCase()}:/${encodePathSegments(windowsDrive[2])}`;
  }
  const absolutePath = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodePathSegments(absolutePath)}`;
}

function folderDisplayName(path: string, displayName?: string | null): string {
  const explicit = displayName?.trim();
  if (explicit) return explicit;
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || path;
}

export const ComposerFolderToken = Node.create({
  name: "composerFolderToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: "" },
      displayName: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-folder]", getAttrs: (dom) => ({
      path: (dom as HTMLElement).getAttribute("data-composer-folder") ?? "",
      displayName: (dom as HTMLElement).getAttribute("data-composer-folder-display-name") || null,
    }) }];
  },

  renderHTML({ node }) {
    const path = String(node.attrs?.path ?? "");
    const displayName = folderDisplayName(
      path,
      typeof node.attrs?.displayName === "string" ? node.attrs.displayName : undefined,
    );
    return ["span", {
      "data-composer-folder": path,
      "data-composer-folder-display-name": displayName,
      class: "agent-composer__folder-token",
    }, `@${displayName}`];
  },

  markdownTokenizer: {
    name: "composerFolderToken",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf(`(${FOLDER_HREF_PREFIX}`);
      return index >= 0 ? Math.max(0, src.lastIndexOf("[", index)) : -1;
    },
    tokenize(src: string) {
      const match = FOLDER_TOKEN_RE.exec(src);
      return match ? {
        type: "composerFolderToken",
        raw: match[0],
        text: match[1],
        href: `${FOLDER_HREF_PREFIX}${match[2]}`,
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const encodedPath = href.slice(FOLDER_HREF_PREFIX.length);
    return {
      type: "composerFolderToken",
      attrs: {
        path: safeDecode(encodedPath),
        displayName: String(token.text ?? "").replace(/^@/, "").trim() || null,
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    const path = String(node.attrs?.path ?? "").trim();
    if (!path) return "";
    const displayName = folderDisplayName(
      path,
      typeof node.attrs?.displayName === "string" ? node.attrs.displayName : undefined,
    );
    return `[${escapeMarkdownLinkText(`@${displayName}`)}](${FOLDER_HREF_PREFIX}${encodeURIComponent(path)})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      const path = String(node.attrs.path ?? "");
      const displayName = folderDisplayName(
        path,
        typeof node.attrs.displayName === "string" ? node.attrs.displayName : undefined,
      );
      const iconTemplate = document.createElement("template");
      iconTemplate.innerHTML = folderOutlineSvg;
      const folderIcon = iconTemplate.content.firstElementChild;
      folderIcon?.classList.add("agent-composer__folder-token-icon");
      const nodeView = createInlineAtomNodeView({
        caretGeometry: 'single-line',
        wrapperClassName: "agent-composer__inline-atom-wrapper agent-composer__folder-token-wrapper",
        cardClassName: "agent-composer__folder-token",
        leadingIcon: folderIcon ?? undefined,
        label: displayName,
        labelClassName: "agent-composer__folder-token-label",
        title: path,
        hoverActions: [{
          ariaLabel: `移除资料库 ${displayName}`,
          icon: createInlineAtomCloseIcon(),
          onClick: () => deleteInlineAtomNode(
            view,
            node,
            () => typeof getPos === "function" ? getPos() : undefined,
          ),
        }],
      });
      nodeView.dom.setAttribute("data-composer-folder", path);
      nodeView.dom.setAttribute("data-composer-folder-display-name", displayName);
      return nodeView;
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteAdjacentInlineAtom(this.editor, "composerFolderToken", "before"),
      Delete: () => deleteAdjacentInlineAtom(this.editor, "composerFolderToken", "after"),
    };
  },
});

export function insertComposerFolderToken(
  editor: Editor,
  path: string,
  displayName?: string,
  range?: { from: number; to: number },
): void {
  const { selection } = editor.state;
  const target = range ?? { from: selection.from, to: selection.to };
  editor.chain()
    .focus()
    .insertContentAt({ from: target.from, to: target.to }, [
      { type: "composerFolderToken", attrs: { path, displayName: displayName || null } },
      { type: "text", text: " " },
    ])
    .run();
}

/** Convert persisted folder cards to absolute-path Markdown links for the agent. */
export function composerFolderMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    FOLDER_TOKEN_GLOBAL_RE,
    (_match, displayName: string, encodedPath: string) => {
      const path = safeDecode(encodedPath);
      const label = folderDisplayName(path, displayName.replace(/^@/, ""));
      return `[${escapeMarkdownLinkText(`@${label}`)}](${toAbsoluteFileUrl(path)})`;
    },
  );
}
