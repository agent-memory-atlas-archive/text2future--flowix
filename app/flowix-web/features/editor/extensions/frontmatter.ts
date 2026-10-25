import { Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { isValidBlockGap } from './block-gap-cursor';
import { FrontmatterPropertyNodeView } from '@features/editor/extensions/frontmatter-node-view';
import { updateVisibleFrontmatterProperty } from '@features/document/properties/frontmatter-model';
import { resolvePropertyPreset } from '@features/document/properties/presets';
import { getPropertyPresets } from '@features/properties/public-api';
import { frontmatterMarkdownSpec } from './frontmatter-markdown';

const Frontmatter = Node.create({
  name: 'frontmatter',
  priority: 1000,
  group: 'block',
  defining: true,
  selectable: false,
  draggable: false,
  content: '',

  addOptions() {
    return {
      propertyTargetId: undefined as string | undefined,
      onPropertyAreaHoverChange: undefined as ((hovered: boolean) => void) | undefined,
      onViewSourceMode: undefined as (() => void) | undefined,
      getAttachmentNotebookId: undefined as (() => string | undefined) | undefined,
    };
  },

  addAttributes() {
    return {
      yamlContent: {
        default: '',
        rendered: false,
      },
    };
  },

  addNodeView() {
    return ({ node, view, getPos }) => new FrontmatterPropertyNodeView(
      node,
      view,
      getPos,
      this.options.propertyTargetId,
      this.options.onViewSourceMode,
      this.options.getAttachmentNotebookId,
      this.options.onPropertyAreaHoverChange,
    );
  },

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => selectEditableDocumentContent(this.editor),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('frontmatter-add-first-property'),
        view: (view) => {
          const handleAddProperty = (event: Event) => {
            const detail = (event as CustomEvent<{ propertyTargetId?: string; presetKey?: string }>).detail;
            if (!this.options.propertyTargetId || detail?.propertyTargetId !== this.options.propertyTargetId || !view.editable) return;
            if (view.state.doc.firstChild?.type.name === this.name) return;
            if (!detail?.presetKey) return;
            const preset = resolvePropertyPreset(detail.presetKey, getPropertyPresets());
            if (!preset) return;
            const yamlContent = updateVisibleFrontmatterProperty('', null, preset.key, '', preset.kind);
            view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.frontmatter.create({ yamlContent })));
          };
          window.addEventListener('flowix:add-property', handleAddProperty);
          return { destroy: () => window.removeEventListener('flowix:add-property', handleAddProperty) };
        },
      }),
      new Plugin({
        key: new PluginKey('frontmatter-protection'),
        appendTransaction: (_transactions, _oldState, newState) => {
          const firstNode = newState.doc.firstChild;
          if (firstNode?.type.name !== this.name) return null;
          const selection = newState.selection;
          if (selection instanceof GapCursor && selection.from < firstNode.nodeSize) {
            // Properties are a protected prefix, not a body insertion boundary.
            // Keep a collapsed cursor at the body start rather than selecting
            // the whole body through the select-all recovery path below.
            const $bodyStart = newState.doc.resolve(firstNode.nodeSize);
            return newState.tr.setSelection(isValidBlockGap($bodyStart)
              ? new GapCursor($bodyStart)
              : Selection.near($bodyStart, 1));
          }
          if (!selectionIncludesFrontmatter(selection, firstNode.nodeSize)) return null;

          return newState.tr.setSelection(
            createSelectionAfterFrontmatter(newState.doc, firstNode.nodeSize),
          );
        },
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged) return true;
          const currentFirstNode = state.doc.firstChild;
          if (currentFirstNode?.type.name !== this.name) return true;
          return transaction.doc.firstChild?.type.name === this.name;
        },
      }),
    ];
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="frontmatter"]',
      getAttrs: (dom) => ({
        yamlContent: (dom as HTMLElement).getAttribute('data-yaml-content') ?? '',
      }),
    }];
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        'data-type': 'frontmatter',
        'data-yaml-content': String(node.attrs.yamlContent ?? ''),
      },
    ];
  },

  ...frontmatterMarkdownSpec,

  renderMarkdown(node) {
    return `---\n${String(node.attrs?.yamlContent ?? '')}\n---\n`;
  },
});

/**
 * Select the user-editable document body while keeping the protected YAML
 * frontmatter outside the selection. Documents without frontmatter use the
 * editor's regular select-all command.
 */
export function selectEditableDocumentContent(editor: Editor): boolean {
  const { state, view } = editor;
  const firstNode = state.doc.firstChild;
  if (firstNode?.type.name !== Frontmatter.name) {
    return editor.commands.selectAll();
  }

  view.dispatch(
    state.tr
      .setSelection(createSelectionAfterFrontmatter(state.doc, firstNode.nodeSize)),
  );
  return true;
}

function selectionIncludesFrontmatter(selection: Selection, frontmatterEnd: number) {
  return (
    selection instanceof AllSelection
    || (!selection.empty && selection.from < frontmatterEnd && selection.to > 0)
  );
}

function createSelectionAfterFrontmatter(doc: ProseMirrorNode, frontmatterEnd: number) {
  const to = doc.content.size;
  const $from = doc.resolve(Math.min(frontmatterEnd, to));
  const $to = doc.resolve(to);
  return frontmatterEnd < to
    ? TextSelection.between($from, $to, 1)
    : TextSelection.near($to, -1);
}

export default Frontmatter;
