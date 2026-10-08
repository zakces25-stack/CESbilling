/* =========================================================================================
   flex-accounts.js  |  the Client Accounts tab on the flex desk (flex.html)

   Round 34 (Dan) built this tab as a read-only list of who can sign in to the flex client
   portal. This file carries that list over unchanged in substance and adds what the desk
   asked for on 7 Oct 2026, so nobody has to open Supabase to look after a flex client:

     + New customer   company, customer ID, username, password, contact name and email,
                      and the baskets they see, in one form. Creates the customer row, the
                      login and the basket shares together, or nothing at all.
     Edit baskets     tick / untick what an existing client sees.
     Reset password   for a client who has lost theirs (flex clients have no reset of their
                      own: @portal.cesgb.com has no mailbox).
     Edit details     company name, contact name and contact email.

   WHO: everyone on the flex desk. Nothing here is a permission check. Every call goes to a
   database function (migration _42) or the edge function flex-client-admin, and each of
   those checks is_flex_team() itself and refuses anything that is not a plain client login
   of a flex-only customer. Hiding a button is a courtesy, never the protection.

   PASSWORDS: generated here with crypto.getRandomValues, shown once, sent once, and never
   stored, logged or put in the edit log. The field is type="text" on purpose: a
   type="password" box makes the browser offer to save it as the DESK user's own password
   for this site.

   LOADED BY: flex.html, <script src="flex-accounts.js?v=VERSION">. The ?v= must equal
   VERSION below (tests/flex_accounts_render_test.js checks it). flex.html's
   fxRenderClientAccounts() calls FlexAccounts.render(tabElement).

   USES FROM flex.html, at call time only: FLEX.sb (the signed-in supabase client) and
   fxToast(). Nothing else, so Dan's own edits to flex.html cannot break it.
   ========================================================================================= */
