/// Observe local HTML document readiness inside opaque sandboxed frames.
/// This script exposes no native APIs to the preview document.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("local-html-preview")
        .js_init_script_on_all_frames(include_str!("local_html_preview.js"))
        .build()
}
