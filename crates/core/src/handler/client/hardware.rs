use libbridgething::client::{
  BridgeToClientHardwareMsg, ClientToBridgeHardwareMsgDispatch, DisplaySetLevel, DisplaySetMode,
  DisplaySetRotation,
};

use super::{HandlerResult, MsgHandle};

pub struct HardwareHandler {
  handle: MsgHandle,
}

impl HardwareHandler {
  pub fn new(handle: MsgHandle) -> Self {
    Self { handle }
  }
}

impl ClientToBridgeHardwareMsgDispatch for HardwareHandler {
  type Output = HandlerResult;

  async fn display_set_mode(&self, params: DisplaySetMode) -> HandlerResult {
    if let Err(err) = self.handle.state.als.set_mode(params.mode).await {
      tracing::warn!("({}) hardware.displaySetMode failed: {err}", &self.handle.from);
    }
    Ok(())
  }

  async fn display_set_level(&self, params: DisplaySetLevel) -> HandlerResult {
    match self.handle.state.als.set_level(params.level).await {
      Ok(Ok(())) => {}
      Ok(Err(err)) => {
        tracing::debug!("({}) hardware.displaySetLevel rejected: {err:?}", &self.handle.from);
      }
      Err(err) => {
        tracing::warn!("({}) hardware.displaySetLevel failed: {err}", &self.handle.from);
      }
    }
    Ok(())
  }

  async fn display_set_rotation(&self, params: DisplaySetRotation) -> HandlerResult {
    let degrees = match self.handle.state.rotation.set_rotation(params.degrees).await {
      Ok(degrees) => degrees,
      Err(err) => {
        tracing::debug!("({}) hardware.displaySetRotation rejected: {err:?}", &self.handle.from);
        return Ok(());
      }
    };
    // Apply the CDP metrics override, then re-inject the rotation script with
    // the new degrees baked in (runs immediately in the live page).
    if let Err(err) = self
      .handle
      .state
      .chrome
      .send(crate::chrome::ChromeCommand::SetRotation { degrees })
      .await
    {
      tracing::warn!("({}) hardware.displaySetRotation: chrome command failed: {err:?}", &self.handle.from);
    }
    self.handle.state.sync_injections(true).await;
    Ok(())
  }

  async fn state_get(&self) -> HandlerResult {
    let mut reply = self.handle.state.als.snapshot_reply().await;
    reply.state.rotation = self.handle.state.rotation.rotation().await;
    self
      .handle
      .respond(BridgeToClientHardwareMsg::StateReply(reply))
      .await?;
    Ok(())
  }
}
