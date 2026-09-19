use std::sync::Arc;

const LAUNCHER_KNOB_JS: &str = include_str!("launcher_knob.js");

/// JS injected into the kiosk tab that gives the hub launcher knob navigation:
/// knob scroll (horizontal wheel events) moves a highlight through the app
/// tiles, knob press (Enter) launches the highlighted app. The script is a
/// no-op on any page that is not the hub launcher.
pub fn launcher_knob_script() -> Arc<String> {
  Arc::new(LAUNCHER_KNOB_JS.to_string())
}
