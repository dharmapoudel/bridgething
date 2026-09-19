use std::{
  collections::{HashMap, HashSet},
  sync::{Arc, Mutex, OnceLock},
};

use super::{Address, GatewayType};

type DisconnectHook = Arc<dyn Fn(Address, bool) + Send + Sync>;

#[derive(Clone, Default)]
pub struct PeerOwners {
  inner: Arc<Mutex<HashMap<Address, GatewayType>>>,
  on_disconnect: Arc<OnceLock<DisconnectHook>>,
}

impl std::fmt::Debug for PeerOwners {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("PeerOwners").field("inner", &self.inner).finish()
  }
}

impl PeerOwners {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn set_disconnect_hook(&self, hook: DisconnectHook) {
    let _ = self.on_disconnect.set(hook);
  }

  pub fn register(&self, addr: Address, kind: GatewayType) {
    let mut map = self.inner.lock().expect("peer_owners poisoned");
    if let Some(existing) = map.get(&addr).copied() {
      if existing != kind {
        tracing::warn!(
          %addr,
          ?existing,
          incoming = ?kind,
          "peer_owners: address already owned by a different transport - keeping prior owner"
        );
      }
      return;
    }
    map.insert(addr, kind);
  }

  pub fn unregister(&self, addr: Address, kind: GatewayType) {
    let became_empty = {
      let mut map = self.inner.lock().expect("peer_owners poisoned");
      match map.get(&addr).copied() {
        Some(existing) if existing == kind => {
          map.remove(&addr);
          Some(map.is_empty())
        }
        _ => None,
      }
    };
    if let Some(empty) = became_empty
      && let Some(hook) = self.on_disconnect.get()
    {
      hook(addr, empty);
    }
  }

  pub fn owner(&self, addr: &Address) -> Option<GatewayType> {
    self.inner.lock().expect("peer_owners poisoned").get(addr).copied()
  }

  pub fn addresses(&self) -> Vec<Address> {
    self.inner.lock().expect("peer_owners poisoned").keys().copied().collect()
  }

  pub fn active_kinds(&self) -> HashSet<GatewayType> {
    self
      .inner
      .lock()
      .expect("peer_owners poisoned")
      .values()
      .copied()
      .collect()
  }
}
