//! POST /_clear_caches purges the chromium HTTP cache, the daemon asset disk
//! cache, and stale systemd journals. All re-fetch or re-create on demand;
//! installed bundles and webapp data are untouched. Only the on-device kiosk
//! (loopback) may call this.

use std::{net::SocketAddr, path::Path};

use axum::{
  Json,
  extract::{ConnectInfo, State as AxumState},
  http::StatusCode,
  response::{IntoResponse, Response},
};
use serde::Serialize;
use tokio::fs;

use super::ModernRouterState;
use crate::{chrome::ChromeCommand, paths};

#[derive(Serialize)]
pub struct ClearCachesReply {
  pub freed_bytes: u64,
  pub disk_free_bytes: u64,
  pub chromium_cache_cleared: bool,
  pub asset_cache_cleared: bool,
  pub journal_logs_cleared: bool,
  pub journal_freed_bytes: u64,
}

/// Delete stale systemd journal dirs. /etc/machine-id is a tmpfs (fresh id
/// every boot), so journald never rotates old boot journals and
/// /var/log/journal grows without bound. Keep the current boot's dir;
/// journald holds it open.
pub(crate) async fn sweep_stale_journals() -> u64 {
  if !paths::is_on_device() {
    return 0;
  }
  let current = fs::read_to_string("/etc/machine-id")
    .await
    .map(|s| s.trim().to_string())
    .unwrap_or_default();
  let Ok(mut rd) = fs::read_dir(Path::new("/var/log/journal")).await else {
    return 0;
  };
  let mut freed = 0u64;
  while let Ok(Some(entry)) = rd.next_entry().await {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name == current {
      continue;
    }
    if name.len() != 32 || !name.chars().all(|c| c.is_ascii_hexdigit()) {
      continue;
    }
    freed += dir_bytes(&entry.path()).await;
    let _ = fs::remove_dir_all(entry.path()).await;
  }
  freed
}

async fn dir_bytes(dir: &Path) -> u64 {
  let mut total = 0u64;
  let mut stack = vec![dir.to_path_buf()];
  while let Some(path) = stack.pop() {
    let Ok(mut rd) = fs::read_dir(&path).await else {
      continue;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
      let Ok(meta) = entry.metadata().await else {
        continue;
      };
      if meta.is_dir() {
        stack.push(entry.path());
      } else {
        total += meta.len();
      }
    }
  }
  total
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
  let journal_freed_bytes = sweep_stale_journals().await;

  let free_after = paths::partition_free_bytes(&paths::state_dir());
  let reply = ClearCachesReply {
    freed_bytes: free_after.saturating_sub(free_before),
    disk_free_bytes: free_after,
    chromium_cache_cleared,
    asset_cache_cleared,
    journal_logs_cleared: journal_freed_bytes > 0,
    journal_freed_bytes,
  };
  (StatusCode::OK, Json(reply)).into_response()
}
