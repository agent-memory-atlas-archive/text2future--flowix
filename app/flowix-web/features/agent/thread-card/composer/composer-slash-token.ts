import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, type EditorState } from "@tiptap/pm/state";
import skillLibraryIconSvg from "@/assets/skill-library.svg?raw";
import type { AgentTypeKey } from "@/types/agent";
import { loadLanguage, translate } from "@/lib/i18n";
import {
  getCurrentAppLanguage,
  subscribeAppLanguage,
} from "@features/preferences/public/runtime-api";
import {
  createInlineAtomCloseIcon,
  createInlineAtomNodeView,
  deleteInlineAtomNode,
  deleteAdjacentInlineAtom,
} from "@features/editor/extensions/shared/inline-atom-nodeview";
import { createTerminalInlineAtomCaretDecorations } from "@features/editor/extensions/shared/terminal-inline-atom-caret";

export interface ComposerSlashTokenOptions {
  onRemove?: () => void;
}

export interface ComposerSlashTokenValue {
  command: string;
  agentType?: AgentTypeKey;
}

const SLASH_TOKEN_RE = /^\[((?:\\.|[^\]\n])*)\]\(flowix:\/\/slash\/(?:(dsh|deepseek-harness|codex|pi)\/)?([a-z0-9._:-]+)\)/i;
const SLASH_TOKEN_GLOBAL_RE = /\[((?:\\.|[^\]\n])*)\]\(flowix:\/\/slash\/(?:(dsh|deepseek-harness|codex|pi)\/)?([a-z0-9._:-]+)\)/gi;
const LEGACY_DSH_COMMANDS = new Set([
  "compact",
  "skill",
  "goal",
  "plan",
  "export",
  "model",
]);

const CONTROL_COMMANDS = new Set(["goal", "plan"]);

function isControlCommand(command: string): boolean {
  return CONTROL_COMMANDS.has(command.trim().toLowerCase());
}

function isPiSkillCommand(command: string, agentType: string): boolean {
  return agentType === "pi" && command.toLowerCase().startsWith("skill:");
}

function piSkillName(command: string): string {
  return command.slice("skill:".length);
}

function escapeSlashTokenLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function unescapeSlashTokenLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, "$1");
}

function findSlashTokenStart(src: string, hrefIndex: number): number {
  let start = src.lastIndexOf("[", hrefIndex);
  while (start >= 0) {
    let escapeCount = 0;
    for (let index = start - 1; index >= 0 && src[index] === "\\"; index -= 1) {
      escapeCount += 1;
    }
    if (escapeCount % 2 === 0) return start;
    start = src.lastIndexOf("[", start - 1);
  }
  return -1;
}

function slashTokenClass(command: string): string {
  return isControlCommand(command)
    ? "agent-thread-card__slash-token agent-thread-card__slash-token--control"
    : "agent-thread-card__slash-token";
}

function slashTokenLabel(command: string): string {
  const normalized = command.trim().toLowerCase();
  if (normalized === "plan") {
    return translate(getCurrentAppLanguage(), "editor.threadCard.composer.planMode");
  }
  if (normalized === "goal") {
    return translate(getCurrentAppLanguage(), "editor.threadCard.composer.longTask");
  }
  return `/${command}`;
}

export function createSkillLibraryIcon(): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = skillLibraryIconSvg;
  return template.content.firstElementChild as SVGSVGElement;
}

