use std::path::{Path, PathBuf};
use std::time::Duration;

use evdev::{Device, EventType, KeyCode};
use libbridgething::LauncherGesture;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use super::trigger_hub_switch;
use crate::{
  bluetooth::BluetoothMan, chrome::ChromeCommand, handler::gateway::webapp::navigate_url_for_active,
  state::State,
};

const RETRY_BACKOFF: Duration = Duration::from_secs(5);
const LONG_PRESS_THRESHOLD: Duration = Duration::from_millis(800);
// Escape hatch: holding the knob this long resets display rotation to
// landscape, so a wedged portrait mode can never strand the device.
const ROTATION_RESET_HOLD: Duration = Duration::from_millis(3000);

pub async fn listen_for_hub_gesture(state: State, bluetooth: BluetoothMan, cancel: CancellationToken) {
  loop {
    if cancel.is_cancelled() {
      return;
    }
    match find_gpio_keys_device().await {
      Some(path) => {
        tracing::info!("hub gesture: listening on {}", path.display());
        if let Err(e) = run_loop(&path, &state, &bluetooth, &cancel).await {
          tracing::warn!("hub gesture loop on {} ended: {:?}", path.display(), e);
        }
      }
      None => {
        tracing::debug!("hub gesture: no gpio-keys-polled evdev node yet, retrying");
      }
    }
    tokio::select! {
      _ = sleep(RETRY_BACKOFF) => {}
      _ = cancel.cancelled() => return,
    }
  }
}

async fn find_gpio_keys_device() -> Option<PathBuf> {
  let mut rd = tokio::fs::read_dir("/dev/input").await.ok()?;
  while let Ok(Some(entry)) = rd.next_entry().await {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
      continue;
    };
    if !name.starts_with("event") {
      continue;
    }
    let probe_path = path.clone();
    let dev_name = match tokio::task::spawn_blocking(move || open_name(&probe_path)).await {
      Ok(Some(n)) => n,
      _ => continue,
    };
    if dev_name.contains("gpio-keys") {
      return Some(path);
    }
  }
  None
}

fn open_name(path: &Path) -> Option<String> {
  let dev = Device::open(path).ok()?;
  Some(dev.name().unwrap_or("").to_string())
}

async fn handle_browser_nav(state: &State, key: KeyCode) {
  if !state.chrome.is_external() {
    return;
  }
  match state.active_webapp().await {
    Ok(Some(active)) if active == crate::state::BROWSER_WEBAPP_ID => {}
    _ => return,
  }
  let cmd = if key == KeyCode::KEY_ESC {
    ChromeCommand::Navigate(navigate_url_for_active(state).await)
  } else if key == KeyCode::KEY_1 {
    ChromeCommand::HistoryBack
  } else if key == KeyCode::KEY_4 {
    ChromeCommand::HistoryForward
  } else {
    return;
  };
  if let Err(e) = state.chrome.send(cmd).await {
    tracing::warn!("browser nav key: dispatch failed: {:?}", e);
  }
}

async fn run_loop(
  path: &Path,
  state: &State,
  bluetooth: &BluetoothMan,
  cancel: &CancellationToken,
) -> Result<(), String> {
  let device = Device::open(path).map_err(|e| format!("open: {e}"))?;
  let mut events = device.into_event_stream().map_err(|e| format!("stream: {e}"))?;
  let mut held = false;
  let mut hold_deadline = Box::pin(sleep(Duration::ZERO));
  let mut rotation_held = false;
  let mut rotation_deadline = Box::pin(sleep(Duration::ZERO));
  let mut key2_down = false;
  let mut key3_down = false;
  let mut screenshot_fired = false;

  loop {
    tokio::select! {
      _ = cancel.cancelled() => return Ok(()),
      _ = &mut hold_deadline, if held => {
        held = false;
        if state.meta.launcher_gesture() != LauncherGesture::LongPress {
          continue;
        }
        tracing::debug!("hub gesture: KEY_M held");
        trigger_hub_switch(state).await;
      }
      _ = &mut rotation_deadline, if rotation_held => {
        rotation_held = false;
        crate::rotation::reset_rotation_to_landscape(state).await;
      }
      ev = events.next_event() => {
        let ev = match ev {
          Ok(ev) => ev,
          Err(e) => return Err(format!("read: {e}")),
        };
        if ev.event_type() != EventType::KEY {
          continue;
        }

        let key = KeyCode::new(ev.code());

        if key == KeyCode::KEY_M {
          match ev.value() {
            1 => {
              // Escape hatch: a 3s knob hold resets display rotation to
              // landscape. Armed on every press, independent of the
              // hub-switch gesture below.
              rotation_held = true;
              rotation_deadline
                .as_mut()
                .reset(tokio::time::Instant::now() + ROTATION_RESET_HOLD);
              match state.meta.launcher_gesture() {
                LauncherGesture::LongPress => {
                  held = true;
                  hold_deadline
                    .as_mut()
                    .reset(tokio::time::Instant::now() + LONG_PRESS_THRESHOLD);
                }
                // Custom firmware: fivePress fires on a single M press. The
                // companion app still labels the option "Press M 5x".
                LauncherGesture::FivePress => {
                  tracing::debug!("hub gesture: KEY_M single press");
                  trigger_hub_switch(state).await;
                }
              }
            }
            0 => {
              held = false;
              rotation_held = false;
            }
            _ => {}
          }
          continue;
        }

        if key == KeyCode::KEY_2 || key == KeyCode::KEY_3 {
          let down = ev.value() == 1;
          if key == KeyCode::KEY_2 {
            key2_down = down;
          } else {
            key3_down = down;
          }
          if !down {
            screenshot_fired = false;
            continue;
          }
          if key2_down && key3_down && !screenshot_fired {
            screenshot_fired = true;
            tracing::info!("screenshot chord: KEY_2+KEY_3 pressed");
            let state = state.clone();
            let bluetooth = bluetooth.clone();
            tokio::spawn(async move {
              crate::screenshot::capture_and_push(&state, &bluetooth).await;
            });
          }
          continue;
        }

        if ev.value() != 1 {
          continue;
        }

        if key == KeyCode::KEY_ESC || key == KeyCode::KEY_1 || key == KeyCode::KEY_4 {
          handle_browser_nav(state, key).await;
        }
      }
    }
  }
}
