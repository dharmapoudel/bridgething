//! Display rotation: 0/90/180/270 degrees, persisted across reboots.
//!
//! Rotation is applied in two coordinated parts, both driven by the daemon:
//! 1. `Emulation.setDeviceMetricsOverride` on the kiosk tab (see
//!    [`crate::chrome::ChromeCommand::SetRotation`]) keeps the override at the
//!    physical 800x480 window size so the whole panel paints, while
//!    `screen.orientation` reports the rotated orientation.
//! 2. The injected [`rotation.js`](self::rotation_script) pins the page root to
//!    the rotated layout size (480x800 in portrait) and rotates it with a CSS
//!    transform so the portrait layout fills the physical 800x480 panel.
//!
//! Touch input needs no remapping: Chromium hit-tests through CSS transforms,
//! so taps land on the visually-rotated elements. The daemon never sees touch
//! events anyway (touch goes kernel -> Chromium directly; the daemon only
//! handles GPIO keys).
//!
//! Escape hatch: holding the knob (KEY_M) for 3 seconds resets rotation to
//! landscape via [`reset_rotation_to_landscape`], so a wedged portrait mode
//! can never strand the device with no way out.
//!
//! Downgrade safety: the prefs file is a separate `rotation.json` (not shared
//! with `als.json`), `rotation` defaults to 0 (no behavior change), and the
//! client protocol additions are ignored by older daemons/clients.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Valid rotation values, degrees clockwise.
pub const VALID_ROTATIONS: [u16; 4] = [0, 90, 180, 270];

const ROTATION_PREFS_FILE: &str = "rotation.json";

const ROTATION_JS: &str = include_str!("rotation.js");

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct RotationPrefs {
  #[serde(default)]
  rotation: u16,
}

fn load_prefs(path: &Path) -> u16 {
  let bytes = match std::fs::read(path) {
    Ok(bytes) => bytes,
    Err(_) => return 0,
  };
  let prefs: RotationPrefs = match serde_json::from_slice(&bytes) {
    Ok(prefs) => prefs,
    Err(_) => return 0,
  };
  if VALID_ROTATIONS.contains(&prefs.rotation) {
    prefs.rotation
  } else {
    0
  }
}

async fn save_prefs(path: &Path, rotation: u16) {
  if let Some(dir) = path.parent()
    && let Err(err) = tokio::fs::create_dir_all(dir).await
  {
    tracing::warn!(path = %path.display(), "rotation: cannot create prefs dir: {err}");
    return;
  }
  let body = match serde_json::to_vec(&RotationPrefs { rotation }) {
    Ok(body) => body,
    Err(err) => {
      tracing::warn!("rotation: cannot serialize prefs: {err}");
      return;
    }
  };
  let tmp = path.with_extension("tmp");
  if let Err(err) = tokio::fs::write(&tmp, body).await {
    tracing::warn!(path = %path.display(), "rotation: cannot write prefs: {err}");
  } else if let Err(err) = tokio::fs::rename(&tmp, path).await {
    tracing::warn!(path = %path.display(), "rotation: cannot replace prefs: {err}");
  }
}

#[derive(Debug, thiserror::Error)]
pub enum RotationError {
  #[error("rotation must be one of 0, 90, 180, 270 degrees")]
  InvalidRotation,
}

/// Persisted display-rotation state. Cheap to clone; share via [`State`](crate::state::State).
#[derive(Debug, Clone)]
pub struct RotationManager {
  inner: Arc<RwLock<u16>>,
  prefs_path: PathBuf,
}

impl RotationManager {
  pub fn new(state_dir: PathBuf) -> Self {
    let prefs_path = state_dir.join(ROTATION_PREFS_FILE);
    let rotation = load_prefs(&prefs_path);
    tracing::info!(rotation, "display rotation restored");
    Self {
      inner: Arc::new(RwLock::new(rotation)),
      prefs_path,
    }
  }

  pub async fn rotation(&self) -> u16 {
    *self.inner.read().await
  }

  /// Validate, persist, and return the new rotation in degrees.
  pub async fn set_rotation(&self, degrees: u16) -> Result<u16, RotationError> {
    if !VALID_ROTATIONS.contains(&degrees) {
      return Err(RotationError::InvalidRotation);
    }
    *self.inner.write().await = degrees;
    save_prefs(&self.prefs_path, degrees).await;
    tracing::info!(degrees, "display rotation set");
    Ok(degrees)
  }

  /// Script injected into every page. Bakes in the current rotation (so the
  /// CSS transform matches the CDP metrics override) and the daemon WebSocket
  /// URL (so the corner-gesture button can ask the daemon to rotate).
  pub fn script(&self, degrees: u16, ws_url: &str) -> Arc<String> {
    Arc::new(
      ROTATION_JS
        .replace("{DEGREES}", &degrees.to_string())
        .replace("{WS_URL}", ws_url),
    )
  }
}

/// Apply a display rotation change end to end: validate and persist the new
/// value, push the CDP metrics override to the kiosk tab, and re-inject
/// scripts with the new degrees baked in. Shared by the
/// `hardware.displaySetRotation` handler and the knob-hold escape hatch.
pub async fn apply_rotation(state: &crate::state::State, degrees: u16) {
  let degrees = match state.rotation.set_rotation(degrees).await {
    Ok(degrees) => degrees,
    Err(err) => {
      tracing::debug!("display rotation rejected: {err:?}");
      return;
    }
  };
  if let Err(err) = state
    .chrome
    .send(crate::chrome::ChromeCommand::SetRotation { degrees })
    .await
  {
    tracing::warn!("display rotation: chrome command failed: {err:?}");
  }
  state.sync_injections(true).await;
}

/// Reset display rotation to landscape (0). Physical escape hatch for a
/// wedged portrait mode: holding the knob 3 seconds calls this. No-op when
/// already landscape so a stray long hold never churns the kiosk tab.
pub async fn reset_rotation_to_landscape(state: &crate::state::State) {
  if state.rotation.rotation().await == 0 {
    return;
  }
  tracing::info!("knob hold: resetting display rotation to landscape");
  apply_rotation(state, 0).await;
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn invalid_rotation_values_fall_back_to_zero() {
    let dir = std::env::temp_dir().join(format!("rotation-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(ROTATION_PREFS_FILE);
    std::fs::write(&path, r#"{"rotation": 45}"#).unwrap();
    assert_eq!(load_prefs(&path), 0);
    std::fs::write(&path, r#"not json"#).unwrap();
    assert_eq!(load_prefs(&path), 0);
    assert_eq!(load_prefs(&dir.join("missing.json")), 0);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn script_bakes_in_degrees_and_ws_url() {
    let mgr = RotationManager::new(std::env::temp_dir());
    let script = mgr.script(90, "ws://127.0.0.1:8891/");
    assert!(script.contains("var DEGREES = 90;"));
    assert!(script.contains("ws://127.0.0.1:8891/"));
    assert!(!script.contains("{DEGREES}"));
    assert!(!script.contains("{WS_URL}"));
  }

  #[tokio::test]
  async fn set_rotation_rejects_invalid_values() {
    let dir = std::env::temp_dir().join(format!("rotation-test-{}", std::process::id()));
    let mgr = RotationManager::new(dir.clone());
    assert!(mgr.set_rotation(45).await.is_err());
    assert!(mgr.set_rotation(90).await.is_ok());
    assert_eq!(mgr.rotation().await, 90);
    // Reopening the manager restores the persisted value.
    let mgr2 = RotationManager::new(dir.clone());
    assert_eq!(mgr2.rotation().await, 90);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
