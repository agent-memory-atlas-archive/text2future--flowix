//! Native window backdrop effects for the main desktop window.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::config::Theme;

const MATERIAL_NONE: u8 = 0;
#[cfg(target_os = "windows")]
const MATERIAL_MICA: u8 = 1;
#[cfg(target_os = "macos")]
const MATERIAL_VIBRANCY: u8 = 2;

static ACTIVE_MATERIAL: AtomicU8 = AtomicU8::new(MATERIAL_NONE);

pub fn is_active() -> bool {
    ACTIVE_MATERIAL.load(Ordering::Acquire) != MATERIAL_NONE
}

pub fn active_material() -> &'static str {
    match ACTIVE_MATERIAL.load(Ordering::Acquire) {
        #[cfg(target_os = "windows")]
        MATERIAL_MICA => "mica",
        #[cfg(target_os = "macos")]
        MATERIAL_VIBRANCY => "vibrancy",
        _ => "none",
    }
}

pub fn apply_main_window_material(window: &tauri::WebviewWindow, _theme: Theme) {
    if window.label() != "main" {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        let dark = match _theme {
            Theme::Dark | Theme::Mist => Some(true),
            Theme::Light | Theme::Rock | Theme::Ember => Some(false),
            Theme::System => None,
        };
        match window_vibrancy::apply_mica(window, dark) {
            Ok(()) => ACTIVE_MATERIAL.store(MATERIAL_MICA, Ordering::Release),
            Err(error) => {
                // Windows 10 and unsupported Windows builds intentionally keep
                // the existing opaque themed background.
                ACTIVE_MATERIAL.store(MATERIAL_NONE, Ordering::Release);
                tracing::debug!(%error, "Mica is unavailable; using the solid window background");
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if !is_active() {
            match window_vibrancy::apply_vibrancy(
                window,
                window_vibrancy::NSVisualEffectMaterial::Popover,
                Some(window_vibrancy::NSVisualEffectState::Active),
                None,
            ) {
                Ok(()) => ACTIVE_MATERIAL.store(MATERIAL_VIBRANCY, Ordering::Release),
                Err(error) => {
                    ACTIVE_MATERIAL.store(MATERIAL_NONE, Ordering::Release);
                    tracing::warn!(%error, "macOS Vibrancy could not be applied");
                }
            }
        }
    }
}