(function () {
  'use strict';

  var VERSION = '2026-10-07.1';
  var FN_NAME = 'flex-client-admin';
  var PORTAL_URL = 'https://billcesgb.com/flex';
  var PORTAL_SHOWN = 'billcesgb.com/flex';

  // Non-ASCII only ever as escapes, so the file cannot be mis-decoded whatever charset the
  // server labels it with.
  var TICK = '\u2713', CROSS = '\u00d7', DOT = '\u00b7', ELL = '\u2026', MINUS = '\u2212';

  /* ---------------------------------------------------------------------------------------
     RULES: the same patterns as rules.ts (edge function) and migration _42. The test suite
     runs one list of examples through all three.
     --------------------------------------------------------------------------------------- */
  var CUSTOMER_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var USERNAME_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var PASSWORD_MIN = 10, PASSWORD_MAX = 72;

  function squish(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); }
  function byteLen(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return String(s).length; } }

  function checkCompany(v) {
    var s = squish(v);
    if (!s) return { ok: false, error: 'Company name is required.' };
    if (s.length < 2 || s.length > 120) return { ok: false, error: 'Company name must be 2 to 120 characters.' };
    return { ok: true, value: s };
  }
  function checkCustomerId(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return { ok: false, error: 'Customer ID is required.' };
    if (s.length < 2 || s.length > 40 || !CUSTOMER_ID_RE.test(s)) {
      return { ok: false, error: 'Use 2 to 40 lower-case letters and numbers, with single hyphens between them.' };
    }
    return { ok: true, value: s };
  }
  function checkUsername(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return { ok: false, error: 'Username is required.' };
    if (s.length < 3 || s.length > 40 || !USERNAME_RE.test(s)) {
      return { ok: false, error: 'Use 3 to 40 lower-case letters and numbers (a single . _ or - between them is fine).' };
    }
    return { ok: true, value: s };
  }
  function checkPassword(p, username) {
    p = typeof p === 'string' ? p : '';
    if (!p) return { ok: false, error: 'Password is required.' };
    if (/\s/.test(p)) return { ok: false, error: 'No spaces, please: they get lost when a password is copied or read out.' };
    if (p.length < PASSWORD_MIN) return { ok: false, error: 'At least ' + PASSWORD_MIN + ' characters (' + p.length + ' so far).' };
    if (byteLen(p) > PASSWORD_MAX) return { ok: false, error: PASSWORD_MAX + ' characters at most.' };
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return { ok: false, error: 'Needs at least one letter and one number.' };
    if (username && username.length >= 3 && p.toLowerCase().indexOf(String(username).toLowerCase()) >= 0) {
      return { ok: false, error: 'Must not contain the username.' };
    }
    return { ok: true, value: p };
  }
  function checkEmail(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return { ok: true, value: null };
    if (s.length > 254 || !EMAIL_RE.test(s)) return { ok: false, error: 'That email address does not look right.' };
    return { ok: true, value: s };
  }
  function checkName(v) {
    var s = squish(v);
    if (s.length > 120) return { ok: false, error: '120 characters at most.' };
    return { ok: true, value: s || null };
  }

  /* ---------------------------------------------------------------------------------------
     NAMES: a short customer ID / username from the company name, and the client a basket
     belongs to, read from the basket's name (flex_baskets.customer is empty on every row).
     --------------------------------------------------------------------------------------- */
  // Legal and filler words that never identify a client. "Country Court Care Homes" ->
  // countrycourt, "Orida Corporation Ltd" -> orida, "Pulsant Limited" -> pulsant: the three
  // ids CES chose by hand before this page existed.
  var LEGAL = { ltd: 1, limited: 1, plc: 1, llp: 1, lp: 1, llc: 1, inc: 1, corp: 1, corporation: 1, co: 1,
    company: 1, group: 1, holdings: 1, holding: 1, uk: 1, the: 1, and: 1 };
  function words(s) {
    var t = String(s == null ? '' : s).toLowerCase();
    try { t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return t.match(/[a-z0-9]+/g) || [];
  }
  function idFromCompany(name) {
    var w = words(name), kept = w.filter(function (x) { return !LEGAL[x]; });
    if (!kept.length) kept = w;
    return kept.slice(0, 2).join('').slice(0, 40);
  }
  // A basket's name runs client first, then supplier and commodity: "Excelcare BGS Power
  // Basket", "Trigon Snacks SEFE Gas Basket", "Brayford Power BGS". Everything before the
  // first supplier / commodity / filler word is the client.
  var STOP = { bgs: 1, sefe: 1, te: 1, total: 1, totalenergies: 1, edf: 1, eon: 1, npower: 1, corona: 1, sse: 1,
    shell: 1, brook: 1, green: 1, power: 1, gas: 1, elec: 1, electric: 1, electricity: 1, basket: 1, baskets: 1,
    cashout: 1, sa: 1, side: 1, flex: 1 };
  function stemOf(name) {
    var w = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean), out = [];
    for (var i = 0; i < w.length; i++) {
      var k = w[i].toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (i > 0 && (STOP[k] || /^\d+$/.test(k) || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-?\d{2}$/.test(k))) break;
      out.push(w[i]);
    }
    return out.join(' ').replace(/[\s\/,&+-]+$/, '').trim() || (w[0] || '');
  }
  // The word two names must share to be "the same client": the first word that is not "the".
  function keyOf(s) {
    var w = words(s);
    for (var i = 0; i < w.length; i++) if (w[i] !== 'the') return w[i];
    return '';
  }
  // Baskets no client can see yet, grouped by the client their name points at. These are the
  // likely next logins, so each group gets a one-click "Set up login".
  function waitingGroups(cat) {
    var by = {};
    (cat || []).forEach(function (b) {
      if (b.archived || b.is_ces || (b.shared_with && b.shared_with.length)) return;
      var st = stemOf(b.name), k = keyOf(st);
      if (!k) return;
      if (!by[k]) by[k] = { key: k, stems: {}, baskets: [] };
      by[k].baskets.push(b);
      by[k].stems[st] = (by[k].stems[st] || 0) + 1;
    });
    return Object.keys(by).map(function (k) {
      var g = by[k];
      g.name = Object.keys(g.stems).sort(function (a, b) {
        return (g.stems[b] - g.stems[a]) || (a.length - b.length) || a.localeCompare(b);
      })[0];
      g.baskets.sort(byName);
      return g;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function byName(a, b) { return String(a.name).localeCompare(String(b.name)); }

  /* ---------------------------------------------------------------------------------------
     PASSWORDS: 12 characters in three groups of four, from a set with no look-alikes (no
     0/O, 1/l/I), always mixing upper, lower and a digit: about 70 bits, easy to read out.
     --------------------------------------------------------------------------------------- */
  var PW_SET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  function genPassword() {
    var c = window.crypto, s = '';
    for (var tries = 0; tries < 64; tries++) {
      var a = new Uint32Array(12);
      c.getRandomValues(a);
      s = '';
      for (var i = 0; i < 12; i++) { if (i && i % 4 === 0) s += '-'; s += PW_SET.charAt(a[i] % PW_SET.length); }
      if (/[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return s;
    }
    return s;
  }

  /* ---------------------------------------------------------------------------------------
     SMALL HELPERS
     --------------------------------------------------------------------------------------- */
  function esc(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function sb() { try { return (typeof FLEX !== 'undefined' && FLEX && FLEX.sb) ? FLEX.sb : null; } catch (e) { return null; } }
  function toast(msg, good) { try { if (typeof fxToast === 'function') fxToast(msg, good !== false); } catch (e) {} }
  function announce(msg) { var el = document.getElementById('fxaLive'); if (el) { el.textContent = ''; setTimeout(function () { el.textContent = msg; }, 30); } }
  function comTag(c) {
    var gas = c === 'gas';
    return '<span class="fxa-com ' + (gas ? 'fxa-com-gas' : 'fxa-com-power') + '">' + (gas ? 'Gas' : 'Power') + '</span>';
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthLabel(iso) { var m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? MON[+m[2] - 1] + ' ' + m[1] : ''; }
  function when(ts) {
    if (!ts) return '<span class="fxa-muted">never</span>';
    var d = new Date(ts); if (isNaN(d)) return '';
    var days = Math.floor((Date.now() - d.getTime()) / 86400000);
    var rel = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? days + ' days ago' : Math.round(days / 30) + ' months ago';
    var abs = d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return '<span title="' + esc(abs) + '">' + esc(rel) + '</span>';
  }
  function dateOnly(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* ---------------------------------------------------------------------------------------
     SERVER CALLS
     supabase-js puts a failed edge function's body in error.context (a Response), not in
     data, and error.message is always the same useless sentence. callFn() reads the body,
     so the desk sees the function's own reason.
     --------------------------------------------------------------------------------------- */
  function dbMessage(err) {
    var code = err && err.code, msg = (err && err.message) || 'Unknown error.';
    if (code === 'PGRST202' || /could not find the function/i.test(msg)) {
      return 'The database part of Client Accounts is not installed yet (migration _42).';
    }
    if (code === '42501') return /flex desk/i.test(msg) ? msg : 'Your login is not allowed to do this. Client Accounts is for the flex desk.';
    if (/failed to fetch|networkerror|network request/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
    if (/jwt|refresh token|expired/i.test(msg)) return 'Your session has expired. Refresh the page and sign in again.';
    return msg;
  }
  async function rpc(name, args) {
    var c = sb();
    if (!c) return { data: null, error: { message: 'You are not signed in to the flex desk.' } };
    try { var r = await c.rpc(name, args || {}); return { data: r.data, error: r.error || null }; }
    catch (e) { return { data: null, error: { message: String((e && e.message) || e) } }; }
  }
  async function callFn(body) {
    var c = sb();
    if (!c) return { ok: false, error: 'You are not signed in to the flex desk.' };
    var r;
    try { r = await c.functions.invoke(FN_NAME, { body: body }); }
    catch (e) { return { ok: false, network: true, error: 'Could not reach the server.' }; }
    if (!r.error) {
      var d = r.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
      if (d && d.ok) return d;
      return { ok: false, error: (d && d.error) || 'The server gave an answer this page did not understand.', field: d && d.field, code: d && d.code };
    }
    var ctx = r.error.context, status = ctx && typeof ctx.status === 'number' ? ctx.status : 0, parsed = null;
    if (ctx && typeof ctx.text === 'function') {
      try {
        var t = await ctx.text();
        try { parsed = JSON.parse(t); } catch (e) { parsed = null; }
      } catch (e) { parsed = null; }
    }
    if (!status) return { ok: false, network: true, error: 'Could not reach the server.' };
    var msg = parsed && parsed.error ? String(parsed.error)
      : status === 401 ? 'Your session has expired. Refresh the page and sign in again.'
      : status === 403 ? 'Your login is not allowed to do this.'
      : status === 404 ? 'The Client Accounts server function (flex-client-admin) is not deployed.'
      : status >= 500 ? 'The server failed (' + status + '). Nothing was changed.'
      : (r.error.message || 'Something went wrong.');
    return { ok: false, status: status, error: msg, field: parsed && parsed.field, code: parsed && parsed.code,
             cleaned_up: parsed && parsed.cleaned_up };
  }

  /* ---------------------------------------------------------------------------------------
     STATE
     --------------------------------------------------------------------------------------- */
  var S = {
    host: null,          // #main-tab-clientaccounts
    rows: null,          // flex_client_accounts()
    err: null,           // its error
    at: 0,               // when it last loaded
    cat: null,           // flex_client_basket_catalog()
    catErr: null,
    q: '', issues: false,
    loading: false, stale: false,
    chan: null, rt: 0,
    waitOpen: true
  };
  try { S.waitOpen = window.localStorage.getItem('fxa-wait-open') !== '0'; } catch (e) {}

  // What a login's state means for the person trying to use it. Dan's round-34 rule: the
  // first problem found wins, in the order someone would hit it.
  function statusOf(r, g) {
    var scope = g.portal_scope || [];
    var live = (g.baskets || []).filter(function (b) { return !b.archived; });
    if (!r.user_id) return { key: 'nologin', bad: true, label: 'No login yet',
      tip: (live.length ? 'Baskets are shared with this customer but nobody can sign in.' : 'Nobody can sign in, and nothing is shared yet.')
        + ' A login for an existing customer is made in the billing admin console (Customers).' };
    if (r.is_admin || (r.role && r.role !== 'customer')) return { key: 'notclient', bad: true, label: 'Not a client login',
      tip: 'This account is linked to the customer but is ' + (r.is_admin ? 'an admin' : 'role "' + r.role + '"') + '. It opens the desk, not the client portal.' };
    if (r.banned_until && new Date(r.banned_until) > new Date()) return { key: 'disabled', bad: true, label: 'Login disabled',
      tip: 'This login has been disabled in Supabase, so it cannot sign in.' };
    if (!r.confirmed_at) return { key: 'unconfirmed', bad: true, label: 'Login not confirmed',
      tip: 'The login exists but is not confirmed, so it cannot sign in. Confirm it in Supabase (Authentication, Users).' };
    if (scope.indexOf('flex') < 0) return { key: 'noflex', bad: true, label: 'Flex not ticked',
      tip: 'Tick Flex for this customer in the billing admin console (Customers).' };
    if (!live.length) return { key: 'nobaskets', bad: true, label: 'No baskets shared',
      tip: 'They can sign in but have nothing to see. Use Edit baskets to share at least one.' };
    if (!r.last_sign_in_at) return { key: 'ready', bad: false, label: 'Ready ' + DOT + ' never signed in',
      tip: 'Everything is in place; they have not signed in yet.' };
    return { key: 'active', bad: false, label: 'Active', tip: 'Signed in at least once and set up correctly.' };
  }

  function groupsOf(rows) {
    var by = new Map();
    (rows || []).forEach(function (r) {
      var k = r.customer_id;
      if (!by.has(k)) {
        by.set(k, { customer_id: k, company_name: r.company_name || k, portal_scope: r.portal_scope || [],
          baskets: Array.isArray(r.baskets) ? r.baskets : [], flex_only: !!r.flex_only,
          created_at: r.customer_created_at || null, logins: [] });
      }
      by.get(k).logins.push(r);
    });
    var out = Array.from(by.values());
    out.forEach(function (g) {
      g.logins.sort(function (a, b) { return String(a.username || '').localeCompare(String(b.username || '')); });
      g.logins.forEach(function (l) { l._st = statusOf(l, g); });
      g.issues = g.logins.filter(function (l) { return l._st.bad; }).length;
    });
    return out.sort(function (a, b) { return String(a.company_name).localeCompare(String(b.company_name)); });
  }

  function matches(g, q) {
    if (!q) return true;
    var hay = [g.company_name, g.customer_id]
      .concat((g.baskets || []).map(function (b) { return b.name; }))
      .concat(g.logins.map(function (l) { return [l.username, l.display_name, l.contact_email].join(' '); }))
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  function normCat(data) {
    return (Array.isArray(data) ? data : []).map(function (b) {
      return { id: String(b.id), name: String(b.name || b.id), commodity: b.commodity === 'gas' ? 'gas' : 'power',
        is_ces: !!b.is_ces, archived: !!b.archived, sort_order: b.sort_order,
        first_month: b.first_month || null, last_month: b.last_month || null,
        months: +b.months || 0, sites: +b.sites || 0,
        shared_with: Array.isArray(b.shared_with) ? b.shared_with : [] };
    }).sort(byName);
  }
  function catById(id) { var c = S.cat || []; for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i]; return null; }
  function findLogin(uid) {
    var gs = groupsOf(S.rows);
    for (var i = 0; i < gs.length; i++) {
      for (var j = 0; j < gs[i].logins.length; j++) if (gs[i].logins[j].user_id === uid) return { g: gs[i], l: gs[i].logins[j] };
    }
    return null;
  }

  /* ---------------------------------------------------------------------------------------
     LOADING
     --------------------------------------------------------------------------------------- */
  var inflight = null;
  function refresh(userAsked) {
    if (inflight) return inflight;
    inflight = (async function () {
      S.loading = true;
      paintBody();
      var res = await Promise.all([rpc('flex_client_accounts'), rpc('flex_client_basket_catalog')]);
      var a = res[0], c = res[1];
      if (a.error) S.err = a.error; else { S.err = null; S.rows = Array.isArray(a.data) ? a.data : []; S.at = Date.now(); }
      if (c.error) S.catErr = dbMessage(c.error); else { S.catErr = null; S.cat = normCat(c.data); }
      S.loading = false; S.stale = false;
      paintBody();
      if (userAsked) announce(a.error ? 'Could not refresh client accounts' : 'Client accounts refreshed');
    })();
    inflight.then(function () { inflight = null; }, function () { inflight = null; });
    return inflight;
  }

  // Another person on the desk changed an account: refresh, unless this person is mid-form,
  // in which case refresh as soon as their dialog closes.
  function startRealtime() {
    var c = sb();
    if (S.chan || !c || typeof c.channel !== 'function') return;
    try {
      S.chan = c.channel('fxa-client-accounts')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'flex_audit', filter: 'table_name=eq.client_accounts' },
            function () { onRemoteChange(); })
        .subscribe();
    } catch (e) { S.chan = null; }
  }
  function onRemoteChange() {
    if (DLG) { S.stale = true; return; }
    clearTimeout(S.rt);
    S.rt = setTimeout(function () {
      if (S.host && S.host.classList.contains('active')) refresh(); else S.stale = true;
    }, 700);
  }

  /* ---------------------------------------------------------------------------------------
     THE TAB
     --------------------------------------------------------------------------------------- */
  function render(el) {
    if (!el) return;
    injectCss();
    S.host = el;
    if (!el.dataset.fxaRendered) {
      el.dataset.fxaRendered = '1';
      el.innerHTML = shellHtml();
      bindShell(el);
      startRealtime();
      return refresh();
    }
    if (S.stale || !S.at || Date.now() - S.at > 60000) return refresh();
  }

  function shellHtml() {
    return '<div class="fxa-root extra-tab-inner">'
      + '<div class="fxa-top">'
      +   '<div class="fxa-top-t"><h2 class="overview-title fxa-h">Client Accounts</h2>'
      +   '<p class="overview-sub">Set up flex clients, choose the baskets each one sees, and reset their passwords.</p></div>'
      +   '<button type="button" class="fxa-primary" data-act="new">+ New customer</button>'
      + '</div>'
      + '<div class="fxa-tools">'
      +   '<input id="fxaQ" class="fxa-input fxa-search" type="search" placeholder="Search company, login, email or basket"'
      +     ' aria-label="Search client accounts" autocomplete="off" spellcheck="false">'
      +   '<label class="fxa-check"><input id="fxaIssues" type="checkbox"> Needs attention only</label>'
      +   '<button type="button" class="fx-btn fxa-btn" data-act="refresh">Refresh</button>'
      + '</div>'
      + '<div id="fxaBody"></div>'
      + '<p class="fxa-foot">Every change made here goes in the desk\'s edit log. A customer that also uses the billing portal'
      +   ' keeps its logins in the billing admin console, so its rows have no buttons here.</p>'
      + '<div id="fxaLive" class="fxa-sr" aria-live="polite"></div>'
      + '</div>';
  }

  function bindShell(el) {
    var q = el.querySelector('#fxaQ'), iss = el.querySelector('#fxaIssues');
    q.value = S.q; iss.checked = S.issues;
    var t = 0;
    q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { S.q = q.value.trim(); paintBody(); }, 120); });
    iss.addEventListener('change', function () { S.issues = iss.checked; paintBody(); });
    el.addEventListener('click', onHostClick);
  }

  function onHostClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !S.host || !S.host.contains(b)) return;
    var act = b.getAttribute('data-act');
    if (act === 'new') openWizard({});
    else if (act === 'refresh') refresh(true);
    else if (act === 'retry') refresh(true);
    else if (act === 'wait-toggle') {
      S.waitOpen = !S.waitOpen;
      try { window.localStorage.setItem('fxa-wait-open', S.waitOpen ? '1' : '0'); } catch (err) {}
      paintBody();
    } else if (act === 'setup') {
      var key = b.getAttribute('data-key');
      var grp = waitingGroups(S.cat).filter(function (x) { return x.key === key; })[0];
      if (grp) openWizard({ company: grp.name, baskets: grp.baskets.map(function (x) { return x.id; }) });
    } else if (act === 'baskets') openBaskets(b.getAttribute('data-cid'));
    else if (act === 'reset') openReset(b.getAttribute('data-uid'));
    else if (act === 'details') openDetails(b.getAttribute('data-uid'));
  }

  // Re-render the list, putting keyboard focus back on the same control if it was inside.
  function paintBody() {
    var host = S.host && S.host.querySelector('#fxaBody');
    if (!host) return;
    var a = document.activeElement, sig = null;
    if (a && host.contains(a) && a.getAttribute) {
      sig = ['data-act', 'data-key', 'data-cid', 'data-uid'].map(function (k) { return a.getAttribute(k) || ''; });
    }
    host.innerHTML = bodyHtml();
    host.setAttribute('aria-busy', S.loading ? 'true' : 'false');
    if (sig && sig[0]) {
      // Escaped: these are database values (a customer ID with a quote in it must not be able
      // to steer focus onto another row's button).
      var q = function (v) { return (window.CSS && window.CSS.escape) ? window.CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'); };
      var sel = '[data-act="' + q(sig[0]) + '"]' + (sig[1] ? '[data-key="' + q(sig[1]) + '"]' : '')
        + (sig[2] ? '[data-cid="' + q(sig[2]) + '"]' : '') + (sig[3] ? '[data-uid="' + q(sig[3]) + '"]' : '');
      var back = null;
      try { back = host.querySelector(sel); } catch (e) { back = null; }
      if (back) back.focus();
    }
  }

  function bodyHtml() {
    if (!S.rows && !S.err) return '<div class="fxa-empty">Loading client accounts' + ELL + '</div>';
    if (S.err && !S.rows) return loadErrorHtml(S.err);
    var groups = groupsOf(S.rows);
    var logins = 0, recent = 0, issues = 0;
    groups.forEach(function (g) {
      issues += g.issues;
      g.logins.forEach(function (l) {
        if (!l.user_id) return;
        logins++;
        if (l.last_sign_in_at && (Date.now() - new Date(l.last_sign_in_at).getTime()) < 30 * 86400000) recent++;
      });
    });
    var shown = groups.filter(function (g) { return matches(g, S.q) && (!S.issues || g.issues); });
    var updated = S.at ? new Date(S.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    var sum = '<div class="fxa-sum-line">'
      + '<span><b>' + groups.length + '</b> client' + (groups.length === 1 ? '' : 's') + '</span>'
      + '<span><b>' + logins + '</b> login' + (logins === 1 ? '' : 's') + '</span>'
      + '<span><b>' + recent + '</b> signed in within 30 days</span>'
      + (issues ? '<span class="fxa-bad-t"><b>' + issues + '</b> need' + (issues === 1 ? 's' : '') + ' attention</span>' : '')
      + '<span class="fxa-muted">' + (S.loading ? 'Refreshing' + ELL : 'Updated ' + esc(updated)) + '</span>'
      + '</div>';
    var errNote = S.err ? '<div class="fxa-note-bad" role="alert">Could not refresh: ' + esc(dbMessage(S.err))
      + ' <button type="button" class="fxa-link" data-act="retry">Try again</button></div>' : '';
    var cards = shown.length ? shown.map(cardHtml).join('')
      : '<div class="fxa-empty">' + (groups.length ? 'Nothing matches.' : 'No flex clients yet. Use + New customer to set up the first one.') + '</div>';
    return sum + errNote + (S.issues ? '' : waitingHtml()) + cards;
  }

  function loadErrorHtml(e) {
    var msg = String((e && e.message) || '');
    var text = (e && e.code === 'PGRST202') || /could not find the function/i.test(msg)
      ? 'The database part of this tab is not installed yet (migration _42).'
      : (e && e.code === '42501') ? 'Your login cannot view client accounts. This tab is for the flex desk.'
      : 'Could not load client accounts: ' + dbMessage(e);
    return '<div class="fxa-note-bad" role="alert">' + esc(text)
      + ' <button type="button" class="fxa-link" data-act="retry">Try again</button></div>';
  }

  function waitingHtml() {
    if (!S.cat) return S.catErr ? '<div class="fxa-note-bad">Could not load the basket list: ' + esc(S.catErr) + '</div>' : '';
    var gs = waitingGroups(S.cat);
    if (S.q) {
      gs = gs.filter(function (g) {
        var hay = (g.name + ' ' + g.baskets.map(function (b) { return b.name; }).join(' ')).toLowerCase();
        return S.q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }
    if (!gs.length) return '';
    var n = gs.reduce(function (a, g) { return a + g.baskets.length; }, 0);
    var head = '<button type="button" class="fxa-wait-t" data-act="wait-toggle" aria-expanded="' + (S.waitOpen ? 'true' : 'false') + '" aria-controls="fxaWaitList">'
      + '<span class="fxa-caret" aria-hidden="true">' + (S.waitOpen ? '\u25be' : '\u25b8') + '</span>'
      + '<span><b>' + plural(n, 'basket') + '</b> not shared with any client yet</span>'
      + '<span class="fxa-muted">' + plural(gs.length, 'likely client') + '</span></button>';
    var items = gs.map(function (g) {
      return '<li class="fxa-wait-i"><div class="fxa-wait-txt"><b>' + esc(g.name) + '</b>'
        + '<span class="fxa-wait-b">' + g.baskets.map(function (b) { return comTag(b.commodity) + ' ' + esc(b.name); }).join('<br>') + '</span></div>'
        + '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="setup" data-key="' + esc(g.key) + '"'
        + ' aria-label="Set up login for ' + esc(g.name) + '">Set up login</button></li>';
    }).join('');
    return '<section class="fxa-wait" aria-label="Baskets not shared with any client">' + head
      + '<ul class="fxa-wait-l" id="fxaWaitList"' + (S.waitOpen ? '' : ' hidden') + '>' + items + '</ul></section>';
  }

  function cardHtml(g) {
    var sc = g.portal_scope || [];
    var portals = ['flex', 'billing', 'carbon'].filter(function (p) { return sc.indexOf(p) >= 0; })
      .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); });
    var canBaskets = sc.indexOf('flex') >= 0;
    var bk = (g.baskets || []).map(function (b) {
      return '<li class="fxa-bk' + (b.archived ? ' fxa-bk-arch' : '') + '">' + comTag(b.commodity) + ' <span>' + esc(b.name) + '</span>'
        + (b.archived ? ' <span class="fxa-muted">(archived, so the client does not see it)</span>' : '')
        + (b.is_ces ? ' <span class="fxa-warn-t">(one of CES\'s own baskets)</span>' : '') + '</li>';
    }).join('');
    var rows = g.logins.map(function (l) { return loginRow(l, g); }).join('');
    return '<article class="fxa-card" data-customer="' + esc(g.customer_id) + '">'
      + '<div class="fxa-card-h">'
      +   '<h3 class="fxa-card-name">' + esc(g.company_name) + '</h3>'
      +   '<code class="fxa-cid" title="Customer ID">' + esc(g.customer_id) + '</code>'
      +   '<span class="fxa-portals">Portal' + (portals.length === 1 ? '' : 's') + ': ' + (portals.length ? esc(portals.join(', ')) : 'none') + '</span>'
      + '</div>'
      + '<div class="fxa-card-bk">'
      +   '<div class="fxa-card-bkh"><span class="fxa-label">Baskets they see</span>'
      +   (canBaskets ? '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="baskets" data-cid="' + esc(g.customer_id) + '">Edit baskets</button>' : '')
      +   '</div>'
      +   (bk ? '<ul class="fxa-bklist">' + bk + '</ul>' : '<p class="fxa-bad-t fxa-small">None shared, so they would see an empty portal.</p>')
      + '</div>'
      + '<div class="fxa-tablewrap"><table class="extra-table fxa-table">'
      +   '<caption class="fxa-sr">Logins for ' + esc(g.company_name) + '</caption>'
      +   '<colgroup><col class="c-user"><col class="c-name"><col class="c-mail"><col class="c-last"><col class="c-made"><col class="c-st"><col class="c-act"></colgroup>'
      +   '<thead><tr><th scope="col">Username</th><th scope="col">Contact</th><th scope="col">Contact email</th>'
      +   '<th scope="col">Last sign-in</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>'
      +   '<tbody>' + rows + '</tbody></table></div>'
      + '</article>';
  }

  function loginRow(l, g) {
    var st = l._st;
    var badge = '<span class="fxa-st fxa-st-' + st.key + '">' + esc(st.label) + '</span>'
      + (st.bad ? '<div class="fxa-st-tip">' + esc(st.tip) + '</div>' : '');
    if (!l.user_id) {
      return '<tr><td colspan="5" class="fxa-muted">No login for this customer</td><td>' + badge + '</td><td></td></tr>';
    }
    var made = esc(dateOnly(l.created_at)) + (l.created_by ? '<span class="fxa-by">by ' + esc(l.created_by) + '</span>' : '');
    var acts = !l.manage_problem
      ? '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="reset" data-uid="' + esc(l.user_id) + '">Reset password</button>'
        + '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="details" data-uid="' + esc(l.user_id) + '">Edit details</button>'
      : '<span class="fxa-muted fxa-small" title="' + esc(l.manage_problem) + '">Not managed here<span class="fxa-sr">. '
        + esc(l.manage_problem) + '</span></span>';
    return '<tr data-user-id="' + esc(l.user_id) + '">'
      + '<td><code class="fxa-code">' + esc(l.username || '') + '</code></td>'
      + '<td>' + (l.display_name ? esc(l.display_name) : '<span class="fxa-muted">not set</span>') + '</td>'
      + '<td class="fxa-break">' + (l.contact_email ? esc(l.contact_email) : '<span class="fxa-muted">not set</span>') + '</td>'
      + '<td>' + when(l.last_sign_in_at) + '</td>'
      + '<td>' + made + '</td>'
      + '<td>' + badge + '</td>'
      + '<td><div class="fxa-acts">' + acts + '</div></td></tr>';
  }

  /* ---------------------------------------------------------------------------------------
     DIALOG: one at a time, focus kept inside, Esc / backdrop / Cancel all ask before
     throwing away anything typed, and nothing closes while a request is in flight.
     --------------------------------------------------------------------------------------- */
  var DLG = null;
  function openDialog(o) {
    if (DLG) closeDialog(true);
    var ov = document.createElement('div');
    ov.className = 'fxa-ov';
    ov.innerHTML = '<div class="fxa-dlg' + (o.wide ? ' fxa-wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="fxaDlgT" tabindex="-1">'
      + '<div class="fxa-dlg-h"><h2 id="fxaDlgT">' + esc(o.title) + '</h2>'
      + '<button type="button" class="fxa-x" data-act="close" aria-label="Close">' + CROSS + '</button></div>'
      + '<div class="fxa-dlg-b"></div><div class="fxa-dlg-f"></div></div>';
    document.body.appendChild(ov);
    var dlg = ov.firstChild;
    DLG = { ov: ov, dlg: dlg, body: dlg.querySelector('.fxa-dlg-b'), foot: dlg.querySelector('.fxa-dlg-f'),
            o: o, back: document.activeElement, down: false, busy: false };
    // A press on the backdrop must not take focus out of the dialog, or Esc and Tab stop
    // working: they are listened for on the document (capture), and focus is kept inside.
    ov.addEventListener('mousedown', function (e) {
      if (!DLG) return;
      DLG.down = (e.target === ov);
      if (e.target === ov) e.preventDefault();
    });
    ov.addEventListener('click', function (e) { if (DLG && e.target === ov && DLG.down) requestClose(); });
    document.addEventListener('keydown', dlgKey, true);
    dlg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act="close"]') : null;
      if (b && dlg.contains(b)) { e.preventDefault(); requestClose(); }
    });
    return DLG;
  }
  function setTitle(t) { var h = DLG && DLG.dlg.querySelector('#fxaDlgT'); if (h) h.textContent = t; }
  function setBusy(on) {
    if (!DLG) return;
    DLG.busy = !!on;
    DLG.dlg.setAttribute('aria-busy', on ? 'true' : 'false');
    Array.prototype.forEach.call(DLG.dlg.querySelectorAll('input, button, select, textarea'), function (el) {
      if (on) { if (!el.disabled) { el.disabled = true; el.setAttribute('data-fxa-busy', '1'); } }
      else if (el.getAttribute('data-fxa-busy')) { el.disabled = false; el.removeAttribute('data-fxa-busy'); }
    });
  }
  function requestClose() {
    if (!DLG || DLG.busy) return;
    if (DLG.o.isDirty && DLG.o.isDirty() && !window.confirm('Close without saving? What you have entered here will be lost.')) return;
    closeDialog();
  }
  function closeDialog(silent) {
    if (!DLG) return;
    var d = DLG;
    DLG = null;
    document.removeEventListener('keydown', dlgKey, true);
    if (d.ov.parentNode) d.ov.parentNode.removeChild(d.ov);
    try { if (d.back && d.back.focus && document.body.contains(d.back)) d.back.focus(); } catch (e) {}
    if (!silent && S.stale) refresh();
  }
  function dlgKey(e) {
    if (!DLG) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); requestClose(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(DLG.dlg);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (e.shiftKey && (a === first || a === DLG.dlg || !DLG.dlg.contains(a))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (a === last || !DLG.dlg.contains(a))) { e.preventDefault(); first.focus(); }
  }
  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && !el.hidden && el.offsetParent !== null; });
  }
  function focusIn(sel) {
    if (!DLG) return;
    var el = DLG.dlg.querySelector(sel);
    if (el) { try { el.focus(); if (el.select && el.type !== 'checkbox') el.select(); } catch (e) {} }
  }

  async function copyText(text, btn) {
    var done = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); done = true; } } catch (e) { done = false; }
    if (!done) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      (DLG ? DLG.dlg : document.body).appendChild(ta);
      ta.select();
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      ta.parentNode.removeChild(ta);
      if (btn) try { btn.focus(); } catch (e) {}
    }
    if (btn) {
      var was = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', was);
      btn.textContent = done ? 'Copied ' + TICK : 'Copy failed';
      clearTimeout(btn._fxaT);
      btn._fxaT = setTimeout(function () { btn.textContent = was; }, 1600);
    }
    announce(done ? 'Copied' : 'Copy failed. Select the text and copy it by hand.');
    return done;
  }

  // The block staff paste into an email. Website and username always; the password only
  // when there is one to give, which is straight after creating or resetting it.
  function signInText(o) {
    var lines = ['Your CES Flex portal login', '', 'Website: ' + PORTAL_URL, 'Username: ' + o.username];
    if (o.password) lines.push('Password: ' + o.password);
    if (o.baskets && o.baskets.length) { lines.push(''); lines.push('You will see: ' + o.baskets.join(', ')); }
    return lines.join('\n');
  }

  function credsHtml(o) {
    var row = function (k, v, copyVal, label) {
      return '<div class="fxa-cred"><span class="fxa-cred-k">' + k + '</span><code class="fxa-cred-v">' + esc(v) + '</code>'
        + '<button type="button" class="fx-btn fxa-btn fxa-sm" data-copy="' + esc(copyVal) + '" aria-label="Copy ' + label + '">Copy</button></div>';
    };
    return '<div class="fxa-creds">'
      + row('Website', PORTAL_SHOWN, PORTAL_URL, 'the website address')
      + row('Username', o.username, o.username, 'the username')
      + (o.password ? row('Password', o.password, o.password, 'the password') : '')
      + '</div>';
  }

  function bindCopies(root, payload) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-copy],[data-act="copy-all"]') : null;
      if (!b || !root.contains(b)) return;
      if (b.getAttribute('data-act') === 'copy-all') copyText(signInText(payload), b);
      else copyText(b.getAttribute('data-copy'), b);
    });
  }

  /* ---------------------------------------------------------------------------------------
     BASKET PICKER (New customer and Edit baskets share it)
     --------------------------------------------------------------------------------------- */
  var pickSeq = 0;
  function makePicker(host, o) {
    // o: { sel: Set of basket ids, exclude: customer_id being edited or null,
    //      key(): the client word to suggest for, label(): how to name them, onChange() }
    var uid = ++pickSeq;
    var st = { q: '', com: 'all', arch: false, ces: false };
    o.sel.forEach(function (id) { var b = catById(id); if (b && b.archived) st.arch = true; if (b && b.is_ces) st.ces = true; });

    host.innerHTML = '<div class="fxa-pick">'
      + '<div class="fxa-pick-tools">'
      +   '<input type="search" class="fxa-input fxa-pick-q" placeholder="Find a basket" aria-label="Find a basket" autocomplete="off" spellcheck="false">'
      +   '<div class="fxa-seg" role="group" aria-label="Commodity">'
      +     '<button type="button" data-com="all" aria-pressed="true">All</button>'
      +     '<button type="button" data-com="power" aria-pressed="false">Power</button>'
      +     '<button type="button" data-com="gas" aria-pressed="false">Gas</button>'
      +   '</div>'
      + '</div>'
      + '<div class="fxa-suggest" hidden></div>'
      + '<div class="fxa-pick-list" role="group" aria-label="Baskets"></div>'
      + '<div class="fxa-pick-opts">'
      +   '<label class="fxa-check"><input type="checkbox" data-opt="arch"' + (st.arch ? ' checked' : '') + '> Show archived baskets</label>'
      +   '<label class="fxa-check"><input type="checkbox" data-opt="ces"' + (st.ces ? ' checked' : '') + '> Show CES\'s own baskets</label>'
      + '</div>'
      + '<div class="fxa-pick-sel" aria-live="polite"></div>'
      + '</div>';
    var listEl = host.querySelector('.fxa-pick-list'), sugEl = host.querySelector('.fxa-suggest'),
        selEl = host.querySelector('.fxa-pick-sel'), qEl = host.querySelector('.fxa-pick-q');

    function others(b) { return (b.shared_with || []).filter(function (x) { return x.customer_id !== o.exclude; }); }
    function isCurrent(b) { return !!o.exclude && (b.shared_with || []).some(function (x) { return x.customer_id === o.exclude; }); }
    function groupOf(b, key) {
      if (b.archived) return 'arch';
      if (b.is_ces) return 'ces';
      if (isCurrent(b)) return 'cur';
      if (key && keyOf(stemOf(b.name)) === key) return 'sug';
      return others(b).length ? 'oth' : 'free';
    }
    function suggested() {
      var key = o.key();
      if (!key || key.length < 2) return [];
      return (S.cat || []).filter(function (b) { return groupOf(b, key) === 'sug'; });
    }
    function rowHtml(b) {
      var on = o.sel.has(b.id), oth = others(b), meta = [];
      if (b.months) meta.push(plural(b.months, 'month'));
      if (b.first_month && b.last_month) meta.push(monthLabel(b.first_month) + ' to ' + monthLabel(b.last_month));
      if (b.sites) meta.push(plural(b.sites, 'site'));
      // The id is a running number, not the basket id: two ids that differ only in a '.' and
      // an '_' would otherwise collide. The input sits inside its label, so no for= is needed.
      var id = 'fxaB' + uid + '_' + (rowSeq++);
      return '<label class="fxa-brow' + (on ? ' on' : '') + '" data-bid="' + esc(b.id) + '">'
        + '<input type="checkbox" id="' + id + '" value="' + esc(b.id) + '"' + (on ? ' checked' : '') + '>'
        + comTag(b.commodity)
        + '<span class="fxa-bname">' + esc(b.name) + '</span>'
        + '<span class="fxa-bmeta">' + esc(meta.join(' ' + DOT + ' ') || 'no months loaded yet')
        + (oth.length ? '<span class="fxa-bwarn">Also shared with ' + esc(oth.map(function (x) { return x.company_name; }).join(', ')) + '</span>' : '')
        + '</span></label>';
    }
    var rowSeq = 0;
    function paintList() {
      rowSeq = 0;
      if (!S.cat) {
        listEl.innerHTML = S.catErr
          ? '<div class="fxa-pick-empty fxa-bad-t">Could not load baskets: ' + esc(S.catErr) + ' <button type="button" class="fxa-link" data-pact="reload">Try again</button></div>'
          : '<div class="fxa-pick-empty">Loading baskets' + ELL + '</div>';
        return;
      }
      var key = o.key(), q = st.q.toLowerCase(), groups = { cur: [], sug: [], free: [], oth: [], ces: [], arch: [] };
      S.cat.forEach(function (b) {
        if (st.com !== 'all' && b.commodity !== st.com) return;
        if (q) {
          var hay = (b.name + ' ' + b.id + ' ' + (b.shared_with || []).map(function (x) { return x.company_name; }).join(' ')).toLowerCase();
          if (q.split(/\s+/).some(function (w) { return w && hay.indexOf(w) < 0; })) return;
        }
        var gk = groupOf(b, key);
        if (gk === 'arch' && !st.arch) return;
        if (gk === 'ces' && !st.ces) return;
        groups[gk].push(b);
      });
      var titles = {
        cur: 'Shared with ' + o.label() + ' now',
        sug: 'Named like ' + (o.label() || 'this client'),
        free: 'Not shared with any client',
        oth: 'Shared with another client',
        ces: 'CES\'s own baskets',
        arch: 'Archived'
      };
      var html = '';
      ['cur', 'sug', 'free', 'oth', 'ces', 'arch'].forEach(function (k) {
        if (!groups[k].length) return;
        html += '<div class="fxa-pick-g"><div class="fxa-pick-gh">' + esc(titles[k]) + ' <span>(' + groups[k].length + ')</span></div>'
          + (k === 'ces' ? '<p class="fxa-pick-warn">These are CES\'s own trading books. Share one with a client only if they are genuinely part of it.</p>' : '')
          + (k === 'oth' ? '<p class="fxa-pick-info">Ticking one of these lets this client see it as well.</p>' : '')
          + groups[k].map(rowHtml).join('') + '</div>';
      });
      listEl.innerHTML = html || '<div class="fxa-pick-empty">No baskets match' + (st.q ? ' "' + esc(st.q) + '"' : '') + '.</div>';
    }
    function paintSuggest() {
      var sug = suggested();
      if (!sug.length || o.exclude) { sugEl.hidden = true; sugEl.innerHTML = ''; return; }
      var notOn = sug.filter(function (b) { return !o.sel.has(b.id); });
      sugEl.hidden = false;
      sugEl.innerHTML = notOn.length
        ? '<span>' + plural(sug.length, 'basket') + ' named like <b>' + esc(o.label()) + '</b>.</span> '
          + '<button type="button" class="fx-btn fxa-btn fxa-sm" data-pact="tick-sug">Tick ' + (notOn.length === sug.length ? 'all ' : 'the other ') + notOn.length + '</button>'
        : '<span>' + TICK + ' All ' + plural(sug.length, 'basket') + ' named like <b>' + esc(o.label()) + '</b> are ticked.</span>';
    }
    function paintSel() {
      var ids = Array.from(o.sel);
      if (!ids.length) { selEl.innerHTML = '<span class="fxa-muted">No baskets ticked.</span>'; return; }
      var items = ids.map(function (id) { return catById(id) || { id: id, name: id, commodity: 'power' }; }).sort(byName);
      selEl.innerHTML = '<div class="fxa-sel-h"><b>' + plural(ids.length, 'basket') + ' ticked</b>'
        + '<button type="button" class="fxa-link" data-pact="clear">Untick all</button></div>'
        + '<ul class="fxa-chips">' + items.map(function (b) {
          return '<li class="fxa-chip">' + comTag(b.commodity) + ' <span>' + esc(b.name) + (b.archived ? ' (archived)' : '') + '</span>'
            + '<button type="button" data-pact="rm" data-id="' + esc(b.id) + '" aria-label="Untick ' + esc(b.name) + '">' + CROSS + '</button></li>';
        }).join('') + '</ul>';
    }
    function changed() { paintSuggest(); paintSel(); if (o.onChange) o.onChange(); }

    host.addEventListener('change', function (e) {
      var t = e.target;
      if (t.matches('.fxa-brow input[type="checkbox"]')) {
        if (t.checked) o.sel.add(t.value); else o.sel.delete(t.value);
        var lab = t.closest('.fxa-brow'); if (lab) lab.classList.toggle('on', t.checked);
        changed();
      } else if (t.getAttribute('data-opt')) {
        st[t.getAttribute('data-opt')] = t.checked; paintList();
      }
    });
    var qt = 0;
    qEl.addEventListener('input', function () { clearTimeout(qt); qt = setTimeout(function () { st.q = qEl.value.trim(); paintList(); }, 80); });
    host.addEventListener('click', function (e) {
      var seg = e.target.closest ? e.target.closest('[data-com]') : null;
      if (seg && host.contains(seg)) {
        st.com = seg.getAttribute('data-com');
        Array.prototype.forEach.call(host.querySelectorAll('[data-com]'), function (b) { b.setAttribute('aria-pressed', b === seg ? 'true' : 'false'); });
        paintList();
        return;
      }
      var p = e.target.closest ? e.target.closest('[data-pact]') : null;
      if (!p || !host.contains(p)) return;
      var a = p.getAttribute('data-pact');
      if (a === 'tick-sug') { suggested().forEach(function (b) { o.sel.add(b.id); }); paintList(); changed(); focusIn('.fxa-pick-q'); }
      else if (a === 'clear') { o.sel.clear(); paintList(); changed(); focusIn('.fxa-pick-q'); }
      else if (a === 'rm') { o.sel.delete(p.getAttribute('data-id')); paintList(); changed(); focusIn('.fxa-pick-q'); }
      else if (a === 'reload') { refresh().then(function () { paintList(); changed(); }); }
    });

    paintList(); paintSuggest(); paintSel();
    return { repaint: function () { paintList(); paintSuggest(); paintSel(); } };
  }

  function anyCes(sel, except) {
    return Array.from(sel).some(function (id) { var b = catById(id); return b && b.is_ces && !(except && except.indexOf(id) >= 0); });
  }

  /* ---------------------------------------------------------------------------------------
     + NEW CUSTOMER
     --------------------------------------------------------------------------------------- */
  function fieldHtml(id, label, required, input, hintId, hint) {
    return '<div class="fxa-field"><label for="' + id + '">' + label
      + (required ? '<span class="fxa-req" aria-hidden="true"> *</span>' : '') + '</label>'
      + input + '<div class="fxa-hint" id="' + hintId + '">' + (hint || '') + '</div></div>';
  }
  // Hide/Show masks the text with -webkit-text-security rather than switching to
  // type="password" (see the header). Where a browser cannot mask, the button is not drawn
  // rather than drawn and doing nothing.
  var CAN_MASK = (function () { try { return !!(window.CSS && window.CSS.supports && window.CSS.supports('-webkit-text-security', 'disc')); } catch (e) { return false; } })();
  function pwHtml(id, value) {
    return '<div class="fxa-field"><label for="' + id + '">Password<span class="fxa-req" aria-hidden="true"> *</span></label>'
      + '<div class="fxa-pwrow">'
      +   '<input id="' + id + '" class="fxa-input fxa-mono" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"'
      +     ' aria-required="true" aria-describedby="' + id + 'H" value="' + esc(value) + '">'
      +   (CAN_MASK ? '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="pw-show" aria-label="Hide password">Hide</button>' : '')
      +   '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="pw-new">New</button>'
      +   '<button type="button" class="fx-btn fxa-btn fxa-sm" data-act="pw-copy" aria-label="Copy password">Copy</button>'
      + '</div><div class="fxa-hint" id="' + id + 'H"></div></div>';
  }
  function setHint(id, kind, html) {
    var el = DLG && DLG.dlg.querySelector('#' + id);
    if (!el) return;
    el.className = 'fxa-hint' + (kind ? ' ' + kind : '');
    el.innerHTML = html;
  }
  function markInput(id, bad) {
    var el = DLG && DLG.dlg.querySelector('#' + id);
    if (!el) return;
    el.classList.toggle('bad', !!bad);
    el.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }

  function openWizard(pre) {
    var W = {
      company: pre.company || '', cid: '', un: '', cidTouched: false, unTouched: false,
      pw: genPassword(), pwShown: true, name: '', email: '',
      sel: new Set(pre.baskets || []), avail: null, availErr: '', seq: 0, timer: 0,
      touched: {}, tried: false, confirmEmpty: false, err: '', dirty: false, done: null, picker: null
    };
    if (W.company) { W.cid = idFromCompany(W.company); W.un = W.cid; }

    openDialog({ title: 'New flex customer', wide: true,
      isDirty: function () { return W.dirty && !W.done; } });
    paintWizardForm(W);
    if (!S.cat && !S.catErr) refresh().then(function () { if (W.picker && !W.done) { W.picker.repaint(); wizState(W); } });
  }

  function paintWizardForm(W) {
    if (!DLG) return;
    setTitle('New flex customer');
    DLG.body.innerHTML = '<div class="fxa-cols">'
      + '<div class="fxa-col">'
      +   '<fieldset class="fxa-fs"><legend>Customer</legend>'
      +     fieldHtml('fxaCo', 'Company name', true,
              '<input id="fxaCo" class="fxa-input" type="text" autocomplete="off" spellcheck="false" maxlength="120" aria-required="true" aria-describedby="fxaCoH" value="' + esc(W.company) + '">',
              'fxaCoH', 'The legal name. The client sees it at the top of their portal.')
      +     fieldHtml('fxaCid', 'Customer ID', true,
              '<input id="fxaCid" class="fxa-input fxa-mono" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" aria-required="true" aria-describedby="fxaCidH" value="' + esc(W.cid) + '">',
              'fxaCidH', '')
      +   '</fieldset>'
      +   '<fieldset class="fxa-fs"><legend>Their login</legend>'
      +     fieldHtml('fxaUn', 'Username', true,
              '<input id="fxaUn" class="fxa-input fxa-mono" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" aria-required="true" aria-describedby="fxaUnH" value="' + esc(W.un) + '">',
              'fxaUnH', '')
      +     pwHtml('fxaPw', W.pw)
      +   '</fieldset>'
      +   '<fieldset class="fxa-fs"><legend>Main contact <span class="fxa-opt">(optional)</span></legend>'
      +     fieldHtml('fxaNm', 'Contact name', false,
              '<input id="fxaNm" class="fxa-input" type="text" autocomplete="off" maxlength="120" aria-describedby="fxaNmH" value="' + esc(W.name) + '">',
              'fxaNmH', 'The person you deal with at the client.')
      +     fieldHtml('fxaEm', 'Contact email', false,
              '<input id="fxaEm" class="fxa-input" type="email" autocomplete="off" spellcheck="false" maxlength="254" aria-describedby="fxaEmH" value="' + esc(W.email) + '">',
              'fxaEmH', 'For your records only. It is not used to sign in.')
      +   '</fieldset>'
      + '</div>'
      + '<div class="fxa-col"><fieldset class="fxa-fs fxa-fs-pick"><legend>Baskets they will see</legend><div id="fxaPick"></div></fieldset></div>'
      + '</div>';
    DLG.foot.innerHTML = '<div class="fxa-summary" id="fxaSum" aria-live="polite"></div>'
      + '<div class="fxa-err" id="fxaErr" role="alert" hidden></div>'
      + '<div class="fxa-btns"><button type="button" class="fx-btn fxa-btn" data-act="close">Cancel</button>'
      + '<button type="button" class="fxa-primary" data-act="create" id="fxaGo">Create customer</button></div>';

    W.picker = makePicker(DLG.dlg.querySelector('#fxaPick'), {
      sel: W.sel, exclude: null,
      key: function () { return keyOf(W.company); },
      label: function () { var w = squish(W.company).split(' ')[0] || ''; return w; },
      onChange: function () { W.dirty = true; W.confirmEmpty = false; wizState(W); }
    });

    var dlg = DLG.dlg, pickT = 0;
    dlg.addEventListener('input', function (e) {
      var t = e.target, id = t.id;
      if (id === 'fxaCo') {
        W.company = t.value; W.dirty = true; W.touched.co = true;
        if (!W.cidTouched) { W.cid = idFromCompany(W.company); dlg.querySelector('#fxaCid').value = W.cid; }
        if (!W.unTouched) { W.un = W.cid; dlg.querySelector('#fxaUn').value = W.un; }
        clearTimeout(pickT); pickT = setTimeout(function () { if (W.picker) W.picker.repaint(); }, 160);
        scheduleCheck(W);
      } else if (id === 'fxaCid') {
        W.cid = t.value; W.cidTouched = true; W.dirty = true; W.touched.cid = true;
        if (!W.unTouched) { W.un = W.cid.replace(/-/g, ''); dlg.querySelector('#fxaUn').value = W.un; }
        scheduleCheck(W);
      } else if (id === 'fxaUn') {
        W.un = t.value; W.unTouched = true; W.dirty = true; W.touched.un = true; scheduleCheck(W);
      } else if (id === 'fxaPw') {
        W.pw = t.value; W.dirty = true; W.touched.pw = true;
      } else if (id === 'fxaNm') {
        W.name = t.value; W.dirty = true; W.touched.nm = true;
      } else if (id === 'fxaEm') {
        W.email = t.value; W.dirty = true;
      } else return;
      W.err = '';
      wizState(W);
    });
    dlg.addEventListener('focusout', function (e) {
      if (e.target && e.target.id === 'fxaEm') { W.touched.em = true; wizState(W); }
    });
    dlg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !dlg.contains(b)) return;
      var a = b.getAttribute('data-act');
      if (a === 'pw-show') togglePw(W, b, '#fxaPw');
      else if (a === 'pw-new') { W.pw = genPassword(); W.dirty = true; dlg.querySelector('#fxaPw').value = W.pw; wizState(W); }
      else if (a === 'pw-copy') copyText(W.pw, b);
      else if (a === 'create') wizSubmit(W);
      else if (a === 'use-cid') { W.cid = b.getAttribute('data-v'); W.cidTouched = true; dlg.querySelector('#fxaCid').value = W.cid; scheduleCheck(W); wizState(W); focusIn('#fxaCid'); }
      else if (a === 'use-un') { W.un = b.getAttribute('data-v'); W.unTouched = true; dlg.querySelector('#fxaUn').value = W.un; scheduleCheck(W); wizState(W); focusIn('#fxaUn'); }
    });

    if (W.cid) scheduleCheck(W);
    wizState(W);
    focusIn('#fxaCo');
  }

  function togglePw(W, btn, sel) {
    var inp = DLG && DLG.dlg.querySelector(sel);
    if (!inp) return;
    var hide = !inp.classList.contains('fxa-masked');
    inp.classList.toggle('fxa-masked', hide);
    btn.textContent = hide ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', hide ? 'Show password' : 'Hide password');
  }

  // Is this customer ID / username free? Asked of the database a moment after typing stops,
  // and only for values that are well-formed. The answer is kept with the values it was for,
  // so a slow reply about an old value can never mark the new one.
  function scheduleCheck(W) {
    clearTimeout(W.timer);
    var seq = ++W.seq;
    W.timer = setTimeout(async function () {
      var cid = W.cid.trim().toLowerCase(), un = W.un.trim().toLowerCase();
      if (!checkCustomerId(cid).ok && !checkUsername(un).ok) return;
      var r = await rpc('flex_client_name_check', { p_customer_id: cid, p_username: un });
      if (seq !== W.seq || W.done) return;
      if (r.error) { W.avail = null; W.availErr = dbMessage(r.error); }
      else { W.availErr = ''; W.avail = { cid: cid, un: un, cidTaken: !!(r.data && r.data.customer_id_taken), unTaken: !!(r.data && r.data.username_taken) }; }
      wizState(W);
    }, 350);
  }

  function wizChecks(W) {
    var co = checkCompany(W.company), cid = checkCustomerId(W.cid), un = checkUsername(W.un);
    var pw = checkPassword(W.pw, un.ok ? un.value : ''), nm = checkName(W.name), em = checkEmail(W.email);
    var av = W.avail, cidNow = cid.ok ? cid.value : null, unNow = un.ok ? un.value : null;
    // Each field is "known" on its own: a reply about a good customer ID still counts while
    // the username is half typed.
    var kc = !!(av && cidNow && av.cid === cidNow), ku = !!(av && unNow && av.un === unNow);
    return { co: co, cid: cid, un: un, pw: pw, nm: nm, em: em, knownCid: kc, knownUn: ku,
      cidTaken: kc && av.cidTaken, unTaken: ku && av.unTaken };
  }

  function wizState(W) {
    if (!DLG || W.done) return;
    var c = wizChecks(W), show = function (k) { return W.tried || W.touched[k]; };
    // Company
    if (!c.co.ok && show('co')) { setHint('fxaCoH', 'bad', esc(c.co.error)); markInput('fxaCo', true); }
    else { setHint('fxaCoH', '', 'The legal name. The client sees it at the top of their portal.'); markInput('fxaCo', false); }
    // Customer ID. A format complaint waits until there is something worth complaining about,
    // so typing the first letter of the company does not flash an error underneath it.
    var cidLoud = W.tried || W.cidTouched || W.cid.trim().length >= 2;
    if (!c.cid.ok) {
      if (cidLoud) { setHint('fxaCidH', 'bad', esc(c.cid.error)); markInput('fxaCid', true); }
      else { setHint('fxaCidH', '', 'Filled in from the company name. CES\'s internal reference; it cannot be changed later.'); markInput('fxaCid', false); }
    } else if (c.cidTaken) {
      var alt = c.cid.value + 'flex';
      setHint('fxaCidH', 'bad', CROSS + ' Already in use by another customer. '
        + '<button type="button" class="fxa-link" data-act="use-cid" data-v="' + esc(alt) + '">Use ' + esc(alt) + '</button>');
      markInput('fxaCid', true);
    } else if (c.knownCid) {
      setHint('fxaCidH', 'ok', TICK + ' Available. CES\'s internal reference; it cannot be changed later.'); markInput('fxaCid', false);
    } else {
      setHint('fxaCidH', '', W.availErr ? 'Could not check yet (' + esc(W.availErr) + '). It is checked again when you create.' : 'Checking' + ELL);
      markInput('fxaCid', false);
    }
    // Username
    var unLoud = W.tried || W.unTouched || W.un.trim().length >= 3;
    if (!c.un.ok) {
      if (unLoud) { setHint('fxaUnH', 'bad', esc(c.un.error)); markInput('fxaUn', true); }
      else { setHint('fxaUnH', '', 'They type this to sign in at ' + PORTAL_SHOWN + '.'); markInput('fxaUn', false); }
    } else if (c.unTaken) {
      var altU = c.un.value + 'flex';
      setHint('fxaUnH', 'bad', CROSS + ' Already taken by another login. '
        + '<button type="button" class="fxa-link" data-act="use-un" data-v="' + esc(altU) + '">Use ' + esc(altU) + '</button>');
      markInput('fxaUn', true);
    } else if (c.knownUn) {
      setHint('fxaUnH', 'ok', TICK + ' Available. They type this to sign in at ' + PORTAL_SHOWN + '.'); markInput('fxaUn', false);
    } else {
      setHint('fxaUnH', '', W.availErr ? 'Could not check yet. It is checked again when you create.' : 'Checking' + ELL);
      markInput('fxaUn', false);
    }
    // Password: always live, it is generated and should visibly pass.
    if (!c.pw.ok) { setHint('fxaPwH', 'bad', esc(c.pw.error)); markInput('fxaPw', true); }
    else { setHint('fxaPwH', 'ok', TICK + ' Strong enough: ' + W.pw.length + ' characters, letters and numbers.'); markInput('fxaPw', false); }
    // Contact
    if (!c.nm.ok) { setHint('fxaNmH', 'bad', esc(c.nm.error)); markInput('fxaNm', true); } else { setHint('fxaNmH', '', 'The person you deal with at the client.'); markInput('fxaNm', false); }
    if (!c.em.ok && (show('em') || W.tried)) { setHint('fxaEmH', 'bad', esc(c.em.error)); markInput('fxaEm', true); }
    else { setHint('fxaEmH', '', 'For your records only. It is not used to sign in.'); markInput('fxaEm', false); }

    // Summary of what the button will do, in words, before it does it.
    var n = W.sel.size, coName = c.co.ok ? c.co.value : 'the customer';
    var sum = 'Creates <b>' + esc(coName) + '</b>' + (c.cid.ok ? ' (customer <code class="fxa-code">' + esc(c.cid.value) + '</code>)' : '')
      + ' with the login ' + (c.un.ok ? '<code class="fxa-code">' + esc(c.un.value) + '</code>' : '(no username yet)')
      + (n ? ', sharing <b>' + plural(n, 'basket') + '</b>.' : ', with <b>no baskets</b> yet.');
    var notes = [];
    if (!n) notes.push('<span class="fxa-warn-t">With no baskets they would sign in to an empty portal.</span>');
    var sharedElsewhere = Array.from(W.sel).map(catById).filter(function (b) { return b && b.shared_with && b.shared_with.length; });
    if (sharedElsewhere.length) {
      notes.push(plural(sharedElsewhere.length, 'of these is', 'of these are') + ' also shared with another client: '
        + esc(sharedElsewhere.map(function (b) { return b.name; }).join(', ')) + '.');
    }
    if (anyCes(W.sel)) notes.push('<span class="fxa-warn-t">Includes one of CES\'s own baskets.</span>');
    var sumEl = DLG.dlg.querySelector('#fxaSum');
    if (sumEl) sumEl.innerHTML = sum + (notes.length ? '<div class="fxa-sum-notes">' + notes.join('<br>') + '</div>' : '');

    var errEl = DLG.dlg.querySelector('#fxaErr');
    if (errEl) { errEl.hidden = !W.err; errEl.innerHTML = W.err ? esc(W.err) : ''; }

    var go = DLG.dlg.querySelector('#fxaGo');
    if (go && !DLG.busy) {
      var blocked = c.cidTaken || c.unTaken;
      go.disabled = !!blocked;
      go.textContent = (!n && W.confirmEmpty) ? 'Create with no baskets' : 'Create customer';
    }
  }

  function wizValid(W) {
    var c = wizChecks(W);
    var order = [['co', 'fxaCo'], ['cid', 'fxaCid'], ['un', 'fxaUn'], ['pw', 'fxaPw'], ['nm', 'fxaNm'], ['em', 'fxaEm']];
    for (var i = 0; i < order.length; i++) if (!c[order[i][0]].ok) return { ok: false, focus: '#' + order[i][1] };
    if (c.cidTaken) return { ok: false, focus: '#fxaCid' };
    if (c.unTaken) return { ok: false, focus: '#fxaUn' };
    return { ok: true };
  }

  async function wizSubmit(W) {
    if (!DLG || DLG.busy || W.done) return;
    W.tried = true;
    var v = wizValid(W);
    if (!v.ok) { W.err = 'Fix the highlighted field first.'; wizState(W); focusIn(v.focus); return; }
    if (!W.sel.size && !W.confirmEmpty) {
      W.confirmEmpty = true; W.err = '';
      wizState(W);
      announce('No baskets are ticked. Press Create with no baskets to go ahead anyway.');
      return;
    }
    var c = wizChecks(W);
    W.err = '';
    wizState(W);
    var go = DLG.dlg.querySelector('#fxaGo');
    if (go) go.textContent = 'Creating' + ELL;
    setBusy(true);
    var res = await callFn({
      action: 'create_customer',
      company_name: c.co.value, customer_id: c.cid.value, username: c.un.value, password: W.pw,
      display_name: c.nm.value, contact_email: c.em.value,
      basket_ids: Array.from(W.sel), allow_internal: anyCes(W.sel)
    });
    if (!DLG) return;
    setBusy(false);
    if (!res.ok) {
      W.err = res.network
        ? 'We could not reach the server, so we cannot tell whether ' + c.co.value + ' was created. Close this, press Refresh, and check the list before trying again.'
        : res.error;
      if (res.code === 'taken' && res.field === 'customer_id') W.avail = { cid: c.cid.value, un: c.un.value, cidTaken: true, unTaken: false };
      if (res.code === 'taken' && res.field === 'username') W.avail = { cid: c.cid.value, un: c.un.value, cidTaken: false, unTaken: true };
      wizState(W);
      var map = { company_name: '#fxaCo', customer_id: '#fxaCid', username: '#fxaUn', password: '#fxaPw', display_name: '#fxaNm', contact_email: '#fxaEm' };
      if (res.field && map[res.field]) focusIn(map[res.field]);
      return;
    }
    W.done = {
      company: res.company_name || c.co.value, customer_id: res.customer_id || c.cid.value,
      username: res.username || c.un.value, password: W.pw,
      baskets: (res.baskets || []).map(function (b) { return b.name; })
    };
    toast('Created ' + W.done.company);
    paintWizardDone(W);
    refresh();
  }

  function paintWizardDone(W) {
    if (!DLG) return;
    var d = W.done;
    setTitle(d.company + ' is set up');
    DLG.body.innerHTML = '<div class="fxa-done">'
      + '<p class="fxa-done-lead"><span class="fxa-done-tick" aria-hidden="true">' + TICK + '</span>'
      + '<span><b>' + esc(d.company) + '</b> can sign in now'
      + (d.baskets.length ? ' and will see ' + plural(d.baskets.length, 'basket') + ': ' + esc(d.baskets.join(', ')) + '.' : ', but has no baskets yet.') + '</span></p>'
      + credsHtml(d)
      + '<div class="fxa-done-acts"><button type="button" class="fxa-primary" data-act="copy-all">Copy sign-in details</button></div>'
      + '<ul class="fxa-done-notes">'
      +   '<li><b>This is the only time this password is shown.</b> If it is lost, use Reset password on their card.</li>'
      +   '<li>Sending it by email? Consider sending the password separately, by phone or text.</li>'
      +   '<li>Testing the login yourself? Use a private (incognito) window. Signing in here as the client signs you out of the desk.</li>'
      + '</ul></div>';
    DLG.foot.innerHTML = '<div class="fxa-btns"><button type="button" class="fx-btn fxa-btn" data-act="again">Set up another</button>'
      + '<button type="button" class="fxa-primary" data-act="close">Done</button></div>';
    bindCopies(DLG.body, d);
    DLG.foot.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act="again"]') : null;
      if (b) { closeDialog(true); openWizard({}); }
    });
    focusIn('[data-act="copy-all"]');
    announce(d.company + ' created. The password is shown once.');
  }

  /* ---------------------------------------------------------------------------------------
     EDIT BASKETS
     --------------------------------------------------------------------------------------- */
  async function openBaskets(cid) {
    // Start from the freshest list, so "what you started from" really is what is there now.
    if (!S.at || Date.now() - S.at > 15000 || !S.cat) await refresh();
    var g = groupsOf(S.rows).filter(function (x) { return x.customer_id === cid; })[0];
    if (!g) { toast('That customer is no longer listed. Refresh the page.', false); return; }
    var E = { orig: (g.baskets || []).map(function (b) { return b.id; }).sort(), sel: null, dirty: false, err: '', conflict: false };
    E.sel = new Set(E.orig);
    openDialog({ title: 'Baskets for ' + g.company_name, wide: true, isDirty: function () { return E.dirty; } });
    DLG.body.innerHTML = '<p class="fxa-lead">Tick the baskets <b>' + esc(g.company_name) + '</b> should see. '
      + 'They see the change the next time their portal loads.</p><div id="fxaPick"></div>';
    DLG.foot.innerHTML = '<div class="fxa-summary" id="fxaSum" aria-live="polite"></div>'
      + '<div class="fxa-err" id="fxaErr" role="alert" hidden></div>'
      + '<div class="fxa-btns"><button type="button" class="fx-btn fxa-btn" data-act="close">Cancel</button>'
      + '<button type="button" class="fxa-primary" data-act="save-baskets" id="fxaGo">Save changes</button></div>';
    var picker = makePicker(DLG.dlg.querySelector('#fxaPick'), {
      sel: E.sel, exclude: cid,
      key: function () { return keyOf(g.company_name); },
      label: function () { return g.company_name; },
      onChange: function () { E.dirty = diff().changed; E.err = ''; E.conflict = false; state(); }
    });
    function diff() {
      var now = Array.from(E.sel).sort();
      var add = now.filter(function (x) { return E.orig.indexOf(x) < 0; });
      var rem = E.orig.filter(function (x) { return now.indexOf(x) < 0; });
      return { now: now, add: add, rem: rem, changed: add.length + rem.length > 0 };
    }
    function names(ids) { return ids.map(function (id) { var b = catById(id); return b ? b.name : id; }).join(', '); }
    function state() {
      if (!DLG) return;
      var d = diff(), lines = [];
      if (!d.changed) lines.push('No changes yet.');
      if (d.add.length) lines.push('<span class="fxa-add">+ Will share ' + plural(d.add.length, 'basket') + ':</span> ' + esc(names(d.add)));
      if (d.rem.length) lines.push('<span class="fxa-rem">' + MINUS + ' Will stop sharing ' + plural(d.rem.length, 'basket') + ':</span> ' + esc(names(d.rem)));
      if (d.changed && !d.now.length) lines.push('<span class="fxa-warn-t">They will have nothing to see.</span>');
      if (anyCes(E.sel, E.orig)) lines.push('<span class="fxa-warn-t">Includes one of CES\'s own baskets.</span>');
      DLG.dlg.querySelector('#fxaSum').innerHTML = lines.join('<br>');
      var er = DLG.dlg.querySelector('#fxaErr');
      er.hidden = !E.err;
      er.innerHTML = E.err ? esc(E.err) + (E.conflict ? ' <button type="button" class="fxa-link" data-act="reopen">Load the latest and start again</button>' : '') : '';
      var go = DLG.dlg.querySelector('#fxaGo');
      if (go && !DLG.busy) go.disabled = !d.changed;
    }
    DLG.dlg.addEventListener('click', async function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !DLG || !DLG.dlg.contains(b)) return;
      var a = b.getAttribute('data-act');
      if (a === 'reopen') { E.dirty = false; closeDialog(true); S.at = 0; openBaskets(cid); return; }
      if (a !== 'save-baskets') return;
      var d = diff();
      if (!d.changed || DLG.busy) return;
      setBusy(true);
      b.textContent = 'Saving' + ELL;
      var r = await rpc('flex_client_set_baskets', { p_customer_id: cid, p_basket_ids: d.now, p_expected: E.orig,
        p_allow_internal: anyCes(E.sel, E.orig) });
      if (!DLG) return;
      setBusy(false);
      b.textContent = 'Save changes';
      if (r.error) {
        E.conflict = r.error.code === '40001';
        E.err = dbMessage(r.error);
        state();
        return;
      }
      E.dirty = false;
      closeDialog(true);
      toast('Baskets saved for ' + g.company_name);
      refresh();
    });
    picker.repaint();
    state();
    focusIn('.fxa-pick-q');
  }

  /* ---------------------------------------------------------------------------------------
     RESET PASSWORD
     --------------------------------------------------------------------------------------- */
  function openReset(uid) {
    var f = findLogin(uid);
    if (!f) { toast('That login is no longer listed. Refresh the page.', false); return; }
    var l = f.l, g = f.g;
    var R = { pw: genPassword(), err: '' };
    openDialog({ title: 'Reset password', isDirty: function () { return false; } });
    DLG.body.innerHTML = '<p class="fxa-lead">A new password for the login <code class="fxa-code">' + esc(l.username) + '</code>'
      + ' at <b>' + esc(g.company_name) + '</b>.</p>'
      + pwHtml('fxaRp', R.pw)
      + '<p class="fxa-note">Their current password stops working straight away, and anyone still signed in with it is signed out within the hour.</p>';
    DLG.foot.innerHTML = '<div class="fxa-err" id="fxaErr" role="alert" hidden></div>'
      + '<div class="fxa-btns"><button type="button" class="fx-btn fxa-btn" data-act="close">Cancel</button>'
      + '<button type="button" class="fxa-primary" data-act="do-reset" id="fxaGo">Set new password</button></div>';
    var dlg = DLG.dlg;
    function state() {
      if (!DLG) return;
      var c = checkPassword(R.pw, l.username);
      if (!c.ok) { setHint('fxaRpH', 'bad', esc(c.error)); markInput('fxaRp', true); }
      else { setHint('fxaRpH', 'ok', TICK + ' Strong enough: ' + R.pw.length + ' characters, letters and numbers.'); markInput('fxaRp', false); }
      var er = dlg.querySelector('#fxaErr');
      if (er) { er.hidden = !R.err; er.textContent = R.err; }
      var go = dlg.querySelector('#fxaGo');
      if (go && !DLG.busy) go.disabled = !c.ok;
    }
    dlg.addEventListener('input', function (e) { if (e.target.id === 'fxaRp') { R.pw = e.target.value; R.err = ''; state(); } });
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !DLG || !dlg.contains(b)) return;
      var a = b.getAttribute('data-act');
      if (a === 'pw-show') togglePw(R, b, '#fxaRp');
      else if (a === 'pw-new') { R.pw = genPassword(); dlg.querySelector('#fxaRp').value = R.pw; R.err = ''; state(); }
      else if (a === 'pw-copy') copyText(R.pw, b);
      else if (a === 'do-reset') {
        if (DLG.busy || !checkPassword(R.pw, l.username).ok) return;
        setBusy(true);
        b.textContent = 'Setting' + ELL;
        var res = await callFn({ action: 'reset_password', user_id: uid, password: R.pw });
        if (!DLG) return;
        setBusy(false);
        b.textContent = 'Set new password';
        if (!res.ok) {
          R.err = res.network ? 'We could not reach the server, so we cannot tell whether the password changed. Try again: setting it twice is harmless.' : res.error;
          state();
          if (res.field === 'password') focusIn('#fxaRp');
          return;
        }
        var shown = { username: res.username || l.username, password: R.pw,
          baskets: (g.baskets || []).filter(function (x) { return !x.archived; }).map(function (x) { return x.name; }) };
        setTitle('New password set');
        DLG.body.innerHTML = '<div class="fxa-done">'
          + '<p class="fxa-done-lead"><span class="fxa-done-tick" aria-hidden="true">' + TICK + '</span><span>The password for <code class="fxa-code">'
          + esc(shown.username) + '</code> at <b>' + esc(g.company_name) + '</b> has changed.'
          + (res.sessions_ended ? ' ' + plural(res.sessions_ended, 'signed-in session was', 'signed-in sessions were') + ' ended.' : '') + '</span></p>'
          + (res.warning ? '<p class="fxa-note-bad">' + esc(res.warning) + '</p>' : '')
          + credsHtml(shown)
          + '<div class="fxa-done-acts"><button type="button" class="fxa-primary" data-act="copy-all">Copy sign-in details</button></div>'
          + '<ul class="fxa-done-notes"><li><b>This is the only time this password is shown.</b></li>'
          + '<li>Sending it by email? Consider sending the password separately, by phone or text.</li></ul></div>';
        DLG.foot.innerHTML = '<div class="fxa-btns"><button type="button" class="fxa-primary" data-act="close">Done</button></div>';
        bindCopies(DLG.body, shown);
        focusIn('[data-act="copy-all"]');
        toast('Password reset for ' + shown.username);
        announce('Password changed. It is shown once.');
        refresh();
      }
    });
    state();
    focusIn('#fxaRp');
  }

  /* ---------------------------------------------------------------------------------------
     EDIT DETAILS: company name, contact name, contact email
     --------------------------------------------------------------------------------------- */
  function openDetails(uid) {
    var f = findLogin(uid);
    if (!f) { toast('That login is no longer listed. Refresh the page.', false); return; }
    var l = f.l, g = f.g;
    var D = { co: g.company_name || '', nm: l.display_name || '', em: l.contact_email || '', err: '', dirty: false, touched: {} };
    var orig = { co: D.co, nm: D.nm, em: D.em };
    openDialog({ title: 'Edit details', isDirty: function () { return D.dirty; } });
    DLG.body.innerHTML = '<p class="fxa-lead">For the login <code class="fxa-code">' + esc(l.username) + '</code>. '
      + 'The username itself cannot change: it is how they sign in.</p>'
      + (g.flex_only
          ? fieldHtml('fxaDCo', 'Company name', true,
              '<input id="fxaDCo" class="fxa-input" type="text" autocomplete="off" maxlength="120" aria-required="true" aria-describedby="fxaDCoH" value="' + esc(D.co) + '">',
              'fxaDCoH', 'The client sees it at the top of their portal.')
          : '<p class="fxa-note">' + esc(g.company_name) + ' also uses the billing portal, so its company name is changed in the billing admin console.</p>')
      + fieldHtml('fxaDNm', 'Contact name', false,
          '<input id="fxaDNm" class="fxa-input" type="text" autocomplete="off" maxlength="120" aria-describedby="fxaDNmH" value="' + esc(D.nm) + '">', 'fxaDNmH', '')
      + fieldHtml('fxaDEm', 'Contact email', false,
          '<input id="fxaDEm" class="fxa-input" type="email" autocomplete="off" spellcheck="false" maxlength="254" aria-describedby="fxaDEmH" value="' + esc(D.em) + '">',
          'fxaDEmH', 'For your records only. It is not used to sign in.');
    DLG.foot.innerHTML = '<div class="fxa-err" id="fxaErr" role="alert" hidden></div>'
      + '<div class="fxa-btns"><button type="button" class="fx-btn fxa-btn" data-act="close">Cancel</button>'
      + '<button type="button" class="fxa-primary" data-act="save-details" id="fxaGo">Save</button></div>';
    var dlg = DLG.dlg;
    function checks() { return { co: g.flex_only ? checkCompany(D.co) : { ok: true, value: g.company_name }, nm: checkName(D.nm), em: checkEmail(D.em) }; }
    function changed() { return (g.flex_only && squish(D.co) !== squish(orig.co)) || squish(D.nm) !== squish(orig.nm) || String(D.em).trim().toLowerCase() !== String(orig.em).trim().toLowerCase(); }
    function state() {
      if (!DLG) return;
      var c = checks();
      if (g.flex_only) {
        if (!c.co.ok) { setHint('fxaDCoH', 'bad', esc(c.co.error)); markInput('fxaDCo', true); }
        else { setHint('fxaDCoH', '', 'The client sees it at the top of their portal.'); markInput('fxaDCo', false); }
      }
      if (!c.nm.ok) { setHint('fxaDNmH', 'bad', esc(c.nm.error)); markInput('fxaDNm', true); } else { setHint('fxaDNmH', '', ''); markInput('fxaDNm', false); }
      if (!c.em.ok && D.touched.em) { setHint('fxaDEmH', 'bad', esc(c.em.error)); markInput('fxaDEm', true); }
      else { setHint('fxaDEmH', '', 'For your records only. It is not used to sign in.'); markInput('fxaDEm', false); }
      var er = dlg.querySelector('#fxaErr'); if (er) { er.hidden = !D.err; er.textContent = D.err; }
      var go = dlg.querySelector('#fxaGo'); if (go && !DLG.busy) go.disabled = !changed();
    }
    dlg.addEventListener('input', function (e) {
      var id = e.target.id;
      if (id === 'fxaDCo') D.co = e.target.value; else if (id === 'fxaDNm') D.nm = e.target.value;
      else if (id === 'fxaDEm') D.em = e.target.value; else return;
      D.dirty = changed(); D.err = ''; state();
    });
    dlg.addEventListener('focusout', function (e) { if (e.target && e.target.id === 'fxaDEm') { D.touched.em = true; state(); } });
    dlg.addEventListener('click', async function (e) {
      var b = e.target.closest ? e.target.closest('[data-act="save-details"]') : null;
      if (!b || !DLG || DLG.busy) return;
      D.touched.em = true;
      var c = checks();
      if (!c.co.ok || !c.nm.ok || !c.em.ok) { state(); focusIn(!c.co.ok ? '#fxaDCo' : !c.nm.ok ? '#fxaDNm' : '#fxaDEm'); return; }
      setBusy(true);
      b.textContent = 'Saving' + ELL;
      var done = [];
      if (g.flex_only && squish(D.co) !== squish(orig.co)) {
        var r1 = await rpc('flex_client_update_customer', { p_customer_id: g.customer_id, p_company_name: c.co.value });
        if (r1.error) { finish('Company name not saved: ' + dbMessage(r1.error)); return; }
        orig.co = c.co.value; done.push('company name');
      }
      if (squish(D.nm) !== squish(orig.nm) || String(D.em).trim().toLowerCase() !== String(orig.em).trim().toLowerCase()) {
        var r2 = await rpc('flex_client_update_login', { p_user_id: uid, p_display_name: c.nm.value, p_contact_email: c.em.value });
        if (r2.error) { finish((done.length ? 'The company name was saved, but the contact details were not: ' : 'Not saved: ') + dbMessage(r2.error)); return; }
        orig.nm = D.nm; orig.em = D.em; done.push('contact details');
      }
      if (!DLG) return;
      setBusy(false);
      D.dirty = false;
      closeDialog(true);
      toast('Saved ' + done.join(' and ') + ' for ' + (c.co.value || g.company_name));
      refresh();
      function finish(msg) {
        if (!DLG) return;
        setBusy(false); b.textContent = 'Save';
        D.err = msg; D.dirty = changed(); state();
        if (done.length) refresh();
      }
    });
    state();
    focusIn(g.flex_only ? '#fxaDCo' : '#fxaDNm');
  }

  /* ---------------------------------------------------------------------------------------
     STYLE. Scoped to .fxa-*; the desk's own classes (.fx-btn, .extra-table, .overview-title)
     are reused as they are. Every text colour below is at least 4.5:1 on the surface it sits
     on, and every input border and focus ring at least 3:1 (measured; see the test suite).
     --------------------------------------------------------------------------------------- */
  var STYLE_TEXT = [
    '.fxa-root,.fxa-ov{--fxa-ink:#1f2d4d;--fxa-text:#3a3f47;--fxa-muted:#5c6370;--fxa-line:#dde1e8;--fxa-navy:#2f3d7e;--fxa-navy-d:#222d61;',
    '  --fxa-bad:#b42318;--fxa-bad-bg:#fdecea;--fxa-ok:#1d6b35;--fxa-ok-bg:#e6f4ea;--fxa-warn:#8a4600;--fxa-warn-bg:#fff4e0;--fxa-ring:#1d4ed8;--fxa-edge:#7d8494}',
    '.fxa-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    '.fxa-root{color:var(--fxa-text)}',
    '.fxa-root .fxa-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
    '.fxa-root .fxa-h{margin:0 0 4px}',
    '.fxa-root .fxa-top .overview-sub{color:var(--fxa-muted)}',
    '.fxa-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:8px 16px;border:1.5px solid var(--fxa-navy);',
    '  background:var(--fxa-navy);color:#fff;border-radius:8px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;',
    '  transition:background-color .12s ease,border-color .12s ease}',
    '.fxa-primary:hover{background:var(--fxa-navy-d);border-color:var(--fxa-navy-d)}',
    '.fxa-primary:disabled{background:#c5cad6;border-color:#c5cad6;color:#3f4550;cursor:not-allowed}',
    '.fxa-btn{transition:background-color .12s ease,color .12s ease,border-color .12s ease}',
    '.fxa-btn:disabled,.fx-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.fxa-sm{padding:4px 10px;min-height:28px;font-size:12px}',
    '.fxa-link{border:0;background:none;padding:2px 2px;color:var(--fxa-navy);font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
    '.fxa-link:hover{color:var(--fxa-navy-d)}',
    '.fxa-root button:focus-visible,.fxa-root input:focus-visible,.fxa-ov button:focus-visible,.fxa-ov input:focus-visible,.fxa-ov [tabindex]:focus-visible{outline:2px solid var(--fxa-ring);outline-offset:2px;border-radius:4px}',
    '.fxa-input{width:100%;box-sizing:border-box;border:1.5px solid var(--fxa-edge);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;color:var(--fxa-ink);background:#fff}',
    '.fxa-input:focus{border-color:var(--fxa-ring)}',
    '.fxa-input.bad{border-color:var(--fxa-bad)}',
    '.fxa-mono,.fxa-code,.fxa-cid,.fxa-cred-v{font-family:var(--font-mono,"IBM Plex Mono",ui-monospace,monospace)}',
    '.fxa-masked{-webkit-text-security:disc}',
    '.fxa-code{font-size:12px;color:var(--fxa-ink);background:#f1f3f7;border-radius:4px;padding:1px 5px}',
    '.fxa-muted{color:var(--fxa-muted)}',
    '.fxa-small{font-size:11.5px}',
    '.fxa-bad-t{color:var(--fxa-bad)}',
    '.fxa-warn-t{color:var(--fxa-warn);font-weight:700}',
    '.fxa-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--fxa-text);cursor:pointer;min-height:28px}',
    '.fxa-check input{width:16px;height:16px;margin:0;accent-color:var(--fxa-navy)}',
    '.fxa-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
    '.fxa-search{max-width:360px}',
    '.fxa-sum-line{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12.5px;color:var(--fxa-text);margin-bottom:12px}',
    '.fxa-sum-line b{color:var(--fxa-ink);font-family:var(--font-mono,monospace)}',
    '.fxa-empty{padding:14px 2px;color:var(--fxa-muted);font-size:13px}',
    '.fxa-note-bad{background:var(--fxa-bad-bg);color:var(--fxa-bad);border:1px solid #f3c1bb;border-radius:8px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}',
    '.fxa-foot{font-size:11.5px;color:var(--fxa-muted);margin:0}',
    /* the "not shared yet" panel */
    '.fxa-wait{border:1px dashed #a9b1c0;border-radius:12px;background:#fbfcfd;margin-bottom:14px}',
    '.fxa-wait-t{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;text-align:left;border:0;background:none;padding:11px 14px;',
    '  font:inherit;font-size:13px;color:var(--fxa-text);cursor:pointer;border-radius:12px}',
    '.fxa-wait-t b{color:var(--fxa-ink)}',
    '.fxa-caret{display:inline-block;width:12px;color:var(--fxa-muted)}',
    '.fxa-wait-l{list-style:none;margin:0;padding:0 14px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:8px}',
    '.fxa-wait-l[hidden]{display:none}',
    '.fxa-wait-i{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;background:#fff;border:1px solid var(--fxa-line);border-radius:8px;padding:9px 10px}',
    '.fxa-wait-txt{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.fxa-wait-i .fx-btn{flex:none;white-space:nowrap}',
    '.fxa-wait-txt b{color:var(--fxa-ink);font-size:13px}',
    '.fxa-wait-b{font-size:11.5px;color:var(--fxa-text);line-height:1.7}',
    /* customer cards */
    '.fxa-card{border:1px solid var(--fxa-line);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:#fff}',
    '.fxa-card-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-bottom:10px}',
    '.fxa-card-name{margin:0;font-family:var(--font-display,inherit);font-size:15.5px;font-weight:800;color:var(--fxa-ink)}',
    '.fxa-cid{font-size:11.5px;color:var(--fxa-muted)}',
    '.fxa-portals{margin-left:auto;font-size:11.5px;color:var(--fxa-muted)}',
    '.fxa-label{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.45px;color:#4b5263}',
    '.fxa-card-bk{margin-bottom:10px}',
    '.fxa-card-bkh{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
    '.fxa-bklist{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12.5px}',
    '.fxa-bk-arch span:not(.fxa-com):not(.fxa-muted){text-decoration:line-through}',
    '.fxa-com{display:inline-block;min-width:38px;text-align:center;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;vertical-align:1px}',
    '.fxa-com-power{background:#e2eef5;color:#174f66}',
    '.fxa-com-gas{background:#ebf2d8;color:#405010}',
    '.fxa-tablewrap{overflow-x:auto}',
    '.fxa-table{table-layout:fixed;min-width:960px}',
    '.fxa-table col.c-user{width:11%}.fxa-table col.c-name{width:11%}.fxa-table col.c-mail{width:16%}.fxa-table col.c-last{width:9%}',
    '.fxa-table col.c-made{width:10%}.fxa-table col.c-st{width:17%}.fxa-table col.c-act{width:26%}',
    '.fxa-table td{vertical-align:top}',
    '.fxa-break{overflow-wrap:anywhere}',
    '.fxa-by{display:block;font-size:11px;color:var(--fxa-muted)}',
    '.fxa-acts{display:flex;flex-wrap:wrap;gap:6px}',
    '.fxa-st{display:inline-block;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap}',
    '.fxa-st-active{background:var(--fxa-ok-bg);color:var(--fxa-ok)}',
    '.fxa-st-ready{background:#eceffa;color:#283573}',
    '.fxa-st-nologin,.fxa-st-notclient,.fxa-st-disabled,.fxa-st-unconfirmed,.fxa-st-noflex,.fxa-st-nobaskets{background:var(--fxa-bad-bg);color:var(--fxa-bad)}',
    '.fxa-st-tip{font-size:11px;color:var(--fxa-text);margin-top:3px;line-height:1.35}',
    /* dialog */
    '.fxa-ov{position:fixed;inset:0;z-index:99100;background:rgba(13,19,48,.55);display:flex;align-items:center;justify-content:center;padding:20px}',
    '@media (prefers-reduced-motion:no-preference){.fxa-ov{animation:fxaFade .14s ease-out}}',
    '@keyframes fxaFade{from{opacity:0}to{opacity:1}}',
    '.fxa-dlg{background:#fff;border-radius:14px;width:100%;max-width:560px;max-height:calc(100vh - 40px);display:flex;flex-direction:column;',
    '  box-shadow:0 30px 70px rgba(3,8,26,.45);outline:none;color:var(--fxa-text);font-family:var(--font-body,inherit)}',
    '.fxa-dlg.fxa-wide{max-width:1060px}',
    '.fxa-dlg-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--fxa-line)}',
    '.fxa-dlg-h h2{margin:0;font-family:var(--font-display,inherit);font-size:17px;font-weight:800;color:var(--fxa-ink)}',
    '.fxa-x{border:0;background:none;font-size:22px;line-height:1;color:#4b5263;cursor:pointer;min-width:36px;min-height:36px;border-radius:8px}',
    '.fxa-x:hover{background:#eef0f4;color:var(--fxa-ink)}',
    '.fxa-dlg-b{padding:16px 20px;overflow:auto;flex:1}',
    '.fxa-dlg-f{padding:12px 20px 16px;border-top:1px solid var(--fxa-line);display:flex;flex-direction:column;gap:10px}',
    '.fxa-btns{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}',
    '.fxa-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:22px}',
    '.fxa-fs{border:0;margin:0 0 6px;padding:0;min-width:0}',
    '.fxa-fs legend{padding:0;margin-bottom:10px;font-family:var(--font-display,inherit);font-size:13px;font-weight:800;color:var(--fxa-ink)}',
    '.fxa-opt{font-family:var(--font-body,inherit);font-weight:400;color:var(--fxa-muted)}',
    '.fxa-field{margin-bottom:12px}',
    '.fxa-field label{display:block;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.45px;color:#4b5263;margin-bottom:4px}',
    '.fxa-req{color:var(--fxa-bad)}',
    '.fxa-hint{font-size:12px;color:var(--fxa-muted);margin-top:4px;min-height:16px;line-height:1.4}',
    '.fxa-hint.ok{color:var(--fxa-ok)}',
    '.fxa-hint.bad{color:var(--fxa-bad)}',
    '.fxa-pwrow{display:flex;gap:6px;align-items:stretch}',
    '.fxa-pwrow .fxa-input{flex:1;min-width:0;letter-spacing:.5px}',
    '.fxa-summary{font-size:12.5px;color:var(--fxa-text);line-height:1.5}',
    '.fxa-summary b{color:var(--fxa-ink)}',
    '.fxa-sum-notes{margin-top:4px;font-size:12px}',
    '.fxa-err{background:var(--fxa-bad-bg);color:var(--fxa-bad);border:1px solid #f3c1bb;border-radius:8px;padding:8px 11px;font-size:12.5px}',
    '.fxa-err[hidden]{display:none}',
    '.fxa-lead{margin:0 0 12px;font-size:13px;line-height:1.5}',
    '.fxa-note{margin:10px 0 0;font-size:12px;color:var(--fxa-muted);line-height:1.5}',
    '.fxa-add{color:var(--fxa-ok);font-weight:700}',
    '.fxa-rem{color:var(--fxa-bad);font-weight:700}',
    /* picker */
    '.fxa-pick-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}',
    '.fxa-pick-q{flex:1;min-width:160px}',
    '.fxa-seg{display:inline-flex;border:1.5px solid var(--fxa-navy);border-radius:8px;overflow:hidden}',
    '.fxa-seg button{border:0;background:#fff;color:var(--fxa-navy);font-family:inherit;font-size:12px;font-weight:700;padding:6px 11px;min-height:32px;cursor:pointer}',
    '.fxa-seg button+button{border-left:1.5px solid var(--fxa-navy)}',
    '.fxa-seg button[aria-pressed="true"]{background:var(--fxa-navy);color:#fff}',
    '.fxa-suggest{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;background:#f2f6e6;border:1px solid #d6e2b0;border-radius:8px;padding:7px 10px;margin-bottom:8px;color:#36420d}',
    '.fxa-suggest[hidden]{display:none}',
    '.fxa-pick-list{border:1px solid var(--fxa-line);border-radius:8px;max-height:min(44vh,420px);overflow:auto;background:#fff}',
    '.fxa-pick-gh{position:sticky;top:0;z-index:1;background:#f3f5f8;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.45px;color:#4b5263;padding:6px 10px;border-bottom:1px solid var(--fxa-line)}',
    '.fxa-pick-gh span{font-weight:600}',
    '.fxa-pick-warn{margin:0;padding:7px 10px;font-size:12px;background:var(--fxa-warn-bg);color:var(--fxa-warn);border-bottom:1px solid #f0dcb8}',
    '.fxa-pick-info{margin:0;padding:6px 10px;font-size:12px;color:var(--fxa-muted);border-bottom:1px solid #eef0f4}',
    '.fxa-brow{display:grid;grid-template-columns:18px auto minmax(0,1fr);column-gap:8px;row-gap:2px;align-items:center;padding:7px 10px;border-bottom:1px solid #eef0f4;cursor:pointer}',
    '.fxa-brow:hover{background:#f6f7fa}',
    '.fxa-brow.on{background:#eef4dd}',
    '.fxa-brow:focus-within{box-shadow:inset 3px 0 0 var(--fxa-ring)}',
    '.fxa-brow input{width:16px;height:16px;margin:0;accent-color:var(--fxa-navy)}',
    '.fxa-bname{font-size:13px;color:var(--fxa-ink);font-weight:600;overflow-wrap:anywhere}',
    '.fxa-bmeta{grid-column:3;font-size:11.5px;color:var(--fxa-muted)}',
    '.fxa-bwarn{display:block;color:var(--fxa-warn);font-weight:700}',
    '.fxa-pick-empty{padding:12px 10px;font-size:12.5px;color:var(--fxa-muted)}',
    '.fxa-pick-opts{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px}',
    '.fxa-pick-sel{margin-top:10px;font-size:12.5px}',
    '.fxa-sel-h{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
    '.fxa-chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}',
    '.fxa-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid #c3c9d4;border-radius:6px;padding:2px 2px 2px 6px;background:#fff;font-size:12px;color:var(--fxa-ink)}',
    '.fxa-chip button{border:0;background:none;font-size:15px;line-height:1;color:#4b5263;cursor:pointer;min-width:26px;min-height:26px;border-radius:4px}',
    '.fxa-chip button:hover{background:#eef0f4;color:var(--fxa-bad)}',
    /* done */
    '.fxa-done-lead{display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;font-size:13.5px;line-height:1.5}',
    '.fxa-done-tick{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:50%;background:var(--fxa-ok);color:#fff;font-weight:800}',
    '.fxa-creds{border:1px solid var(--fxa-line);border-radius:10px;background:#f8f9fb;padding:6px 14px}',
    '.fxa-cred{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 0}',
    '.fxa-cred+.fxa-cred{border-top:1px solid var(--fxa-line)}',
    '.fxa-cred-k{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.45px;color:#4b5263}',
    '.fxa-cred-v{font-size:15px;color:var(--fxa-ink);overflow-wrap:anywhere;letter-spacing:.3px}',
    '.fxa-done-acts{margin:14px 0 10px}',
    '.fxa-done-notes{margin:0;padding-left:18px;font-size:12.5px;line-height:1.55;color:var(--fxa-text)}',
    '.fxa-done-notes li+li{margin-top:4px}',
    '@media (max-width:880px){.fxa-cols{grid-template-columns:1fr}}',
    '@media (max-width:600px){.fxa-ov{padding:0;align-items:stretch}.fxa-dlg{max-height:none;height:100%;border-radius:0}',
    '  .fxa-cred{grid-template-columns:1fr auto}.fxa-cred-k{grid-column:1/-1}.fxa-pwrow{flex-wrap:wrap}.fxa-pwrow .fxa-input{flex-basis:100%}}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('fxa-css')) return;
    var st = document.createElement('style');
    st.id = 'fxa-css';
    st.textContent = STYLE_TEXT;
    (document.head || document.documentElement).appendChild(st);
  }

  window.FlexAccounts = {
    VERSION: VERSION,
    render: render,
    refresh: refresh,
    // Pure pieces, for tests/flex_accounts_render_test.js. Not used by flex.html.
    _t: { checkCompany: checkCompany, checkCustomerId: checkCustomerId, checkUsername: checkUsername,
          checkPassword: checkPassword, checkEmail: checkEmail, idFromCompany: idFromCompany, stemOf: stemOf,
          keyOf: keyOf, waitingGroups: waitingGroups, genPassword: genPassword, statusOf: statusOf,
          groupsOf: groupsOf, signInText: signInText, PW_SET: PW_SET }
  };
})();
