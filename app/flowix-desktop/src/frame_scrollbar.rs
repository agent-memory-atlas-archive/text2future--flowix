/// Local HTML previews and remote pages are both cross-origin to the host, so
/// neither can be styled through `contentDocument`. This script is injected into
/// every frame by the engine, which lets each document restyle its own
/// scrollbars from the inside. It entry-checks the origin and stays inert
/// everywhere else — see docs/WEB_SURFACE_SCROLLBAR.md.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("frame-scrollbar")
        .js_init_script_on_all_frames(include_str!("web_frame_scrollbar.js"))
        .build()
}
