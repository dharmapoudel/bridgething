use libbridgething::{
  gateway::{BridgeToGatewaySystemMsgEvent, ScreenshotCaptured},
  protocol::Compress,
};
use uuid::Uuid;

use crate::{bluetooth::BluetoothMan, state::State};

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

  let sha256 = crate::state::sha256_hex(&png);
  let transfer_id = Uuid::now_v7();
  let addrs = bluetooth.gateway_man.peer_owners().addresses();
  if addrs.is_empty() {
    tracing::debug!("no connected companions, screenshot kept on device only");
    return;
  }

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
    let spawned = state
      .transfer_outbound
      .send_stream(bluetooth, addr, transfer_id, bytes::Bytes::from(png.clone()), Compress::IfSmaller)
      .await;
    tracing::info!(%addr, transfer_id = %transfer_id, spawned, "screenshot push started");
  }
}
