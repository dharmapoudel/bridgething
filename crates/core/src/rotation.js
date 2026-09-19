// Bridgething display rotation — injected by the daemon on every page.
// {DEGREES} and {WS_URL} are baked in at injection time (see rotation.rs).
//
// Two coordinated parts make true portrait work:
// 1. The daemon sends Emulation.setDeviceMetricsOverride so the page *lays out*
//    at the rotated size (480x800 in portrait). window.innerWidth, media
//    queries, 100vw etc. all see the rotated dimensions.
// 2. This script rotates the rendered page with a CSS transform so the portrait
//    layout fills the physical 800x480 panel.
//
// Touch needs no remapping: Chromium hit-tests through the transform, so taps
// land on the visually-rotated elements.
//
// The script also watches for a swipe starting in the physical bottom-right
// corner and reveals a floating rotate button for a few seconds. The button
// asks the daemon (over the local WebSocket) to change rotation; the daemon
// then applies the metrics override and re-injects this script with the new
// degrees baked in.
(function () {
  'use strict';

  // Re-injection guard: the daemon re-runs this script with new degrees baked
  // in when rotation changes. Tear down the previous instance first so stale
  // listeners (holding old DEGREES) don't fight the new ones.
  if (window.__bridgethingRotation && window.__bridgethingRotation.teardown) {
    try {
      window.__bridgethingRotation.teardown();
    } catch (e) {}
  }

  var DEGREES = {DEGREES};
  var WS_URL = '{WS_URL}';

  // Logical layout size per rotation. The daemon's metrics override makes the
  // layout viewport match; pinning it here keeps the transform math exact even
  // if the override hasn't landed yet on first paint.
  var LAYOUTS = {
    0: { w: 800, h: 480 },
    90: { w: 480, h: 800 },
    180: { w: 800, h: 480 },
    270: { w: 480, h: 800 },
  };

  function layoutFor(degrees) {
    return LAYOUTS[degrees] || LAYOUTS[0];
  }

  // Verified: each maps its LAYOUT box exactly onto the 800x480 viewport.
  var TRANSFORMS = {
    0: '',
    90: 'rotate(90deg) translateY(-100%)',
    180: 'rotate(180deg)',
    270: 'rotate(270deg) translateX(-100%)',
  };

  var ORIGINS = { 0: '', 90: 'top left', 180: 'center', 270: 'top left' };

  function applyRotation() {
    var root = document.documentElement;
    if (!root) return;
    var t = TRANSFORMS[DEGREES];
    if (!t) {
      root.style.transform = '';
      root.style.transformOrigin = '';
      root.style.width = '';
      root.style.height = '';
      return;
    }
    var layout = layoutFor(DEGREES);
    root.style.width = layout.w + 'px';
    root.style.height = layout.h + 'px';
    root.style.transformOrigin = ORIGINS[DEGREES];
    root.style.transform = t;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomContentLoaded);
  } else {
    applyRotation();
  }
  // Re-apply after full load too, in case the app rewrote root styles.
  window.addEventListener('load', applyRotation);

  // --- Corner swipe -> rotate button -------------------------------------
  // Touch coordinates arrive in *layout* space (post-transform hit testing).
  // The physical bottom-right corner maps to a different layout corner per
  // rotation; the zone below tracks it.
  function cornerZone() {
    var s = 140;
    var w = window.innerWidth;
    var h = window.innerHeight;
    switch (DEGREES) {
      case 90:
        return { x: w - s, y: 0, w: s, h: s }; // layout top-right
      case 180:
        return { x: 0, y: 0, w: s, h: s }; // layout top-left
      case 270:
        return { x: 0, y: h - s, w: s, h: s }; // layout bottom-left
      default:
        return { x: w - s, y: h - s, w: s, h: s }; // layout bottom-right
    }
  }

  // Where the floating button sits, in layout space (near physical bottom-right).
  function buttonAnchor() {
    switch (DEGREES) {
      case 90:
        return { right: '28px', top: '28px' };
      case 180:
        return { left: '28px', top: '28px' };
      case 270:
        return { left: '28px', bottom: '28px' };
      default:
        return { right: '28px', bottom: '28px' };
    }
  }

  function uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function sendRotation(degrees) {
    try {
      var ws = new WebSocket(WS_URL);
      var payload = JSON.stringify({
        id: uuid4(),
        meta: { kind: 'command' },
        data: {
          type: 'hardware',
          data: { event: 'displaySetRotation', data: { degrees: degrees } },
        },
      });
      ws.onopen = function () {
        try {
          ws.send(payload);
        } catch (e) {}
        setTimeout(function () {
          try {
            ws.close();
          } catch (e) {}
        }, 1500);
      };
      ws.onerror = function () {
        try {
          ws.close();
        } catch (e) {}
      };
    } catch (e) {}
  }

  var btn = null;
  var btnTimer = null;

  function hideButton() {
    if (btnTimer) {
      clearTimeout(btnTimer);
      btnTimer = null;
    }
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    btn = null;
  }

  function showButton() {
    hideButton();
    if (!document.body) return;
    btn = document.createElement('button');
    btn.textContent = DEGREES === 0 ? '\u27f3 Portrait' : '\u27f3 Landscape';
    var anchor = buttonAnchor();
    var css =
      'position:fixed;z-index:2147483647;' +
      'min-width:120px;min-height:56px;padding:12px 18px;' +
      'font-size:20px;font-family:system-ui,sans-serif;' +
      'color:#fff;background:rgba(20,20,24,0.92);' +
      'border:1px solid rgba(255,255,255,0.25);border-radius:14px;' +
      'box-shadow:0 4px 24px rgba(0,0,0,0.5);';
    for (var k in anchor) css += k + ':' + anchor[k] + ';';
    btn.setAttribute('style', css);
    btn.addEventListener('click', function () {
      var target = DEGREES === 0 ? 90 : 0;
      // The daemon applies the CDP metrics override and re-injects this script
      // with the new degrees baked in (run immediately in the live page).
      sendRotation(target);
      hideButton();
    });
    document.body.appendChild(btn);
    btnTimer = setTimeout(hideButton, 5000);
  }

  var swipeStart = null;

  function onTouchStart(e) {
    swipeStart = null;
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    var z = cornerZone();
    if (t.clientX >= z.x && t.clientX <= z.x + z.w && t.clientY >= z.y && t.clientY <= z.y + z.h) {
      swipeStart = { x: t.clientX, y: t.clientY };
    }
  }

  function onTouchEnd(e) {
    if (!swipeStart) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - swipeStart.x;
    var dy = t.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.hypot(dx, dy) > 60) showButton();
  }

  // Mouse fallback (dev/testing): same gesture with a pointer.
  var mouseStart = null;
  function onMouseDown(e) {
    mouseStart = null;
    var z = cornerZone();
    if (e.clientX >= z.x && e.clientX <= z.x + z.w && e.clientY >= z.y && e.clientY <= z.y + z.h) {
      mouseStart = { x: e.clientX, y: e.clientY };
    }
  }
  function onMouseUp(e) {
    if (!mouseStart) return;
    var dx = e.clientX - mouseStart.x;
    var dy = e.clientY - mouseStart.y;
    mouseStart = null;
    if (Math.hypot(dx, dy) > 60) showButton();
  }

  function onDomContentLoaded() {
    applyRotation();
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('DOMContentLoaded', onDomContentLoaded);
  window.addEventListener('load', applyRotation);

  window.__bridgethingRotation = {
    teardown: function () {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('DOMContentLoaded', onDomContentLoaded);
      window.removeEventListener('load', applyRotation);
      hideButton();
      var root = document.documentElement;
      if (root) {
        root.style.transform = '';
        root.style.transformOrigin = '';
        root.style.width = '';
        root.style.height = '';
      }
    },
  };
})();
