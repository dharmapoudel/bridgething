use libbridgething::{
  gateway::{BridgeToGatewaySystemMsgEvent, ScreenshotCaptured},
  protocol::Compress,
};
use uuid::Uuid;

use crate::{bluetooth::BluetoothMan, state::State};

// Cap on retained on-device screenshots. Delivered files are deleted right
// after their transfer resolves, so this only bounds accumulation while no
// companion is connected to receive pushes.
const MAX_SCREENSHOTS: usize = 20;

pub async fn capture_and_push(state: &State, bluetooth: &BluetoothMan) {
  let Some(png) = state.chrome.capture_screenshot().await else {
    tracing::warn!("screenshot capture returned no data");
    return;
  };

  let captured_at_ms = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  let dir = crate::paths::state_dir().join("screenshots");
  if let Err(e) = tokio::fs::create_dir_all(&dir).await {
    tracing::warn!(error = %e, "failed to create screenshots dir");
    return;
  }
  let path = dir.join(format!("screenshot-{captured_at_ms}.png"));
  if let Err(e) = tokio::fs::write(&path, &png).await {
    tracing::warn!(error = %e, "failed to save screenshot");
    return;
  }
  tracing::info!(path = %path.display(), bytes = png.len(), "screenshot saved");
  prune_old_screenshots(&dir).await;

  let sha256 = crate::state::sha256_hex(&png);
  let transfer_id = Uuid::now_v7();
  let addrs = bluetooth.gateway_man.peer_owners().addresses();
  if addrs.is_empty() {
    tracing::debug!("no connected companions, screenshot kept on device only");
    return;
  }

  let mut delivered = true;
  for addr in addrs {
    bluetooth
      .gateway_man
      .send_event(
        addr,
        BridgeToGatewaySystemMsgEvent::ScreenshotCaptured(ScreenshotCaptured {
          transfer_id,
          byte_size: png.len() as u32,
          sha256: sha256.clone(),
          captured_at_ms,
        }),
      )
      .await;
    let ok = state
      .transfer_outbound
      .send_stream(bluetooth, addr, transfer_id, bytes::Bytes::from(png.clone()), Compress::IfSmaller)
      .await;
    tracing::info!(%addr, transfer_id = %transfer_id, ok, "screenshot push finished");
    delivered &= ok;
  }

  // send_stream only resolves true after every fragment cleared the ack
  // window, so the bytes are confirmed delivered before the local file goes.
  // Any failed peer keeps the file on device for a later retry.
  if delivered {
    if let Err(e) = tokio::fs::remove_file(&path).await {
      tracing::warn!(error = %e, path = %path.display(), "failed to delete delivered screenshot");
    } else {
      tracing::info!(path = %path.display(), "deleted delivered screenshot");
    }
  }
}

async fn prune_old_screenshots(dir: &std::path::Path) {
  let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
    return;
  };
  let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
  while let Ok(Some(entry)) = entries.next_entry().await {
    let name = entry.file_name();
    let ts = name
      .to_str()
      .and_then(|n| n.strip_prefix("screenshot-"))
      .and_then(|n| n.strip_suffix(".png"))
      .and_then(|n| n.parse::<u64>().ok());
    // Unparseable names sort as oldest so stray files are pruned first.
    files.push((ts.unwrap_or(0), entry.path()));
  }
  files.sort_by_key(|(ts, _)| *ts);
  if files.len() > MAX_SCREENSHOTS {
    for (_, old) in files.iter().take(files.len() - MAX_SCREENSHOTS) {
      if let Err(e) = tokio::fs::remove_file(old).await {
        tracing::warn!(error = %e, path = %old.display(), "failed to prune old screenshot");
      }
    }
  }
}
