// Bridgething display rotation - injected by the daemon on every page.
// {DEGREES} and {WS_URL} are baked in at injection time (see rotation.rs).
//
// Two coordinated parts make portrait work:
// 1. The daemon sends Emulation.setDeviceMetricsOverride at the fixed 800x480
//    window size for every rotation. Blink rasterizes at the override size, so
//    a 480x800 override left the right ~320px of the window unpainted.
//    screen.orientation still reports the rotated orientation
//    (portraitSecondary at 270). Note window.innerWidth stays 800; the
//    root-pinning math below must use LAYOUTS, never window dimensions (touch
//    zones are the opposite: viewport space, see cornerZone).
// 2. This script pins the page root to the rotated layout size from LAYOUTS
//    (480x800 in portrait) and rotates it with a CSS transform so the portrait
//    layout fills the physical 800x480 panel. Portrait is 270 degrees: the
//    knob sits on the right edge in landscape, so the device turns 90 degrees
//    clockwise to put the knob at the bottom, and -90 degrees maps UI-up to
//    the framebuffer's left edge, which is physical up in that hold.
// 3. The hub launcher's tile grid geometry is computed for landscape
//    (GRID_WIDTH_PX=768 in the hub bundle, baked into the read-only image),
//    so pinning the root alone never reflows it. On hub pages in portrait this
//    script forces the grid to two columns with an !important rule (which
//    beats the inline style React sets) and forces its wrapper to scroll
//    instead of flex-centering, which clipped the middle rows. A
//    MutationObserver re-adds the rule if anything removes it.
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
    // The shared app CSS pins body to 800x480. Resizing only <html> leaves
    // the 800px-wide body overflowing the 480px html in portrait, and
    // overflow:hidden clips it to a strip. Pin the body to the layout box too.
    var body = document.body;
    if (!t) {
      root.style.transform = '';
      root.style.transformOrigin = '';
      root.style.width = '';
      root.style.height = '';
      if (body) {
        body.style.width = '';
        body.style.height = '';
      }
      removeReflow();
      return;
    }
    var layout = layoutFor(DEGREES);
    root.style.width = layout.w + 'px';
    root.style.height = layout.h + 'px';
    root.style.transformOrigin = ORIGINS[DEGREES];
    root.style.transform = t;
    if (body) {
      body.style.width = layout.w + 'px';
      body.style.height = layout.h + 'px';
    }
    applyReflow();
    watchReflow();
  }

  function isPortrait() {
    return DEGREES === 90 || DEGREES === 270;
  }

  function isHubPage() {
    try {
      var p = window.location.pathname;
      return p === '/_hub' || p.indexOf('/_hub/') === 0;
    } catch (e) {
      return false;
    }
  }

  // Hub launcher portrait layout. The tile grid's geometry is computed for
  // landscape (GRID_WIDTH_PX=768 in the hub bundle), so without this the grid
  // stays a rigid landscape block in portrait. Two rules, scoped to hub pages
  // in portrait:
  // 1. Force two columns (beats the inline style React sets).
  // 2. The hub centers the grid with flex when its landscape math says it
  //    "fits", but the 2-column portrait grid has more rows than fit on
  //    screen; flex centering then clips/squishes the middle rows. Force a
  //    scrolling block so every tile is reachable (the swipe driver below
  //    scrolls this element). The grid's baked-in 768px landscape width would
  //    otherwise overflow the 480px portrait viewport and clip one side, so
  //    pin it to the viewport width and hide horizontal overflow.
  // Applied as a style element (covers present and future grids) and kept
  // alive by a MutationObserver: if anything removes it, it is re-added.
  var REFLOW_STYLE_ID = 'bt-hub-portrait-reflow';
  var REFLOW_CSS =
    'div[style*="grid-template-columns"]{grid-template-columns:repeat(2,minmax(0,1fr)) !important;' +
    'width:100% !important;max-width:100% !important;}' +
    'div:has(>div[style*="grid-template-columns"]){display:block !important;' +
    'overflow-y:auto !important;overflow-x:hidden !important;width:100% !important;}';

  function removeReflow() {
    var old = document.getElementById(REFLOW_STYLE_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  function applyReflow() {
    removeReflow();
    if (!isPortrait() || !isHubPage()) return;
    var parent = document.head || document.documentElement;
    if (!parent) return;
    var el = document.createElement('style');
    el.id = REFLOW_STYLE_ID;
    el.textContent = REFLOW_CSS;
    parent.appendChild(el);
  }

  var reflowObserver = null;
  function watchReflow() {
    if (reflowObserver) return;
    var root = document.documentElement;
    if (!root) return;
    reflowObserver = new MutationObserver(function () {
      if (!isPortrait() || !isHubPage()) return;
      if (!document.getElementById(REFLOW_STYLE_ID)) {
        applyReflow();
      }
      // Self-heal the actual layout, not just the style element's presence:
      // if the grid isn't computing to 2 columns, force it inline.
      var grids = document.querySelectorAll('div[style*="grid-template-columns"]');
      for (var i = 0; i < grids.length; i++) {
        var cs = getComputedStyle(grids[i]).gridTemplateColumns.split(/\s+/).length;
        if (cs !== 2) {
          grids[i].style.setProperty('grid-template-columns', 'repeat(2,minmax(0,1fr))', 'important');
          grids[i].style.setProperty('width', '100%', 'important');
          grids[i].style.setProperty('max-width', '100%', 'important');
          var wrap = grids[i].parentElement;
          if (wrap) {
            wrap.style.setProperty('display', 'block', 'important');
            wrap.style.setProperty('overflow-y', 'auto', 'important');
            wrap.style.setProperty('overflow-x', 'hidden', 'important');
          }
        }
      }
    });
    reflowObserver.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomContentLoaded);
  } else {
    applyRotation();
  }
  // Re-apply after full load too, in case the app rewrote root styles.
  window.addEventListener('load', applyRotation);

  // --- Corner swipe -> rotate button -------------------------------------
  // Touch coordinates arrive in *viewport* space: the metrics override holds
  // the viewport at a fixed 800x480 for every rotation, so the physical
  // bottom-right corner is the same zone in every rotation. Do not derive
  // this from the layout box (its coordinates never match touch points,
  // which made the swipe unreachable in portrait).
  function cornerZone() {
    var s = 140;
    var w = window.innerWidth;
    var h = window.innerHeight;
    return { x: w - s, y: h - s, w: s, h: s };
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
    btn.setAttribute('aria-label', 'Rotate display');
    var anchor = buttonAnchor();
    // 56px circular button with a rotate-phone glyph, no text label.
    var css =
      'position:fixed;z-index:2147483647;' +
      'width:56px;height:56px;padding:0;' +
      'border:1px solid rgba(255,255,255,0.25);border-radius:50%;' +
      'color:#fff;background:rgba(20,20,24,0.92);' +
      'box-shadow:0 4px 24px rgba(0,0,0,0.5);' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;';
    for (var k in anchor) css += k + ':' + anchor[k] + ';';
    btn.setAttribute('style', css);
    btn.innerHTML =
      '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>' +
      '<path d="M12 18h.01"/>' +
      '</svg>';
    btn.addEventListener('click', function () {
      var target = DEGREES === 0 ? 270 : 0;
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

  // --- Portrait swipe scrolling ------------------------------------------
  // In portrait the page is CSS-rotated, so the browser maps a portrait-
  // vertical swipe to a layout-horizontal gesture and the hub's vertical
  // grid never scrolls. Drag it manually from the touch movement instead.
  // The browser's mapped gesture is a horizontal no-op, so this never
  // double-scrolls. Landscape is untouched (native scrolling works there).
  var swipeScroll = null;

  function swipeScroller(target) {
    var el = target instanceof Element ? target : null;
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 1) {
        var oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function onSwipeTouchStart(e) {
    swipeScroll = null;
    if (!isPortrait() || !isHubPage()) return;
    var t = e.touches[0];
    if (!t) return;
    var scroller = swipeScroller(e.target);
    if (!scroller) return;
    swipeScroll = { y: t.clientY, scroller: scroller };
  }

  function onSwipeTouchMove(e) {
    if (!swipeScroll) return;
    var t = e.touches[0];
    if (!t) return;
    var dy = t.clientY - swipeScroll.y;
    swipeScroll.y = t.clientY;
    swipeScroll.scroller.scrollTop -= dy;
  }

  function onSwipeTouchEnd() {
    swipeScroll = null;
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
  document.addEventListener('touchmove', onSwipeTouchMove, { passive: true });
  document.addEventListener('touchend', onSwipeTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onSwipeTouchEnd, { passive: true });
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('DOMContentLoaded', onDomContentLoaded);
  window.addEventListener('load', applyRotation);

  window.__bridgethingRotation = {
    teardown: function () {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchstart', onSwipeTouchStart);
      document.removeEventListener('touchmove', onSwipeTouchMove);
      document.removeEventListener('touchend', onSwipeTouchEnd);
      document.removeEventListener('touchcancel', onSwipeTouchEnd);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('DOMContentLoaded', onDomContentLoaded);
      window.removeEventListener('load', applyRotation);
      hideButton();
      removeReflow();
      if (reflowObserver) {
        reflowObserver.disconnect();
        reflowObserver = null;
      }
      var root = document.documentElement;
      if (root) {
        root.style.transform = '';
        root.style.transformOrigin = '';
        root.style.width = '';
        root.style.height = '';
      }
      var body = document.body;
      if (body) {
        body.style.width = '';
        body.style.height = '';
      }
    },
  };
})();
