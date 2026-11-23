/* ==========================================================================================
   admin-logins.js  -  Admin > Customers > Change password (billing admin console, index.html)

   Lists the logins that can sign in for one customer and sets a new password for one of them.
   index.html loads it as <script src="/admin-logins.js?v=VERSION">. The ?v= must equal VERSION
   below (tests/admin_logins_render_test.mjs asserts it). Bump both together on every change: it
   is the site's cache-busting convention, the same as portal-switch.js.

   Server side (all live, 22 Nov 2026):
     admin_customer_logins(customer_id)   RPC, migration _70a. Answers admins only (42501).
     admin-customer-password              edge function. Checks is_admin() AS THE CALLER,
                                          refuses CES staff logins, sets the password, ends the
                                          login's sessions and writes audit_log. It never logs,
                                          stores or returns a password.
   The password rule below is only shown live. The server applies the same rule (the flex
   desk's, word for word) and has the final say.
   ========================================================================================== */
(function (root) {
  'use strict';

  var VERSION = '2026-11-22.1';
  var FN_NAME = 'admin-customer-password';
  var BILLING_URL = 'https://billcesgb.com';
  var FLEX_URL = 'https://billcesgb.com/flex';
  var PASSWORD_MIN = 10;
  var PASSWORD_MAX = 72;
  var TICK = String.fromCharCode(0x2713);
  var ELL = String.fromCharCode(0x2026);
  var TIMES = String.fromCharCode(0xd7);
  var DOT = String.fromCharCode(0xb7);

  /* ---------------------------------------------------------------------------------------
     PASSWORDS: the flex desk's generator. 12 characters in three groups of four, from a set
     with no look-alikes (no 0/O, 1/l/I), always mixing upper, lower and a digit.
     --------------------------------------------------------------------------------------- */
  var PW_SET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  function genPassword() {
    var c = root.crypto, s = '';
    for (var tries = 0; tries < 64; tries++) {
      var a = new Uint32Array(12);
      c.getRandomValues(a);
      s = '';
      for (var i = 0; i < 12; i++) { if (i && i % 4 === 0) s += '-'; s += PW_SET.charAt(a[i] % PW_SET.length); }
      if (/[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return s;
    }
    return s;
  }
  function byteLen(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return String(s).length; } }
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

  /* ---------------------------------------------------------------------------------------
     SMALL HELPERS
     --------------------------------------------------------------------------------------- */
  function esc(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function client() {
    try { if (typeof sb !== 'undefined' && sb && sb.auth) return sb; } catch (e) { /* not declared */ }
    try { if (root.sb && root.sb.auth) return root.sb; } catch (e) { /* no */ }
    return null;
  }
  function whenHtml(ts) {
    if (!ts) return 'never';
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
     SERVER CALLS. supabase-js puts a failed edge function's body in error.context (a
     Response) and error.message is always the same sentence, so callFn() reads the body.
     --------------------------------------------------------------------------------------- */
  function dbMessage(err) {
    var code = err && err.code, msg = (err && err.message) || 'Unknown error.';
    if (code === 'PGRST202' || /could not find the function/i.test(msg)) {
      return 'The database part of Change password is not installed yet (migration _70a).';
    }
    if (code === '42501') return 'Only an admin can see customer logins. Sign in with the admin login.';
    if (/failed to fetch|networkerror|network request/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
    if (/jwt|refresh token|expired/i.test(msg)) return 'Your session has expired. Refresh the page and sign in again.';
    return msg;
  }
  async function loadLogins(customerId) {
    var c = client();
    if (!c) return { error: 'You are not signed in.' };
    try {
      var r = await c.rpc('admin_customer_logins', { p_customer_id: customerId });
      if (r.error) return { error: dbMessage(r.error) };
      return { rows: Array.isArray(r.data) ? r.data : [] };
    } catch (e) { return { error: dbMessage({ message: String((e && e.message) || e) }) }; }
  }
  async function callFn(body) {
    var c = client();
    if (!c) return { ok: false, error: 'You are not signed in.' };
    var r;
    try { r = await c.functions.invoke(FN_NAME, { body: body }); }
    catch (e) { return { ok: false, network: true, error: 'Could not reach the server.' }; }
    if (!r.error) {
      var d = r.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* keep the string */ } }
      if (d && d.ok) return d;
      return { ok: false, error: (d && d.error) || 'The server gave an answer this page did not understand.', field: d && d.field, code: d && d.code };
    }
    var ctx = r.error.context, status = ctx && typeof ctx.status === 'number' ? ctx.status : 0, parsed = null;
    if (ctx && typeof ctx.text === 'function') {
      try { var t = await ctx.text(); try { parsed = JSON.parse(t); } catch (e) { parsed = null; } } catch (e) { parsed = null; }
    }
    if (!status) return { ok: false, network: true, error: 'Could not reach the server.' };
    var msg = parsed && parsed.error ? String(parsed.error)
      : status === 401 ? 'Your session has expired. Refresh the page and sign in again.'
      : status === 403 ? 'Your login is not allowed to do this.'
      : status === 404 ? 'The Change password server function (' + FN_NAME + ') is not deployed.'
      : status >= 500 ? 'The server failed (' + status + '). Nothing was changed.'
      : (r.error.message || 'Something went wrong.');
    return { ok: false, status: status, error: msg, field: parsed && parsed.field, code: parsed && parsed.code };
  }

  /* ---------------------------------------------------------------------------------------
     STYLES: built on index.html's own modal and button classes, plus a few of its own.
     --------------------------------------------------------------------------------------- */
  function ensureStyles() {
    if (document.getElementById('calStyles')) return;
    var st = document.createElement('style');
    st.id = 'calStyles';
    st.textContent = [
      '.cal-dlg .edit-report-modal__card { max-width: 600px; }',
      '.cal-dlg .edit-report-modal__head h3 { margin: 0; }',
      '.cal-sub { font-size: 13px; color: var(--muted); font-weight: 600; margin-top: 3px; }',
      '.cal-lead { font-size: 14px; color: var(--text-2); line-height: 1.5; margin: 0 0 14px; }',
      '.cal-list { display: flex; flex-direction: column; gap: 10px; }',
      '.cal-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }',
      '.cal-row-main { flex: 1; min-width: 0; }',
      '.cal-user { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; font-weight: 700; color: var(--text); word-break: break-all; }',
      '.cal-meta { font-size: 12px; color: var(--muted); margin-top: 3px; }',
      '.cal-why { font-size: 12.5px; color: var(--text-2); margin-top: 5px; }',
      '.cal-dlg .cal-sm { padding: 7px 12px; font-size: 13px; white-space: nowrap; flex: 0 0 auto; }',
      '.cal-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--bg-2); padding: 1px 6px; border-radius: 5px; font-size: 13px; color: var(--text); }',
      '.cal-label { display: block; font-size: 12.5px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px; }',
      '.cal-pwrow { display: flex; gap: 8px; align-items: stretch; }',
      '.cal-input { flex: 1; min-width: 0; width: auto; padding: 11px 14px; border: 1.5px solid var(--border); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 15px; color: var(--text); background: var(--surface); outline: none; }',
      '.cal-input:focus { border-color: var(--navy); box-shadow: 0 0 0 3px rgba(47,61,126,0.1); }',
      '.cal-input.bad { border-color: #c0392b; }',
      '.cal-hint { font-size: 12.5px; margin-top: 7px; min-height: 18px; color: var(--text-2); }',
      '.cal-hint.ok { color: var(--ok); }',
      '.cal-hint.bad { color: #c0392b; }',
      '.cal-note { font-size: 12.5px; color: var(--muted); line-height: 1.5; margin: 14px 0 0; }',
      '.cal-err { background: #fef2f2; border: 1px solid #fecaca; border-radius: 7px; padding: 10px 13px; font-size: 13px; color: #c0392b; margin-top: 14px; font-weight: 500; }',
      '.cal-warn { background: var(--warn-bg); color: var(--warn); border-radius: 7px; padding: 10px 13px; font-size: 13px; margin-top: 12px; }',
      '.cal-empty { font-size: 13.5px; color: var(--text-2); padding: 14px; border: 1px dashed var(--border); border-radius: 10px; line-height: 1.5; }',
      '.cal-btns { display: flex; gap: 10px; margin-top: 20px; }',
      '.cal-btns > button { flex: 1; width: auto; }',
      '.cal-done-lead { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: var(--text); line-height: 1.5; }',
      '.cal-tick { flex: 0 0 auto; width: 24px; height: 24px; border-radius: 50%; background: var(--ok-bg); color: var(--ok); display: flex; align-items: center; justify-content: center; font-weight: 800; }',
      '.cal-creds { margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }',
      '.cal-cred { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--line); }',
      '.cal-cred:first-child { border-top: 0; }',
      '.cal-cred-k { width: 84px; flex: 0 0 auto; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }',
      '.cal-cred-v { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; color: var(--text); word-break: break-all; }',
      '.cal-done-notes { margin: 14px 0 0 18px; padding: 0; font-size: 12.5px; color: var(--text-2); line-height: 1.6; }',
      '.cal-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }',
      '@media (max-width: 600px) { .cal-row { flex-wrap: wrap; } .cal-row .cal-sm { width: 100%; } .cal-pwrow { flex-wrap: wrap; } .cal-pwrow .cal-input { flex-basis: 100%; } .cal-btns { flex-direction: column-reverse; } }'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------------------------------------------------------------------------------------
     THE DIALOG: list of logins -> new password for one -> done (shown once)
     --------------------------------------------------------------------------------------- */
  var D = null;

  function open(customerId, companyName, scope) {
    if (!customerId) return;
    close(true);
    ensureStyles();
    var el = document.createElement('div');
    el.className = 'edit-report-modal cal-dlg';
    el.id = 'calModal';
    el.innerHTML =
        '<div class="edit-report-modal__overlay" data-cal="close"></div>'
      + '<div class="edit-report-modal__card" role="dialog" aria-modal="true" aria-labelledby="calTitle">'
      +   '<div class="edit-report-modal__head">'
      +     '<div><h3 id="calTitle">Change password</h3><div class="cal-sub" id="calSub"></div></div>'
      +     '<button type="button" class="btn-close" data-cal="close" aria-label="Close">' + TIMES + '</button>'
      +   '</div>'
      +   '<div class="edit-report-modal__body" id="calBody"></div>'
      + '</div>'
      + '<div class="cal-sr" id="calLive" aria-live="polite"></div>';
    D = {
      el: el, body: null, customerId: String(customerId), company: companyName || String(customerId),
      scope: Array.isArray(scope) ? scope : [], busy: false, view: 'list', rows: null, target: null,
      pw: '', err: '', done: null, lastFocus: document.activeElement
    };
    D.body = el.querySelector('#calBody');
    el.querySelector('#calSub').textContent = D.company;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    showList();
  }

  function close(force) {
    if (!D) return;
    if (D.busy && !force) return; // a change is in flight: keep the dialog until it answers
    document.removeEventListener('keydown', onKey, true);
    if (D.el.parentNode) D.el.parentNode.removeChild(D.el);
    var f = D.lastFocus;
    D = null;
    try { if (f && f.focus) f.focus(); } catch (e) { /* the button may have been redrawn */ }
  }

  function setTitle(t) { if (D) D.el.querySelector('#calTitle').textContent = t; }
  function announce(msg) {
    var el = D && D.el.querySelector('#calLive');
    if (el) { el.textContent = ''; setTimeout(function () { el.textContent = msg; }, 30); }
  }
  function focusFirst(sel) {
    if (!D) return;
    var el = D.body.querySelector(sel);
    if (el) { try { el.focus(); } catch (e) { /* ignore */ } }
  }

  async function showList() {
    if (!D) return;
    D.view = 'list'; D.target = null; D.err = ''; D.done = null; D.pw = '';
    setTitle('Change password');
    D.body.innerHTML = '<p class="cal-lead">The logins that sign in to this customer\'s portal. Choose one to give it a new password.</p>'
      + '<div class="cal-list" id="calList"><div class="cal-empty">Loading logins' + ELL + '</div></div>'
      + '<div class="cal-btns"><button type="button" class="btn-secondary" data-cal="close">Close</button></div>';
    var mine = D;
    var r = await loadLogins(D.customerId);
    if (D !== mine || D.view !== 'list') return; // closed, or moved on, while it loaded
    var host = D.body.querySelector('#calList');
    if (r.error) { host.innerHTML = '<div class="cal-err" role="alert">' + esc(r.error) + '</div>'; return; }
    D.rows = r.rows;
    if (!r.rows.length) {
      host.innerHTML = '<div class="cal-empty">' + esc(D.company) + ' has no login yet. To add one, use <b>Add a customer</b> at the top of this tab and type '
        + '<span class="cal-code">' + esc(D.customerId) + '</span> as the Customer ID. Left blank, it makes a second customer record instead.</div>';
      return;
    }
    host.innerHTML = r.rows.map(function (l) {
      return '<div class="cal-row" data-login="' + esc(l.user_id) + '"><div class="cal-row-main">'
        + '<div class="cal-user">' + esc(l.username) + '</div>'
        + '<div class="cal-meta">' + (l.last_sign_in_at ? 'Last signed in ' + whenHtml(l.last_sign_in_at) : 'Never signed in')
        + ' ' + DOT + ' created ' + esc(dateOnly(l.created_at)) + '</div>'
        + (l.problem ? '<div class="cal-why">' + esc(l.problem) + '</div>' : '')
        + '</div>'
        + (l.problem ? '' : '<button type="button" class="btn-secondary cal-sm" data-cal="pick" data-uid="' + esc(l.user_id) + '">Change password</button>')
        + '</div>';
    }).join('');
    focusFirst('[data-cal="pick"]');
  }

  function showSet(uid) {
    if (!D) return;
    var l = null;
    (D.rows || []).forEach(function (x) { if (x.user_id === uid) l = x; });
    if (!l || l.problem) return;
    D.view = 'set'; D.target = l; D.pw = genPassword(); D.err = '';
    setTitle('New password');
    D.body.innerHTML = '<p class="cal-lead">A new password for the login <span class="cal-code">' + esc(l.username) + '</span>.</p>'
      + '<label class="cal-label" for="calPw">New password</label>'
      + '<div class="cal-pwrow">'
      +   '<input id="calPw" class="cal-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="calPwH" value="' + esc(D.pw) + '">'
      +   '<button type="button" class="btn-secondary cal-sm" data-cal="pw-new">New</button>'
      +   '<button type="button" class="btn-secondary cal-sm" data-cal="pw-copy" aria-label="Copy the password">Copy</button>'
      + '</div>'
      + '<div class="cal-hint" id="calPwH" aria-live="polite"></div>'
      + '<p class="cal-note">Use the suggested password or type your own. Their current password stops working straight away, and anyone still signed in with it is signed out within the hour.</p>'
      + '<div class="cal-err" id="calErr" role="alert" hidden></div>'
      + '<div class="cal-btns"><button type="button" class="btn-secondary" data-cal="back">Back</button>'
      +   '<button type="button" class="btn-primary" data-cal="save" id="calSave">Set new password</button></div>';
    setState();
    var inp = D.body.querySelector('#calPw');
    if (inp) { inp.focus(); try { inp.select(); } catch (e) { /* ignore */ } }
  }

  function setState() {
    if (!D || D.view !== 'set') return;
    var c = checkPassword(D.pw, D.target.username);
    var h = D.body.querySelector('#calPwH'), inp = D.body.querySelector('#calPw');
    if (h) {
      if (c.ok) { h.className = 'cal-hint ok'; h.textContent = TICK + ' Strong enough: ' + D.pw.length + ' characters, letters and numbers.'; }
      else { h.className = 'cal-hint bad'; h.textContent = c.error; }
    }
    if (inp) { inp.classList.toggle('bad', !c.ok); inp.setAttribute('aria-invalid', c.ok ? 'false' : 'true'); }
    var er = D.body.querySelector('#calErr');
    if (er) { er.hidden = !D.err; er.textContent = D.err || ''; }
    var sv = D.body.querySelector('#calSave');
    if (sv && !D.busy) sv.disabled = !c.ok;
  }

  function setBusy(on) {
    if (!D) return;
    D.busy = !!on;
    Array.prototype.forEach.call(D.el.querySelectorAll('button, input'), function (b) { b.disabled = !!on; });
    if (!on) setState();
  }

  async function save() {
    if (!D || D.view !== 'set' || D.busy) return;
    var l = D.target, pw = D.pw;
    if (!checkPassword(pw, l.username).ok) { setState(); return; }
    var mine = D;
    D.err = '';
    setState();
    setBusy(true);
    var btn = D.body.querySelector('#calSave');
    if (btn) btn.textContent = 'Setting' + ELL;
    var res = await callFn({ action: 'reset_password', user_id: l.user_id, password: pw });
    if (D !== mine) return;
    setBusy(false);
    if (btn) btn.textContent = 'Set new password';
    if (!res.ok) {
      D.err = res.network
        ? 'We could not reach the server, so we cannot tell whether the password changed. Try again: setting it twice is harmless.'
        : res.error;
      setState();
      if (res.field === 'password') focusFirst('#calPw');
      return;
    }
    showDone({ username: res.username || l.username, password: pw, sessions: res.sessions_ended, warning: res.warning });
  }

  function portal() {
    var s = D ? D.scope : [];
    if (s.indexOf('billing') < 0 && s.indexOf('flex') >= 0) return { url: FLEX_URL, name: 'CES Flex portal' };
    return { url: BILLING_URL, name: 'CES Billing Portal' };
  }
  function signInText() {
    var p = portal(), o = D.done;
    return ['Your ' + p.name + ' login', '', 'Website: ' + p.url, 'Username: ' + o.username, 'Password: ' + o.password].join('\n');
  }
  function valueFor(k) {
    if (!D || !D.done) return '';
    if (k === 'website') return portal().url;
    if (k === 'username') return D.done.username;
    if (k === 'password') return D.done.password;
    return '';
  }

  function showDone(o) {
    if (!D) return;
    D.view = 'done'; D.done = o;
    setTitle('Password changed');
    var p = portal();
    var row = function (label, shown, key) {
      return '<div class="cal-cred"><span class="cal-cred-k">' + label + '</span><span class="cal-cred-v">' + esc(shown) + '</span>'
        + '<button type="button" class="btn-secondary cal-sm" data-cal="copy" data-k="' + key + '" aria-label="Copy the ' + label.toLowerCase() + '">Copy</button></div>';
    };
    D.body.innerHTML = '<div class="cal-done-lead"><span class="cal-tick" aria-hidden="true">' + TICK + '</span><span>'
      + 'The password for <span class="cal-code">' + esc(o.username) + '</span> at <b>' + esc(D.company) + '</b> has changed.'
      + (o.sessions ? ' ' + plural(o.sessions, 'signed-in session was', 'signed-in sessions were') + ' ended.' : '')
      + '</span></div>'
      + (o.warning ? '<div class="cal-warn" role="alert">' + esc(o.warning) + '</div>' : '')
      + '<div class="cal-creds">'
      +   row('Website', p.url.replace(/^https:\/\//, ''), 'website')
      +   row('Username', o.username, 'username')
      +   row('Password', o.password, 'password')
      + '</div>'
      + '<ul class="cal-done-notes"><li><b>This is the only time this password is shown.</b> Copy it before you close this.</li>'
      + '<li>Sending it by email? Consider sending the password separately, by phone or text.</li></ul>'
      + '<div class="cal-btns"><button type="button" class="btn-primary" data-cal="copy-all">Copy sign-in details</button></div>'
      + '<div class="cal-btns" style="margin-top:10px;"><button type="button" class="btn-secondary" data-cal="back">Back to logins</button>'
      +   '<button type="button" class="btn-secondary" data-cal="close">Done</button></div>';
    focusFirst('[data-cal="copy-all"]');
    announce('Password changed. It is shown once.');
  }

  async function copyText(text, btn) {
    var done = false;
    try { if (navigator.clipboard && root.isSecureContext) { await navigator.clipboard.writeText(text); done = true; } } catch (e) { done = false; }
    if (!done) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      (D ? D.el : document.body).appendChild(ta);
      ta.select();
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      if (btn) { try { btn.focus(); } catch (e) { /* ignore */ } }
    }
    if (btn) {
      var was = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', was);
      btn.textContent = done ? 'Copied ' + TICK : 'Copy failed';
      clearTimeout(btn._calT);
      btn._calT = setTimeout(function () { btn.textContent = was; }, 1600);
    }
    announce(done ? 'Copied' : 'Copy failed. Select the text and copy it by hand.');
    return done;
  }

  /* ---------------------------------------------------------------------------------------
     EVENTS
     --------------------------------------------------------------------------------------- */
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-cal]') : null;
    if (!b || !D || !D.el.contains(b)) return;
    var a = b.getAttribute('data-cal');
    if (a === 'close') { close(false); return; }
    if (D.busy) return;
    if (a === 'pick') showSet(b.getAttribute('data-uid'));
    else if (a === 'back') showList();
    else if (a === 'pw-new') {
      D.pw = genPassword(); D.err = '';
      var inp = D.body.querySelector('#calPw'); if (inp) inp.value = D.pw;
      setState();
    }
    else if (a === 'pw-copy') copyText(D.pw, b);
    else if (a === 'save') save();
    else if (a === 'copy') copyText(valueFor(b.getAttribute('data-k')), b);
    else if (a === 'copy-all') copyText(signInText(), b);
  }

  function onInput(e) {
    if (!D || D.view !== 'set' || !e.target || e.target.id !== 'calPw') return;
    D.pw = e.target.value; D.err = '';
    setState();
  }

  function onKey(e) {
    if (!D) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if (e.key === 'Enter' && D.view === 'set' && e.target && e.target.id === 'calPw') { e.preventDefault(); save(); return; }
    if (e.key === 'Tab') {
      var card = D.el.querySelector('.edit-report-modal__card');
      var f = Array.prototype.filter.call(card.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])'),
        function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1], at = document.activeElement;
      if (e.shiftKey && (at === first || !card.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !card.contains(at))) { e.preventDefault(); first.focus(); }
    }
  }

  root.CESAdminLogins = {
    VERSION: VERSION,
    open: open,
    close: function () { close(false); },
    _test: { checkPassword: checkPassword, genPassword: genPassword, isOpen: function () { return !!D; } }
  };
})(window);
