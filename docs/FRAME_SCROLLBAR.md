# Frame scrollbars

Work and Browser host two kinds of cross-origin documents: remote pages
(`<iframe src="https://…">`) and local HTML previews (`asset:`). Neither can be
reached from the host — `contentDocument` throws — so whatever bar the document
paints is its own. And when a document sets `::-webkit-scrollbar { width: 8px }`,
WebKit leaves overlay mode and the bar starts consuming layout width.

## One script, injected into every frame

`flowix-desktop/src/web_frame_scrollbar.js` is registered as a Tauri
initialization script for all frames (`frame_scrollbar.rs`). WebKit and WebView2
run it inside each frame's own document, so it restyles cross-origin content from
the inside without any same-origin access.

Entry conditions — the script is inert everywhere else:

- not the top frame (`window === window.top`) — the app itself is never touched;
- not a nested frame (`window.parent !== window.top`) — embedded widgets and ad
  slots keep their own scrollbars;
- `http:`, `https:` or `asset:` only.

For each scroll container it adopts:

1. the element gets `data-flowix-overlay-scroll`, whose stylesheet sets
   `::-webkit-scrollbar { width: 0 }` and `scrollbar-width: none` — the native
   bar stops taking width and the content reclaims it;
2. a `position: fixed` thumb is painted into a single overlay layer, sized and
   placed from `scrollTop / scrollHeight / clientHeight` (and the horizontal
   equivalents), with the same 6px (macOS) / 9px (other) width and 24px minimum
   length the in-app `OverlayScrollbar` uses;
3. the thumb fades in while scrolling, stays for 700 ms, and is draggable.

Native wheel, keyboard, trackpad and touch scrolling are untouched: no wheel
listener is installed and no `overflow` value is rewritten. Only the bar's
geometry changes.

Containers are adopted once at load — bounded by a 12 ms budget so very large
documents fall through to lazy adoption — and lazily afterwards, which covers SPA
content that appears later. Scrolling is watched through one capturing listener
on `document`, so containers Flowix never predicted still get a thumb.

## Host → frame channel

The frame cannot read the app's CSS variables, so `shared/ui/web-frame-scrollbar.ts`
posts only the palette it needs (`color`, `mac`). The frame asks first
(`flowix:web-frame-scrollbar-ready`); the host re-sends on `load` and on theme
changes. Nothing else crosses the boundary, and the page document is never read.

`enabled: false` in that payload tears the overlay down and restores the native
bar without reloading the frame.

## Verifying

```bash
npx vitest run app/flowix-web/shared/ui/web-frame-scrollbar.test.ts
```

The script is compiled into the binary, so changes need a desktop
rebuild/restart — frontend hot reload cannot replace the initialization script.

## Known limits

- Frames nested inside the page keep native bars by design.
- Documents whose scrolling is driven entirely by script (canvas editors,
  virtualized lists with no native overflow) have no bar to replace.
- A document that pins its layout to `clientWidth` will reflow once, when the
  bar's width is reclaimed. That reflow is the point of the change.
- Same-origin surfaces that inject CSS themselves (plugin artifacts, via
  `iframeScrollbarCss`) still use a narrow native bar; they are not frames the
  initialization script reaches.
