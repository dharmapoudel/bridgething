/* Hub launcher knob navigation (injected by the daemon).
 *
 * On the homepage the knob scrolls through the app tiles automatically:
 * knob rotation arrives as horizontal wheel events and moves a visible
 * highlight from tile to tile. A short knob press launches the highlighted
 * app; holding the knob down on a tile for UNINSTALL_HOLD_MS uninstalls that
 * app instead (the daemon tombstones it, so the tile stays gone across
 * reboots). No-op on any page that is not the hub launcher.
 */
(function () {
  'use strict';
  var _p = window.location.pathname;
  if (_p !== '/_hub' && _p.indexOf('/_hub/') !== 0) return;

  // The daemon re-registers this script with runImmediately on every rotation
  // change; without a guard each pass stacks another set of wheel listeners
  // and observers that fight over the highlight. Tear down the previous
  // instance first.
  var prev = window.__bridgethingKnob;
  if (prev && typeof prev.teardown === 'function') {
    try { prev.teardown(); } catch (e) {}
  }

  var HIGHLIGHT_CLASS = 'bt-knob-selected';
  var ENTER_DEBOUNCE_MS = 350;
  var UNINSTALL_HOLD_MS = 1500;
  var UNINSTALL_URL = '/_uninstall';
  var SETTINGS_LABEL = 'Settings';
  var NOFLASH_STYLE_ID = 'bt-knob-noflash';
  var highlight = -1;
  var lastEnterAt = 0;
  var pressStart = 0;
  var installed = false;
  var observer = null;
  var installTimer = null;

  function injectNoFlash() {
    // Single-border selection: the knob highlight brightens the tile's own
    // border instead of drawing an outline on top of it (which rendered as a
    // double border). A short border-color transition lets the highlight
    // glide between tiles; all other transitions stay off so a press never
    // flashes the tile white. Guarded so re-injection does not stack
    // duplicate style elements.
    if (document.getElementById(NOFLASH_STYLE_ID)) return;
    var noFlash = document.createElement('style');
    noFlash.id = NOFLASH_STYLE_ID;
    noFlash.textContent =
      'div.grid button[type="button"],div.grid button[type="button"] *{' +
      '-webkit-tap-highlight-color:transparent !important;' +
      '-webkit-user-drag:none !important;user-select:none !important;} ' +
      'div.grid button[type="button"]{' +
      'transition:border-color 120ms ease-out !important;} ' +
      'div.grid button[type="button"]:active{' +
      'background-color:var(--color-screen) !important;' +
      'border-color:var(--color-rule) !important;} ' +
      'div.grid button[type="button"].bt-knob-selected{' +
      'border-color:color-mix(in srgb, var(--color-edge) 75%, transparent) !important;} ' +
      'div.grid button[type="button"] img{pointer-events:none !important;}';
    (document.head || document.documentElement).appendChild(noFlash);
  }

  function tiles() {
    // App tiles and the settings tile are buttons inside the launcher grid.
    var grid = document.querySelector('div.grid');
    if (!grid) return [];
    return Array.prototype.filter.call(
      grid.querySelectorAll('button[type="button"]'),
      function (b) { return !b.disabled; }
    );
  }

  function clearHighlight() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.' + HIGHLIGHT_CLASS),
      function (el) {
        el.classList.remove(HIGHLIGHT_CLASS);
      }
    );
  }

  function applyHighlight(index) {
    clearHighlight();
    var list = tiles();
    if (list.length === 0) {
      highlight = -1;
      return;
    }
    highlight = Math.max(0, Math.min(list.length - 1, index));
    var el = list[highlight];
    el.classList.add(HIGHLIGHT_CLASS);
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function onWheel(e) {
    var list = tiles();
    if (list.length === 0) return;
    // The knob is a 1D rotary device and the only wheel source on the kiosk
    // (no touchpad to preserve); honor the dominant axis so no tick is lost.
    var ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
    if (ax === 0 && ay === 0) return;
    e.preventDefault();
    var dir = (ax >= ay ? e.deltaX : e.deltaY) > 0 ? 1 : -1;
    var next = highlight < 0 ? (dir > 0 ? 0 : list.length - 1)
      // Wrap around both ends; the + list.length keeps the JS %
      // non-negative. list is non-empty here (early return above).
      : (highlight + dir + list.length) % list.length;
    applyHighlight(next);
  }

  function tileLabel(tile) {
    // The tile button's direct-child span holds the app name; the fallback
    // icon renders its own nested span (the letter), so scope the query.
    var label = tile.querySelector(':scope > span');
    return label ? label.textContent.trim() : '';
  }

  function uninstallTile(tile) {
    var name = tileLabel(tile);
    // The settings tile is daemon chrome, not a webapp; nothing to remove.
    if (!name || name === SETTINGS_LABEL) return;
    tile.classList.add(HIGHLIGHT_CLASS);
    tile.style.borderColor = '#e5484d';
    fetch(UNINSTALL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).catch(function () {
      // The hub grid refreshes on the daemon's uninstalled broadcast; on a
      // failed request just restore the highlight so the tile looks normal.
      tile.style.borderColor = '';
      applyHighlight(highlight);
    });
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.repeat) return;
    var list = tiles();
    if (list.length === 0 || highlight < 0) return;
    // Do not click yet: a held press becomes an uninstall on keyup.
    // Repeats are ignored so the hold is measured from the first press.
    pressStart = Date.now();
  }

  function onKeyUp(e) {
    if (e.key !== 'Enter') return;
    var list = tiles();
    // Keyup without a tracked keydown (script loaded mid-press) counts as
    // a tap, never as a long press.
    var held = pressStart > 0 ? Date.now() - pressStart : 0;
    pressStart = 0;
    if (list.length === 0 || highlight < 0 || highlight >= list.length) return;
    if (held >= UNINSTALL_HOLD_MS) {
      uninstallTile(list[highlight]);
      return;
    }
    // A single knob press can arrive as two key events; debounce so we do
    // not launch twice.
    var now = Date.now();
    if (now - lastEnterAt < ENTER_DEBOUNCE_MS) return;
    lastEnterAt = now;
    list[highlight].click();
  }

  function install() {
    installed = true;
    injectNoFlash();
    // Tiles render asynchronously after the page loads; watch the DOM so the
    // highlight appears once they do and resets if the grid is replaced
    // (e.g. the launcher switches to its settings sub-view).
    observer = new MutationObserver(function () {
      var list = tiles();
      if (list.length === 0) {
        if (highlight !== -1) {
          clearHighlight();
          highlight = -1;
        }
      } else if (highlight < 0) {
        applyHighlight(0);
      } else if (highlight >= list.length) {
        applyHighlight(list.length - 1);
      }
    });

    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // A deferred install runs after the tiles are already parsed, so the
    // observer never sees them appear; highlight the first tile directly.
    if (highlight < 0) {
      var list = tiles();
      if (list.length > 0) applyHighlight(0);
    }
  }

  function teardown() {
    if (installTimer) { clearInterval(installTimer); installTimer = null; }
    window.removeEventListener('load', tryInstall);
    if (!installed) {
      document.removeEventListener('DOMContentLoaded', tryInstall);
      return;
    }
    installed = false;
    window.removeEventListener('wheel', onWheel, { capture: true });
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearHighlight();
    highlight = -1;
  }

  var self = { teardown: teardown };
  window.__bridgethingKnob = self;

  // Injected scripts run at document_start, before the document has a root
  // element; touching document.documentElement there throws and kills the
  // whole script, which left the knob dead after hub navigations (M home).
  // Defer the install until the document exists, and retry briefly: if a
  // re-injection raced page load and DOMContentLoaded was missed, the knob
  // would otherwise stay dead until the next rotation change.
  function tryInstall() {
    if (window.__bridgethingKnob !== self || installed) return;
    if (!document.documentElement) return;
    try { install(); } catch (e) {}
  }
  if (document.documentElement) {
    tryInstall();
  } else {
    document.addEventListener('DOMContentLoaded', tryInstall);
  }
  window.addEventListener('load', tryInstall);
  installTimer = setInterval(tryInstall, 1000);
  setTimeout(function () { clearInterval(installTimer); }, 30000);
})();
