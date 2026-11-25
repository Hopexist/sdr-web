/**
 * @file SDR.shell — page shell shared by every page; load it FIRST (before the DSP scripts).
 *
 * - Global error banner: window.onerror / unhandledrejection show a dismissible banner and set
 *   <html data-error="…"> so CI can detect it.
 * - Theme: light / dark / system, stored in localStorage; sets <html data-theme> and fires 'sdr-themechange'.
 * - Keyboard shortcuts with a "?" overlay: Space (page action), R (reset), L (copy link), T (theme), Esc (close).
 * - First-visit tour: tour(steps) shows dismissible callouts once per page (localStorage, fails soft).
 * - Footer with version, repository and tests links; reducedMotion() for animation decisions.
 *
 * Public API (SDR.shell): VERSION, action(name, fn, label), tour(steps), showTour(), reducedMotion(),
 * toggleTheme(), storage (safe get/set).
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var VERSION = '1.0.0', REPO = 'https://github.com/Hopexist/sdr-web';
  SDR.VERSION = VERSION;

  var storage = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked: keep going */ } }
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // ---------- error banner ----------
  var banner = null;
  function showError(msg) {
    msg = String(msg || 'Unknown error').slice(0, 300);
    document.documentElement.setAttribute('data-error', msg);
    if (!document.body) return;
    if (!banner) {
      banner = el('div', 'error-banner');
      banner.setAttribute('role', 'alert');
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.textContent = '';
    banner.appendChild(el('span', '', 'Something went wrong: ' + msg + ' — '));
    var reload = el('button', 'btn', 'Reload'); reload.type = 'button'; reload.addEventListener('click', function () { location.reload(); });
    var report = el('a', '', 'report it'); report.href = REPO + '/issues/new?title=' + encodeURIComponent('Error: ' + msg.slice(0, 80));
    var close = el('button', 'icon-btn', '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Dismiss error');
    close.addEventListener('click', function () { banner.remove(); banner = null; });
    banner.appendChild(reload); banner.appendChild(document.createTextNode(' or ')); banner.appendChild(report); banner.appendChild(close);
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) return;   // resource load errors are not script errors
    showError(e.message || (e.error && e.error.message));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { showError(e.reason && e.reason.message ? e.reason.message : e.reason); });

  // ---------- theme ----------
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    window.dispatchEvent(new Event('sdr-themechange'));
  }
  function effectiveDark() {
    var t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function toggleTheme() { var t = effectiveDark() ? 'light' : 'dark'; storage.set('sdr-web.theme', t); applyTheme(t); }
  applyTheme(storage.get('sdr-web.theme'));

  function reducedMotion() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }

  // ---------- actions + shortcuts ----------
  var actions = {};
  function action(name, fn, label) { actions[name] = { fn: fn, label: label }; }
  var SHORTCUTS = [['Space', 'space', 'Play / stop, or run / pause'], ['R', 'reset', 'Reset to defaults'], ['L', 'link', 'Copy link to this setup'],
    ['T', 'theme', 'Toggle light / dark theme'], ['?', 'help', 'Show this list'], ['Esc', 'esc', 'Close overlays']];
  var overlay = null;
  function closeOverlays() { if (overlay) { overlay.remove(); overlay = null; } endTour(); }
  function showHelp() {
    closeOverlays();
    overlay = el('div', 'overlay');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Keyboard shortcuts');
    var box = el('div', 'overlay-box'), tbl = el('table', 'data');
    box.appendChild(el('h2', '', 'Keyboard shortcuts'));
    SHORTCUTS.forEach(function (s) {
      var a = s[1] === 'space' || s[1] === 'reset' || s[1] === 'link' ? actions[s[1]] : true;
      if (!a) return;
      var tr = el('tr'), k = el('td'), kb = el('kbd', '', s[0]);
      k.appendChild(kb); tr.appendChild(k); tr.appendChild(el('td', '', a.label || s[2])); tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    var ok = el('button', 'btn primary', 'Close'); ok.type = 'button'; ok.addEventListener('click', closeOverlays);
    box.appendChild(ok); overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlays(); });
    document.body.appendChild(overlay); ok.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (e.key === 'Escape') { closeOverlays(); return; }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;   // typing, not shortcuts
    var k = e.key;
    if (k === ' ' && tag !== 'BUTTON' && tag !== 'A' && actions.space) { e.preventDefault(); actions.space.fn(); }
    else if ((k === 'r' || k === 'R') && actions.reset) actions.reset.fn();
    else if ((k === 'l' || k === 'L') && actions.link) actions.link.fn();
    else if (k === 't' || k === 'T') toggleTheme();
    else if (k === '?') showHelp();
  });

  // ---------- tour ----------
  var tourSteps = [], tourBox = null, tourIdx = 0, tourTarget = null;
  function pageKey() { return 'sdr-web.tour.' + (location.pathname.split('/').pop() || 'index.html'); }
  function endTour(remember) {
    if (tourTarget) tourTarget.classList.remove('tour-target');
    if (tourBox) tourBox.remove();
    tourBox = null; tourTarget = null;
    if (remember) storage.set(pageKey(), 'done');
  }
  function stepTour(i) {
    endTour(false);
    var s = tourSteps[i];
    if (!s) { storage.set(pageKey(), 'done'); return; }
    var target = document.querySelector(s.sel);
    if (!target) { stepTour(i + 1); return; }
    tourIdx = i; tourTarget = target;
    target.classList.add('tour-target');
    target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    tourBox = el('div', 'tour-box');
    tourBox.setAttribute('role', 'dialog'); tourBox.setAttribute('aria-label', 'Tour, step ' + (i + 1) + ' of ' + tourSteps.length);
    tourBox.appendChild(el('p', 'tour-step', 'Step ' + (i + 1) + ' / ' + tourSteps.length));
    tourBox.appendChild(el('p', '', s.text));
    var row = el('div', 'btn-row');
    var next = el('button', 'btn primary', i + 1 < tourSteps.length ? 'Next' : 'Done'); next.type = 'button';
    next.addEventListener('click', function () { stepTour(i + 1); });
    var skip = el('button', 'btn', 'Skip tour'); skip.type = 'button'; skip.addEventListener('click', function () { endTour(true); });
    row.appendChild(next); row.appendChild(skip); tourBox.appendChild(row);
    document.body.appendChild(tourBox);
    setTimeout(function () {   // place next to the target (below it, or above if there is no room), clamped to the viewport
      if (!tourBox) return;
      var r = target.getBoundingClientRect(), bw = tourBox.offsetWidth, bh = tourBox.offsetHeight;
      var top = r.bottom + 10 + bh < innerHeight ? r.bottom + 10 : Math.max(8, r.top - bh - 10);
      tourBox.style.top = (top + scrollY) + 'px';
      tourBox.style.left = (Math.max(8, Math.min(innerWidth - bw - 8, r.left)) + scrollX) + 'px';
      next.focus();
    }, reducedMotion() ? 0 : 350);
  }
  function tour(steps) {
    tourSteps = steps;
    if (!storage.get(pageKey()) && !navigator.webdriver) setTimeout(function () { stepTour(0); }, 600);   // first visit (not under automation)
  }
  function showTour() { if (tourSteps.length) stepTour(0); }

  // ---------- footer ----------
  function footer() {
    var f = el('footer', 'site-footer');
    f.appendChild(el('span', '', 'sdr-web v' + VERSION));
    var links = [['Source on GitHub', REPO], ['Self-tests', 'tests.html']];
    links.forEach(function (l) { var a = el('a', '', l[0]); a.href = l[1]; f.appendChild(document.createTextNode(' · ')); f.appendChild(a); });
    [['Show tour', function () { showTour(); }, function () { return tourSteps.length; }], ['Keyboard shortcuts (?)', showHelp], ['Toggle theme (T)', toggleTheme]].forEach(function (b) {
      var x = el('button', 'link-btn', b[0]); x.type = 'button'; x.addEventListener('click', b[1]);
      if (b[2]) x.hidden = true, x.dataset.needsTour = '1';
      f.appendChild(document.createTextNode(' · ')); f.appendChild(x);
    });
    document.body.appendChild(f);
    setTimeout(function () { f.querySelectorAll('[data-needs-tour]').forEach(function (x) { x.hidden = !tourSteps.length; }); }, 0);
  }
  if (document.body) footer(); else document.addEventListener('DOMContentLoaded', footer);

  SDR.shell = { VERSION: VERSION, REPO: REPO, action: action, tour: tour, showTour: showTour, showHelp: showHelp, reducedMotion: reducedMotion,
    toggleTheme: toggleTheme, isDark: effectiveDark, storage: storage, showError: showError };
})();
