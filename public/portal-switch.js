/*
 * portal-switch.js - one sign-in across the CES portals (CES, 8 Nov 2026, build 08a).
 *
 * CES, 7 Nov 2026: "for someone like adam to be able to switch between flex portal / sales portal
 * once he logs in within any of the portals so he doesnt have to relogin each time".
 *
 * Why he had to: Sales, Pricing, COT and Billing keep their Supabase session under one key on
 * billcesgb.com, but flex.html and flexclient.html kept theirs under another ('ces-flex-auth'), so
 * crossing between them was a second sign-in. From 08a every page uses the same key (the flex
 * pages move an old flex session across once, so nobody is signed out by the change), and this
 * file adds a Portals menu to each page listing the portals this login may open: my_portals(), the
 * one rule (migration _40/_41). Choosing one goes straight there, already signed in.
 *
 * Use, after the page's own script:
 *   <script src="/portal-switch.js?v=2026-11-08.1" data-portal="sales"></script>
 * It finds the page's Supabase client itself (sb, window.sb, FLEX.sb, CX.sb) and draws into every
 * element with a data-portal-switch attribute:
 *   data-ps-style="menu"   a button that opens a short list (headers, button rows)
 *   data-ps-style="list"   the links one under another (side menus)
 *   data-ps-class="..."    classes for the button or links, so they look like the page's own
 * A login with one portal sees nothing. Anything that goes wrong here leaves the page as it was.
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-08.1';
  var doc = root.document;
  var me = doc.currentScript;
  var CURRENT = (me && me.getAttribute('data-portal')) || '';
  var PORTALS = {
    sales: ['Sales portal', '/sales.html'],
    flex: ['Flex portal', '/flex.html'],
    pricing: ['Pricing desk', '/pricing.html'],
    cot: ['COT desk', '/cot.html'],
    billing: ['Billing portal', '/'],
    flexclient: ['Flex client portal', '/flexclient.html'],
  };
  var ORDER = ['sales', 'flex', 'pricing', 'cot', 'billing', 'flexclient'];
  var STYLES = [
    '.ps-menu{position:relative;display:inline-block}',
    '.ps-pop{position:absolute;right:0;top:calc(100% + 6px);min-width:190px;background:#fff;color:#1d2a4d;border:1px solid #d5dbea;',
    'border-radius:10px;box-shadow:0 10px 28px rgba(16,24,48,.18);padding:6px;z-index:2147483000;text-align:left}',
    '.ps-pop[hidden]{display:none}',
    '.ps-pop .ps-h{font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6b7894;padding:6px 10px 4px}',
    '.ps-pop a{display:block;padding:8px 10px;border-radius:7px;color:#1d2a4d;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap}',
    '.ps-pop a:hover,.ps-pop a:focus{background:#eef4ff;outline:none}',
    '.ps-list{margin:0 0 8px}',
    '.ps-list .ps-h{font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.7;margin:0 0 6px}',
    '.ps-list a{display:block;text-align:center;text-decoration:none;background:#eef1fb;color:#232e63;border:1px solid #c7cde8;',
    'border-radius:8px;padding:8px 10px;margin:0 0 6px;font-size:12.5px;font-weight:700}',
    '.ps-list a:hover,.ps-list a:focus{background:#e2e8fb}',
    '.ps-float{position:fixed;left:12px;bottom:12px;z-index:2147482000}',
    '.ps-float .ps-pop{left:0;right:auto;top:auto;bottom:calc(100% + 6px)}',
  ].join('');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /** The page's own Supabase client, wherever the page keeps it. */
  function client() {
    try { if (typeof sb !== 'undefined' && sb && sb.auth) return sb; } catch (_) { /* not declared */ }
    try { if (root.sb && root.sb.auth) return root.sb; } catch (_) { /* no */ }
    try { if (typeof FLEX !== 'undefined' && FLEX && FLEX.sb) return FLEX.sb; } catch (_) { /* not the flex desk */ }
    try { if (typeof CX !== 'undefined' && CX && CX.sb) return CX.sb; } catch (_) { /* not the flex client page */ }
    return null;
  }

  /** my_portals() as the places to go: never the page itself, Billing once even for an admin. */
  function targets(list) {
    var have = {};
    (list || []).forEach(function (p) { have[p === 'admin' ? 'billing' : p] = true; });
    return ORDER.filter(function (k) { return have[k] && k !== CURRENT; });
  }

  function injectStyles() {
    if (doc.getElementById('psStyles')) return;
    var s = doc.createElement('style'); s.id = 'psStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }

  var OPEN = null;
  function closeAll() { if (OPEN) { OPEN.pop.hidden = true; OPEN.btn.setAttribute('aria-expanded', 'false'); OPEN = null; } }

  function links(keys) {
    return keys.map(function (k) { return '<a role="menuitem" href="' + esc(PORTALS[k][1]) + '" data-ps-go="' + esc(k) + '">' + esc(PORTALS[k][0]) + '</a>'; }).join('');
  }

  function drawMenu(slot, keys, floating) {
    var cls = slot.getAttribute('data-ps-class') || '';
    slot.innerHTML = '<span class="ps-menu"><button type="button" class="' + esc(cls) + '" aria-haspopup="true" aria-expanded="false" title="Open another CES portal without signing in again">Portals &#9662;</button>'
      + '<span class="ps-pop" role="menu" hidden><div class="ps-h">Go to</div>' + links(keys) + '</span></span>';
    var btn = slot.querySelector('button'), pop = slot.querySelector('.ps-pop');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.hidden;
      closeAll();
      if (open) { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); OPEN = { pop: pop, btn: btn }; var a = pop.querySelector('a'); if (a) a.focus(); }
    });
    if (floating) slot.classList.add('ps-float');
  }

  function drawList(slot, keys) {
    var cls = slot.getAttribute('data-ps-class') || '';
    slot.innerHTML = '<div class="ps-list"><div class="ps-h">Other portals</div>' + keys.map(function (k) {
      return '<a href="' + esc(PORTALS[k][1]) + '" data-ps-go="' + esc(k) + '"' + (cls ? ' class="' + esc(cls) + '"' : '') + '>' + esc(PORTALS[k][0]) + ' &rarr;</a>';
    }).join('') + '</div>';
  }

  function draw(keys) {
    var slots = Array.prototype.slice.call(doc.querySelectorAll('[data-portal-switch]'));
    var float = doc.getElementById('psFloat');
    if (!keys.length) {
      slots.forEach(function (s) { s.innerHTML = ''; });
      if (float) float.remove();
      return;
    }
    injectStyles();
    if (!slots.length) {
      if (!float) { float = doc.createElement('div'); float.id = 'psFloat'; float.setAttribute('data-ps-style', 'menu'); doc.body.appendChild(float); }
      drawMenu(float, keys, true);
      return;
    }
    slots.forEach(function (s) { if (s.getAttribute('data-ps-style') === 'list') drawList(s, keys); else drawMenu(s, keys, false); });
  }

  var LAST_USER = null, BUSY = false;
  function refresh(session) {
    var c = client();
    if (!c) return;
    var uid = session && session.user ? session.user.id : null;
    if (!uid) { LAST_USER = null; draw([]); return; }
    if (uid === LAST_USER || BUSY) return;
    BUSY = true;
    Promise.resolve(c.rpc('my_portals')).then(function (r) {
      BUSY = false;
      if (r && !r.error) { LAST_USER = uid; API.portals = r.data || []; draw(targets(r.data)); }
    }).catch(function () { BUSY = false; });
  }

  function start() {
    var c = client();
    if (!c || !c.auth) return false;
    try {
      c.auth.onAuthStateChange(function (event, session) {
        if (event === 'SIGNED_OUT') { LAST_USER = null; draw([]); return; }
        // Not inside the callback: supabase-js holds a lock while it runs (a deadlock otherwise).
        setTimeout(function () { refresh(session); }, 0);
      });
      Promise.resolve(c.auth.getSession()).then(function (r) { refresh(r && r.data ? r.data.session : null); }).catch(function () { /* signed out */ });
    } catch (_) { return false; }
    return true;
  }

  doc.addEventListener('click', function (e) { if (OPEN && !OPEN.pop.contains(e.target)) closeAll(); });
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

  var API = { VERSION: VERSION, current: CURRENT, portals: null, targets: targets, refresh: function () { LAST_USER = null; var c = client(); if (c) c.auth.getSession().then(function (r) { refresh(r.data.session); }); } };
  root.PortalSwitch = API;

  // The page's client may be made after this file runs: try now, then for a few seconds.
  function boot() {
    if (start()) return;
    var n = 0, t = setInterval(function () { if (start() || ++n > 40) clearInterval(t); }, 250);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
