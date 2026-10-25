# Agent style ownership

`../agent-conversation.css` is the stylesheet entry point for all Agent UI.

- `surface.css` defines product typography and shared content-column tokens on
  `.agent-conversation-surface`. Theme tokens remain shared with the product.
- `../agent-thread-card/chrome.css` owns the inline card and fullscreen frame.
  `controls.css` owns card controls and standalone/fullscreen message layout.
- `../agent-thread-card/messages.css` and `markdown.css` own message content and
  empty states. `composer.css` owns the input, reference chips and remove actions.
- Standalone conversations use `.agent-conversation-detail`; fullscreen cards
  use `.agent-thread-card--fullscreen`. Both use the expanded composer. Embedded
  cards use the compact composer. These modes change layout, not chip rendering.
- `../agent-thread-card/editor-host.css` is the only stylesheet that may depend
  on the outer document editor. It handles placement of the Agent NodeView itself.
- Composer geometry tokens (`--atc-send-size`, `--atc-bottom-pad`,
  `--atc-composer-max-h`) live on `.agent-conversation-surface`, not on
  `.agent-thread-card`. A composer must never depend on having a card ancestor.
  Card-only tokens (`--atc-min-height`, `--atc-max-height`, `--atc-header-h`)
  stay in `chrome.css`.
- Every selector in this tree must be namespaced with `agent-`. Sibling
  namespaces (`media-*`, `pi-model-picker*`) belong to their own stylesheet or
  must be prefixed.

Portaled panels (slash menu, note picker, attachment image preview, note
reference preview, model pickers) are appended to `document.body` and therefore
cannot rely on `.agent-conversation-surface` as an ancestor. Rules for them:

- They still belong here, in the Agent stylesheet entry — never in `editor.css`.
  Loading `agent-conversation.css` alone must be enough to render Agent UI.
- They may only consume theme tokens (`--border`, `--input-bg`, `--muted`…), not
  surface-scoped custom properties such as `--agent-content-max-width`.
- They must be explicitly namespaced (`agent-composer__*`, `agent-*`) because
  they sit outside the surface subtree.

Agent UI must not require a `.markdown-editor` ancestor. Standalone conversations
must not add that class to obtain layout or typography.

Document-owned selectors must exclude `.agent-conversation-surface` and all its
children on their **target element**, using this zero-specificity boundary:

```css
.markdown-editor .tiptap p:where(:not(.agent-conversation-surface, .agent-conversation-surface *)) {
  /* Document paragraph styles. */
}
```

An exclusion on the ancestor `.tiptap` does not protect a nested composer: the
outer document's `.tiptap` can still satisfy that selector. Inherited properties
such as font, line height and text alignment are owned by `surface.css` instead.

Run `npm run check:agent-style-boundaries` after changing document/Agent styling.
It checks CSS ownership and uses Chromium to compare the three surfaces while
changing the outer editor's typography, including reference/remove controls and
expanded content widths. Use `--fixture-only` to inspect the fixture in WKWebView
or another browser; this is CSS scoping, not Shadow DOM isolation.

The static half of that check enforces the rules above so they cannot rot:

- every document-owned rule carries the target-element exclusion;
- no Agent stylesheet depends on `.markdown-editor`;
- every selector in this tree is namespaced with `agent-` (a bare `media-*` or
  `pi-model-picker*` selector fails the check — move it out or prefix it);
- the surface root tokens are declared on `.agent-conversation-surface` in
  `surface.css` and nowhere else;
- every `var(--agent-*)` / `var(--atc-*)` consumed here is declared by Agent CSS,
  a theme file, or the explicit JS-provided list in the script.
