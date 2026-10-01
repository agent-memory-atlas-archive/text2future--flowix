/// Local HTML previews have opaque sandbox origins. Initialize inside their
/// document instead of trying to reach contentDocument from the React host.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri::plugin::Builder::new("frame-scrollbar");
    #[cfg(target_os = "windows")]
    let builder = builder.js_init_script_on_all_frames(include_str!("frame_scrollbar.js"));
    builder.build()
}
