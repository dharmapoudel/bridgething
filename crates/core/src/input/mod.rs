#[cfg(feature = "input")]
mod evdev_listener;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::{chrome::ChromeCommand, handler::gateway::webapp::navigate_url_for_active, state::State};

#[derive(Debug)]
pub struct InputManager {
  _handle: JoinHandle<()>,
}

impl InputManager {
  pub fn spawn(state: State) -> Self {
    let cancel_token = CancellationToken::new();
    let handle = tokio::spawn(run(state, cancel_token));
    Self { _handle: handle }
  }
}

#[cfg(feature = "input")]
async fn run(state: State, cancel: CancellationToken) {
  evdev_listener::listen_for_hub_gesture(state, cancel).await;
}

#[cfg(not(feature = "input"))]
async fn run(_state: State, cancel: CancellationToken) {
  tracing::debug!("input feature disabled; gesture listener idle");
  cancel.cancelled().await;
}

#[cfg_attr(not(feature = "input"), allow(dead_code))]
pub(crate) async fn trigger_hub_switch(state: &State) {
  let Ok(Some(id)) = state.launcher_webapp().await else {
    tracing::warn!("hub gesture fired but no launcher resolves; ignoring");
    return;
  };
  if matches!(state.active_webapp().await, Ok(Some(active)) if active == id) {
    // The hub hosts sub-views (settings, wizard) as client-side state, not
    // separate webapps, so the daemon cannot tell "launcher home" from
    // "settings page". A no-op here strands the user in settings with a dead
    // M button. Re-navigate to the hub URL to reset the hub to its home view.
    let url = navigate_url_for_active(state).await;
    if let Err(e) = state.chrome.send(ChromeCommand::Navigate(url)).await {
      tracing::warn!("hub gesture: failed to reset launcher view: {:?}", e);
    } else {
      tracing::info!("hub gesture fired: reset launcher to home view");
    }
    return;
  }
  if state.webapps.resolve(id).await.is_none() {
    state.webapps.rescan().await;
  }
  if state.webapps.resolve(id).await.is_none() {
    tracing::warn!("hub gesture fired but launcher {id} is not installed; ignoring");
    return;
  }
  if let Err(e) = state.set_active_webapp(id).await {
    tracing::warn!("hub gesture: failed to set active webapp: {:?}", e);
    return;
  }
  let url = navigate_url_for_active(state).await;
  if let Err(e) = state.chrome.send(ChromeCommand::Navigate(url)).await {
    tracing::warn!("hub gesture: failed to navigate kiosk: {:?}", e);
  } else {
    tracing::info!("hub gesture fired: switched to launcher");
  }
}
