//! POST /_clear_caches purges the chromium HTTP cache and the daemon asset
//! disk cache. Both re-fetch on demand; installed bundles and webapp data
//! are untouched. Only the on-device kiosk (loopback) may call this.

use std::net::SocketAddr;

use axum::{
  Json,
  extract::{ConnectInfo, State as AxumState},
  http::StatusCode,
  response::{IntoResponse, Response},
};
use serde::Serialize;

use super::ModernRouterState;
use crate::{chrome::ChromeCommand, paths};

#[derive(Serialize)]
pub struct ClearCachesReply {
  pub freed_bytes: u64,
  pub disk_free_bytes: u64,
  pub chromium_cache_cleared: bool,
  pub asset_cache_cleared: bool,
}

pub async fn clear_caches(
  AxumState(router): AxumState<ModernRouterState>,
  ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
  if !addr.ip().is_loopback() {
    return (StatusCode::FORBIDDEN, "cache cleanup is only available on the device").into_response();
  }
  let state = &router.state;
  let free_before = paths::partition_free_bytes(&paths::state_dir());

  let chromium_cache_cleared = state.chrome.send(ChromeCommand::ClearHttpCache).await.is_ok();
  let asset_cache_cleared = state.assets.clear_all().await.is_ok();

  let free_after = paths::partition_free_bytes(&paths::state_dir());
  let reply = ClearCachesReply {
    freed_bytes: free_after.saturating_sub(free_before),
    disk_free_bytes: free_after,
    chromium_cache_cleared,
    asset_cache_cleared,
  };
  (StatusCode::OK, Json(reply)).into_response()
}
