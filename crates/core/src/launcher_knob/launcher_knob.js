/* Hub launcher knob navigation (injected by the daemon).
 *
 * On the homepage the knob scrolls through the app tiles automatically:
 * knob rotation arrives as horizontal wheel events and moves a visible
 * highlight from tile to tile; knob press arrives as Enter and launches
 * the highlighted app. No-op on any page that is not the hub launcher.
 */
(function () {
  'use strict';
  if (!window.location.pathname.startsWith('/_hub/')) return;

  var HIGHLIGHT_ATTR = 'data-knob-highlight';
  var ENTER_DEBOUNCE_MS = 350;
  var highlight = -1;
  var lastEnterAt = 0;

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
    el.style.outline = '2px solid #00a8e8';
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
    var next = highlight < 0 ? (dir > 0 ? 0 : list.length - 1) : highlight + dir;
    applyHighlight(next);
  }

  function onKey(e) {
    if (e.key !== 'Enter') return;
    var list = tiles();
    if (list.length === 0 || highlight < 0) return;
    // A single knob press can arrive as two key events; debounce so we do
    // not launch twice.
    var now = Date.now();
    if (now - lastEnterAt < ENTER_DEBOUNCE_MS) return;
    lastEnterAt = now;
    e.preventDefault();
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
  window.addEventListener('keydown', onKey, { capture: true });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
