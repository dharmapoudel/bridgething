//! Tile uninstall from the on-device launcher.
//!
//! POST /_uninstall with a JSON body of {"name": "<tile label>"} resolves the
//! label to a webapp id and uninstalls it through the WebappRegistry, the same
//! removable model the gateway WebappUninstall request uses: installed bundles
//! are deleted, non-reserved builtins are tombstoned in
//! uninstalled_builtins.json so they stay hidden across reboots. Reserved
//! builtins (hub, browser, stock) are refused. Only the on-device kiosk
//! (loopback) may call this; the injected launcher knob script posts here on
//! a long knob press.

use std::net::SocketAddr;

use axum::{
  Json,
  extract::{ConnectInfo, State as AxumState},
  http::StatusCode,
  response::{IntoResponse, Response},
};
use libbridgething::client::{BridgeToClientWebappMsgEvent, WebappUninstalled};
use serde::Deserialize;

use super::ModernRouterState;
use crate::{chrome::ChromeCommand, handler::gateway::webapp::navigate_url_for_active, state::is_reserved};

#[derive(Deserialize)]
pub struct UninstallTileBody {
  name: String,
}

pub async fn uninstall_tile(
  AxumState(router): AxumState<ModernRouterState>,
  ConnectInfo(addr): ConnectInfo<SocketAddr>,
  Json(body): Json<UninstallTileBody>,
) -> Response {
  // The modern port binds 0.0.0.0 on the device; the kiosk chromium is the
  // only caller allowed to uninstall tiles.
  if !addr.ip().is_loopback() {
    return (StatusCode::FORBIDDEN, "tile uninstall is only available on the device").into_response();
  }
  let state = &router.state;
  let Some(id) = state.webapps.resolve_by_name(body.name.trim()).await else {
    return (StatusCode::NOT_FOUND, "no installed app with that name").into_response();
  };
  if state.webapps.is_builtin(id).await && is_reserved(id) {
    tracing::warn!("refusing tile uninstall of reserved builtin webapp {id}");
    return (StatusCode::FORBIDDEN, "that app cannot be uninstalled").into_response();
  }
  let name = state
    .webapps
    .manifest(id)
    .await
    .map(|manifest| manifest.name.clone())
    .unwrap_or_default();
  match state.webapps.uninstall(id).await {
    Ok(true) => {}
    Ok(false) => return (StatusCode::NOT_FOUND, "app is not installed").into_response(),
    Err(err) => {
      tracing::warn!("tile uninstall of webapp {id} failed: {err:?}");
      return (StatusCode::INTERNAL_SERVER_ERROR, "uninstall failed").into_response();
    }
  }
  if let Err(err) = state.kv.webapp_purge(id).await {
    tracing::warn!("tile uninstall: failed to purge kv for webapp {id}: {err:?}");
  }
  let event = BridgeToClientWebappMsgEvent::WebappUninstalled(WebappUninstalled { id, name });
  if let Err(errs) = state.bus.broadcast_event(event).await {
    tracing::debug!("tile uninstall client broadcast: {} non-fatal errors", errs.len());
  }
  let mut needs_reload = false;
  match state.release_slots_for(id).await {
    Ok(released) => {
      if released.overlay {
        tracing::info!("uninstalled webapp {id} held the overlay slot; reverting to the builtin overlay");
        state.sync_injections(false).await;
        needs_reload = true;
      }
      if released.launcher {
        tracing::info!("uninstalled webapp {id} held the launcher slot; reverting to the builtin hub");
      }
    }
    Err(err) => tracing::warn!("tile uninstall: failed to release slots for {id}: {err:?}"),
  }
  match state.active_webapp().await {
    Ok(Some(active)) if active == id => match state.launcher_webapp().await {
      Ok(Some(fallback)) => {
        tracing::info!("active webapp {id} was uninstalled; falling back to {fallback}");
        if let Err(err) = state.set_active_webapp(fallback).await {
          tracing::warn!("tile uninstall: failed to fall back to launcher: {err:?}");
        } else {
          needs_reload = true;
        }
      }
      _ => tracing::warn!("active webapp {id} was uninstalled and no fallback is available"),
    },
    Err(err) => tracing::warn!("tile uninstall: failed to read active webapp: {err:?}"),
    _ => {}
  }
  if needs_reload {
    let url = navigate_url_for_active(state).await;
    if let Err(err) = state.chrome.send(ChromeCommand::Navigate(url)).await {
      tracing::warn!("tile uninstall: failed to reload kiosk: {err:?}");
    }
  }
  (StatusCode::OK, "uninstalled").into_response()
}
