import { isTextSelection, type Editor } from '@tiptap/core';

export interface SelectionBubbleMenuSnapshot {
  hasSelection: boolean;
  bold: boolean;
  boldEnabled: boolean;
  italic: boolean;
  italicEnabled: boolean;
  underline: boolean;
  underlineEnabled: boolean;
  strike: boolean;
  strikeEnabled: boolean;
  code: boolean;
  codeEnabled: boolean;
  highlight: boolean;
  linkHref: string;
}

export function hasFormattableTextSelection(editor: Editor): boolean {
  const { doc, selection } = editor.state;

  if (!editor.isEditable || !isTextSelection(selection) || selection.empty) {
    return false;
  }

  if (editor.isActive('codeBlock')) {
    return false;
  }

  return (
    doc.textBetween(selection.from, selection.to, ' ', ' ').trim().length > 0
  );
}

export function getSelectionBubbleMenuSnapshot(editor: Editor): SelectionBubbleMenuSnapshot {
  const canToggle = (mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code') => {
    const chain = editor.can().chain().focus();
    if (mark === 'bold') return chain.toggleBold().run();
    if (mark === 'italic') return chain.toggleItalic().run();
    if (mark === 'underline') return chain.toggleUnderline().run();
    if (mark === 'strike') return chain.toggleStrike().run();
    return chain.toggleCode().run();
  };
  const linkHref = editor.isActive('link')
    ? String(editor.getAttributes('link').href ?? '')
    : '';
  return {
    hasSelection: hasFormattableTextSelection(editor),
    bold: editor.isActive('bold'),
    boldEnabled: canToggle('bold'),
    italic: editor.isActive('italic'),
    italicEnabled: canToggle('italic'),
    underline: editor.isActive('underline'),
    underlineEnabled: canToggle('underline'),
    strike: editor.isActive('strike'),
    strikeEnabled: canToggle('strike'),
    code: editor.isActive('code'),
    codeEnabled: canToggle('code'),
    highlight: editor.isActive('highlight'),
    linkHref,
  };
}

export function sameSelectionBubbleMenuSnapshot(
  left: SelectionBubbleMenuSnapshot,
  right: SelectionBubbleMenuSnapshot,
): boolean {
  return left.hasSelection === right.hasSelection
    && left.bold === right.bold
    && left.boldEnabled === right.boldEnabled
    && left.italic === right.italic
    && left.italicEnabled === right.italicEnabled
    && left.underline === right.underline
    && left.underlineEnabled === right.underlineEnabled
    && left.strike === right.strike
    && left.strikeEnabled === right.strikeEnabled
    && left.code === right.code
    && left.codeEnabled === right.codeEnabled
    && left.highlight === right.highlight
    && left.linkHref === right.linkHref;
}
