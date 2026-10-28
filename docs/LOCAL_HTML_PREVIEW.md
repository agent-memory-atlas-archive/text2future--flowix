# Local HTML preview lifecycle

Local HTML uses the existing Tauri asset protocol. Keeping the original URL preserves relative styles, scripts, images and links without rewriting user HTML. The desktop CSP explicitly allows `asset:` frames on macOS; Windows asset origins use HTTP(S).

## Ownership and readiness

- `HtmlResourceView` keys each file/scope session. Explicit retries replace only that preview attempt; selecting an already selected Preview mode is idempotent. The titlebar More menu uses the shared per-host document mode store for Source/Preview; HTML has no floating mode toolbar.
- `useLocalHtmlPreview` first reads the entry through the existing authorized external-document API. Missing, unreadable or unauthorized files never mount an asset iframe. This read also provides preview text and character metrics, without mounting a hidden code editor.
- Once the file read succeeds, the main document transition finishes. Work/Browser use background loading while the preview owns its local progress and recovery controls. The toolbar remains available during loading and failures.
- The native `local-html-preview` plugin installs a document-start observer in local asset subframes. It reports `readyState === interactive` before deferred scripts and images finish. It also answers parent probes, covering notification/listener timing. Remote and top-level documents are excluded.
- The parent checks the message's source window and exact entry URL. This notification conveys readiness only; it exposes no native commands. `sandbox="allow-scripts"` is retained without `allow-same-origin`.
- An iframe `load` event only probes readiness. Browsers can fire this event for failed frame navigations, so it cannot prove that the HTML document is available.

## Recovery and lifetime

The file read and document-readiness phases each have a 10-second limit. A timed-out file read cannot later mount a frame; retry starts a new attempt. A timed-out iframe remains mounted and may recover when its own valid readiness notification arrives. Native frame errors are terminal for that attempt.

Local error/timeout UI provides Retry and Source actions. Neither failure blocks the entire Work/Browser host. Timers, native DOM listeners and message listeners are released when the attempt ends. A shared external-document watch remains at the session level so a file change refreshes the preview without a watch/retry subscription loop.

The source editor mounts only when requested and keeps its existing document session, save barrier and content-state handling. Source errors and progress are rendered within the HTML view so its preview/source toolbar remains accessible.

## Validation

`html-resource-view.test.tsx` covers authorization before frame mounting, the native parsed-document notification, rejection of foreign/stale signals, idempotent Preview clicks, bounded reads, iframe timeouts and late recovery, source switching, errors/retry and file-watch refresh. Shared surface state and lifecycle tests cover host integration. Native changes require rebuilding/restarting the desktop application; frontend hot reload cannot install a new native plugin or CSP.

## Document links

The native local-frame script delegates cross-document anchor clicks to the host,
including `_blank`, download anchors and middle clicks. Same-document fragment
links retain native scrolling. The host accepts messages only from the current
preview window and entry URL (ignoring its fragment), and removes the listener
when the attempt ends. Messages confer no filesystem authorization.

Workspace resolves HTML URLs against the original file and its optional `base
href`, then opens the target through `openWorkspaceSurface` in Browser. File
targets use existing surface classification, ownership resolution, save barriers
and history. PDF and other unsupported formats retain the normal unavailable-file
surface; there is no new binary parser. Markdown fragments use existing heading
navigation. HTTP(S) uses the web surface; mail and telephone links use the system
handler. Other protocols are rejected. File queries do not become part of the path.

## Scrollbar behavior

Local asset frames are restyled by the same frame script as remote pages, so their bars are overlays too: the native bar is set to zero width and an overlay thumb is painted from inside the document. No content wrapper, no `overflow` rewrite, no wheel interception, and still one bar per scrolling region — see [FRAME_SCROLLBAR.md](./FRAME_SCROLLBAR.md).

Thumbs are transparent while idle and fade in on scroll for 700 ms, extending on further scrolling. Viewport events cover html/body propagation and quirks mode; nested and dynamically inserted scroll regions are handled independently. The host only supplies the palette; the frame owns geometry and timing.

The preview keeps its opaque sandbox origin, and the host never reads its document. Changes to the native initialization script require rebuilding/restarting the desktop application; frontend hot reload alone cannot replace it.