export const ComposerSlashToken = Node.create<ComposerSlashTokenOptions>({
  name: "composerSlashToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() { return { onRemove: undefined }; },
  addAttributes() {
    return {
      command: { default: "" },
      agentType: { default: null },
      displayName: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-slash]", getAttrs: (dom) => ({
      command: (dom as HTMLElement).getAttribute("data-composer-slash") ?? "",
      agentType: (dom as HTMLElement).getAttribute("data-composer-slash-agent") || null,
      displayName: (dom as HTMLElement).getAttribute("data-composer-slash-display-name") || null,
    }) }];
  },

  renderHTML({ node }) {
    const command = String(node.attrs?.command ?? "");
    const agentType = String(node.attrs?.agentType ?? "");
    return ["span", {
      "data-composer-slash": command,
      ...(agentType ? { "data-composer-slash-agent": agentType } : {}),
      ...(node.attrs?.displayName
        ? { "data-composer-slash-display-name": String(node.attrs.displayName) }
        : {}),
      class: "agent-thread-card__slash-token-wrapper",
    }, ["button", {
      class: slashTokenClass(command),
      type: "button",
    }, `/${command}`], "\u200B"];
  },

  markdownTokenizer: {
    name: "composerSlashToken",
    level: "inline" as const,
    start(src: string) {
      const hrefIndex = src.indexOf("flowix://slash/");
      return hrefIndex >= 0 ? findSlashTokenStart(src, hrefIndex) : -1;
    },
    tokenize(src: string) {
      const match = SLASH_TOKEN_RE.exec(src);
      return match ? {
        type: "composerSlashToken",
        raw: match[0],
        href: `flowix://slash/${match[2] ? `${match[2]}/` : ""}${match[3]}`,
        text: match[1],
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const path = href.replace(/^flowix:\/\/slash\//i, "");
    const parts = path.split("/");
    const scope = parts[0] === "deepseek-harness" ? "dsh" : parts[0];
    const agentType = scope === "dsh" || scope === "codex" || scope === "pi"
      ? scope
      : undefined;
    const command = (agentType ? parts[1] : parts[0]) ||
      String(token.text ?? "").replace(/^\//, "");
    const label = unescapeSlashTokenLabel(String(token.text ?? "").trim());
    const isPiSkill = agentType === "pi" && command.toLowerCase().startsWith("skill:");
    const displayName = isPiSkill && label !== `/${command}` ? label || null : null;
    return { type: "composerSlashToken", attrs: { command, agentType, displayName } };
  },

  renderMarkdown(node: JSONContent) {
    const command = String(node.attrs?.command ?? "");
    const agentType = String(node.attrs?.agentType ?? "");
    const displayName = String(node.attrs?.displayName ?? "").trim();
    const label = isPiSkillCommand(command, agentType)
      ? displayName || piSkillName(command)
      : `/${command}`;
    return `[${escapeSlashTokenLabel(label)}](flowix://slash/${agentType ? `${agentType}/` : ""}${command})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      const command = String(node.attrs.command ?? "");
      const agentType = String(node.attrs.agentType ?? "");
      const displayName = String(node.attrs.displayName ?? "").trim();
      const piSkill = isPiSkillCommand(command, agentType);
      const skillLabel = displayName || piSkillName(command);
      const nodeView = createInlineAtomNodeView({
        caretGeometry: 'single-line',
        wrapperClassName: "agent-composer__inline-atom-wrapper agent-thread-card__slash-token-wrapper",
        cardClassName: piSkill
          ? "agent-composer__skill-token"
          : slashTokenClass(command),
        ...(piSkill
          ? {
            leadingIcon: createSkillLibraryIcon(),
            labelClassName: "agent-composer__skill-token-label",
          }
          : {}),
        label: piSkill ? skillLabel : slashTokenLabel(command),
        title: `/${command}`,
        ariaLabel: piSkill ? `Skill ${skillLabel}` : `/${command} 命令`,
        hoverActions: [{
          ariaLabel: piSkill ? `移除 Skill ${skillLabel}` : `移除 /${command} 命令`,
          icon: createInlineAtomCloseIcon(),
          onClick: () => deleteInlineAtomNode(
            view,
            node,
            () => typeof getPos === "function" ? getPos() : undefined,
          ),
        }],
        stopEvent: (event) => !event.type.startsWith("composition"),
      });
      const wrapper = nodeView.dom;
      const button = wrapper.querySelector<HTMLButtonElement>(".agent-thread-card__slash-token");
      const updateLocalizedLabel = () => {
        if (button) button.textContent = slashTokenLabel(command);
      };
      const refreshLabelForCurrentLanguage = () => {
        void loadLanguage(getCurrentAppLanguage()).then(updateLocalizedLabel, updateLocalizedLabel);
      };
      const unsubscribeLanguage = piSkill
        ? () => undefined
        : (() => {
          refreshLabelForCurrentLanguage();
          return subscribeAppLanguage(refreshLabelForCurrentLanguage);
        })();
      wrapper.setAttribute("data-composer-slash", String(node.attrs.command ?? ""));
      if (agentType) wrapper.setAttribute("data-composer-slash-agent", agentType);
      if (displayName) wrapper.setAttribute("data-composer-slash-display-name", displayName);

      return {
        ...nodeView,
        contentDOM: null,
        destroy: unsubscribeLanguage,
      };
    };
  },

  onCreate() {
    const tr = removeHardBreaksAroundComposerSlashTokens(this.editor.state);
    if (tr?.docChanged) this.editor.view.dispatch(tr);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => createTerminalInlineAtomCaretDecorations(
            state.doc,
            "composerSlashToken",
          ),
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return removeHardBreaksAroundComposerSlashTokens(newState);
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteAdjacentInlineAtom(this.editor, "composerSlashToken", "before"),
      Delete: () => deleteAdjacentInlineAtom(this.editor, "composerSlashToken", "after"),
    };
  },
});

function removeHardBreaksAroundComposerSlashTokens(state: EditorState) {
  const deletions: Array<{ from: number; to: number }> = [];
  const seen = new Set<string>();

  const pushDeletion = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    deletions.push({ from, to });
  };

  state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.type.name !== "composerSlashToken") return;

    const $pos = state.doc.resolve(pos);
    if ($pos.nodeBefore?.type.name === "hardBreak") {
      pushDeletion(pos - $pos.nodeBefore.nodeSize, pos);
    }

    const afterPos = pos + node.nodeSize;
    const $after = state.doc.resolve(afterPos);
    if ($after.nodeAfter?.type.name === "hardBreak") {
      pushDeletion(afterPos, afterPos + $after.nodeAfter.nodeSize);
    }
  });

  if (deletions.length === 0) return null;

  const tr = state.tr;
  deletions.reverse().forEach(({ from, to }) => tr.delete(from, to));
  return tr;
}

export function getComposerSlashToken(editor: Editor): ComposerSlashTokenValue | null {
  let value: ComposerSlashTokenValue | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composerSlashToken" && value === null) {
      const agentType = String(node.attrs.agentType ?? "").trim();
      value = {
        command: String(node.attrs.command ?? ""),
        ...(agentType ? { agentType: agentType as AgentTypeKey } : {}),
      };
      return false;
    }
    return value === null;
  });
  return value;
}

export function insertComposerSlashToken(
  editor: Editor,
  command: string,
  agentType?: AgentTypeKey,
  displayName?: string,
): void {
  const { selection } = editor.state;
  editor.chain().focus().deleteRange({ from: 1, to: selection.to })
    .insertContent([
      {
        type: "composerSlashToken",
        attrs: { command, agentType: agentType ?? null, displayName: displayName ?? null },
      },
      { type: "text", text: " " },
    ]).run();
}

/** Convert persisted slash chips back into the provider command/prompt line. */
export function composerSlashMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    SLASH_TOKEN_GLOBAL_RE,
    (match, _label: string, scopedAgent: string | undefined, command: string, offset: number, source: string) => {
      // Unscoped chips are legacy data. Preserve old DSH drafts while keeping
      // the product-only permission chips UI-only as before.
      if (
        scopedAgent &&
        scopedAgent.toLowerCase() !== "dsh" &&
        scopedAgent.toLowerCase() !== "deepseek-harness" &&
        scopedAgent.toLowerCase() !== "codex" &&
        scopedAgent.toLowerCase() !== "pi" ||
        (!scopedAgent && !LEGACY_DSH_COMMANDS.has(command.toLowerCase()))
      ) {
        return "";
      }
      const after = source.slice(offset + match.length);
      // A chip is an atom, so text typed immediately after it needs the
      // separator that the native DSH command parser expects.
      return `/${command}${after && !/^\s/u.test(after) ? " " : ""}`;
    },
  );
}

export function removeComposerSlashToken(editor: Editor): void {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === "composerSlashToken") {
      found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return found === null;
  });
  if (!found) return;
  const range = found as { from: number; to: number };
  editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
}
