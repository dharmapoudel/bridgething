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
  if (!window.location.pathname.startsWith('/_hub/')) return;

  var HIGHLIGHT_ATTR = 'data-knob-highlight';
  var ENTER_DEBOUNCE_MS = 350;
  var UNINSTALL_HOLD_MS = 1500;
  var UNINSTALL_URL = '/_uninstall';
  var SETTINGS_LABEL = 'Settings';
  var highlight = -1;
  var lastEnterAt = 0;
  var pressStart = 0;

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
      document.querySelectorAll('[' + HIGHLIGHT_ATTR + ']'),
      function (el) {
        el.removeAttribute(HIGHLIGHT_ATTR);
        el.style.outline = '';
        el.style.outlineOffset = '';
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
    el.setAttribute(HIGHLIGHT_ATTR, 'true');
    el.style.outline = '2px solid #404243';
    el.style.outlineOffset = '2px';
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function onWheel(e) {
    var list = tiles();
    if (list.length === 0) return;
    // Knob rotation arrives as horizontal wheel events; ignore vertical ones
    // so touchpad-style vertical scrolling keeps working.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    var dir = e.deltaX > 0 ? 1 : -1;
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
    tile.style.outline = '2px solid #e5484d';
    tile.style.outlineOffset = '2px';
    fetch(UNINSTALL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).catch(function () {
      // The hub grid refreshes on the daemon's uninstalled broadcast; on a
      // failed request just restore the highlight so the tile looks normal.
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

  // Tiles render asynchronously after the page loads; watch the DOM so the
  // highlight appears once they do and resets if the grid is replaced
  // (e.g. the launcher switches to its settings sub-view).
  var observer = new MutationObserver(function () {
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
})();
