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

## Scrollbar behavior

Local asset frames style their existing native scrollbars. No overlay host, shadow scrollbar, content wrapper, overflow change or wheel interception is added. This avoids native/custom duplication and preserves the browser's vertical/horizontal scrolling and thumb dragging.

Thumbs are transparent while idle. A captured scroll event reveals the actual scrolling element for 700 ms, extending that element's timer on further scrolling. Viewport events cover html/body propagation and quirks mode; nested and dynamically inserted scroll regions are handled independently. The shared helper supplies the editor's 6px WebKit styling and platform-specific thumb colors. Theme changes update the same stylesheet. Unload removes the stylesheet, listeners and timers and restores temporary attributes.

Styling is installed as soon as parent configuration is available, without waiting for external document dependencies. Remote sites remain excluded, and the local frame keeps its opaque sandbox origin. Changes to the native initialization script require rebuilding/restarting the desktop application; frontend hot reload alone cannot replace it.
