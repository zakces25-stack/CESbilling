/*
 * pricing-team.js - the personal pages of the pricing portal (6/7 Nov 2026).
 *
 * CES: "a personalised login for everyone ... different people should have different pages".
 *
 *   TeamDesk.mount(host, opts) -> { go(view, arg), viewAs(person), VERSION }
 *     'mine'        a broker's landing page: their contracts ending with nothing lined up, a tick
 *                   for what happened (renewal in place, lost customer...), and the requests they
 *                   sent to the pricing team with who has each one and for how long
 *     'mybook'      every customer in their book (7 Nov 2026, 07b), renewed or not, with the next
 *                   contract end and the LOA; a customer given to them on the desk shows here too
 *     'requests'    the pricing team's requests, found in pricingteam@ by request-mail: take one,
 *                   assign it, set its status; taking one colours the email in Outlook
 *     'myrequests'  the requests one person has taken
 *     'staff'       the staff directory (admins): roles, UtilityClick name, Outlook category and
 *                   colour, logins, and "See their page"
 *   An admin can look at anyone's 'mine' and 'mybook' exactly as that person sees them (07b), read
 *   only: the buttons show but do nothing, and the badge counts stay the admin's own.
 *   TeamDesk.chat(opts) the Ask Claude drawer (desk-assistant): read-only answers about anything
 *                   on the desk, run with the asker's own permissions
 *
 *   opts: { sb, esc, me (staff_whoami()), openCompany(id), priceMeter(crmMeterRow), logo(name),
 *           onView(v), onCounts(c), ask(question, context) }
 *
 * Every write goes through a database function that checks who is asking (renewal_set_outcome,
 * request_assign, request_set_status, request_note, staff_upsert, staff_link_login).
 * ASCII only. Special characters are HTML entities, never literal.
 */
(function (root) {
  'use strict';

  var VERSION = '2026-11-09.1';

  var OUTCOMES = [
    ['renewal_in_place', 'Renewal in place', 'p-ok'],
    ['lost', 'Lost customer', 'p-fail'],
    ['moved_out', 'Moved out (change of tenancy)', 'p-mute'],
    ['site_closed', 'Site closed', 'p-mute'],
    ['out_of_contract', 'Staying out of contract', 'p-warn'],
    ['working', 'Working on it', 'p-warn'],
    ['other', 'Other', 'p-mute'],
  ];
  var OUTCOME = {};
  OUTCOMES.forEach(function (o) { OUTCOME[o[0]] = o; });
  var WINDOWS = [['overdue', 'Ended, nothing after'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days'],
                 ['180', '6 months'], ['365', '12 months'], ['ticked', 'Ticked']];
  // A customer's meters ending the same day on the same fuel, this many or more, are one row (07b).
  var GROUP_MIN = 3;
  var RSTATUS = { 'new': ['New', 'p-warn'], assigned: ['Taken', 'p-ok'], in_progress: ['In progress', 'p-ok'],
                  waiting: ['Waiting', 'p-mute'], done: ['Done', 'p-ok'], not_request: ['Filed', 'p-mute'] };
  var KINDS = { price: 'Price', renewal: 'Renewal', contract: 'Contract', cot: 'Change of tenancy', meter: 'Meter',
                billing: 'Billing', query: 'Question', chase: 'Chase', uc_update: 'CRM update', other: 'Other' };
  // Outlook's category colours, as named in Outlook, with a close web colour for the portal.
  var PRESETS = [['preset0', 'Red', '#b91c1c'], ['preset1', 'Orange', '#c2410c'], ['preset2', 'Brown', '#7c4a1e'],
                 ['preset3', 'Yellow', '#a16207'], ['preset4', 'Green', '#15803d'], ['preset5', 'Teal', '#0f766e'],
                 ['preset6', 'Olive', '#4d5b1f'], ['preset7', 'Blue', '#1d4ed8'], ['preset8', 'Purple', '#7e22ce'],
                 ['preset9', 'Cranberry', '#9f1239'], ['preset10', 'Steel', '#475569'], ['preset11', 'Dark steel', '#334155'],
                 ['preset12', 'Gray', '#57534e'], ['preset13', 'Dark gray', '#3f3f46'], ['preset14', 'Black', '#18181b'],
                 ['preset15', 'Dark red', '#7f1d1d'], ['preset16', 'Dark orange', '#9a3412'], ['preset17', 'Dark brown', '#5c3a1a'],
                 ['preset18', 'Dark yellow', '#854d0e'], ['preset19', 'Dark green', '#14532d'], ['preset20', 'Dark teal', '#134e4a'],
                 ['preset21', 'Dark olive', '#3f4a18'], ['preset22', 'Dark blue', '#1e3a8a'], ['preset23', 'Dark purple', '#581c87'],
                 ['preset24', 'Dark cranberry', '#881337']];

  var STYLES = [
    '.tm-cols{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;min-height:0;flex:1 1 auto}',
    '.tm-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
    '.tm-col .grid{flex:1 1 auto;min-height:0}',
    '.tm-col h3{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2);margin:0 0 6px;display:flex;align-items:center;gap:8px}',
    '@media (max-width:1199px){.tm-cols{grid-template-columns:minmax(0,1fr)}.tm-col .grid{min-height:240px}}',
    '.tm-req{border:1px solid var(--line);border-radius:10px;background:#fff;padding:9px 11px;margin:0 0 8px}',
    '.tm-req .s{font-size:12.5px;font-weight:700;color:var(--text);line-height:1.35}',
    '.tm-req .m{font-size:11.5px;color:var(--text-2);margin-top:3px;line-height:1.45}',
    '.tm-age{font-weight:800}.tm-age.late{color:var(--fail)}.tm-age.ok{color:var(--ok)}',
    '.tm-dot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:-1px;margin-right:5px;border:1px solid rgba(0,0,0,.15)}',
    '.tm-out{display:flex;flex-direction:column;gap:3px;align-items:flex-start}',
    '.tm-form{background:var(--panel-2);border:1px solid var(--line-2);border-radius:10px;padding:10px 12px;margin:4px 0}',
    '.tm-form .opts{display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0 8px}',
    '.tm-form label{display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:600;color:var(--text);margin:0}',
    '.tm-form label input{width:auto;height:auto;margin:0}',
    '.tm-form .row2{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 8px}',
    '.tm-form .row2 input{height:30px;font-size:12.5px;padding:3px 9px;width:auto;min-width:0}',
    '.tm-form .act{margin:0}',
    '.tm-form [hidden]{display:none!important}',
    '.tm-kind{display:inline-block;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);background:var(--panel-2);border:1px solid var(--line-2);border-radius:6px;padding:1px 6px;margin-right:6px}',
    '.tm-sum{font-size:12.5px;color:var(--text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.tm-who{white-space:nowrap;font-size:12.5px}',
    '.tm-hi{color:var(--fail);font-weight:800}',
    '.tm-bad{color:var(--fail);font-weight:700}',
    '.tm-hint{font-size:11.5px;color:var(--ok);background:var(--ok-bg);border:1px solid #b9dcc2;border-radius:8px;padding:5px 8px;margin-top:5px;line-height:1.45;max-width:270px}',
    '.tm-hint .act{margin:4px 0 0;display:inline-flex}',
    // A change of tenancy: amber, not green (it is not a renewal). #7a4b00 on #fff6e5 measures 6.9:1.
    '.tm-hint.cot{color:#7a4b00;background:#fff6e5;border-color:#f3d7a6}',
    // A deal's row and its meters (07b).
    '.tm-grp td{border-top:2px solid var(--line-2)}',
    '.tm-grp td:first-child{box-shadow:inset 3px 0 0 var(--cyan)}',
    '.tm-mem[hidden]{display:none!important}',
    '.tm-mem td:first-child{box-shadow:inset 3px 0 0 var(--line-2)}',
    '.tm-mem td:nth-child(2){padding-left:18px}',
    '.tm-evd:empty{display:none}',
    '.tm-ev{font-size:12px;color:var(--text-2);line-height:1.5;border-left:2px solid var(--line-2);padding-left:9px;margin:6px 0 0}',
    '.tm-ev b{color:var(--text)}',
    '.tm-prev{font-size:12px;color:var(--text-2);background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;white-space:pre-wrap;max-height:180px;overflow:auto;margin:8px 0}',
    '.tm-staff td{vertical-align:top}',
    '.tm-staff input[type=text],.tm-staff input[type=email]{height:30px;font-size:12.5px;padding:3px 8px;width:100%;min-width:120px}',
    '.tm-staff select{height:30px;font-size:12.5px;padding:2px 6px}',
    '.tm-roles{display:flex;flex-wrap:wrap;gap:4px 10px}',
    '.tm-roles label{display:flex;gap:4px;align-items:center;font-size:12px;font-weight:600;text-transform:none;letter-spacing:0;margin:0}',
    '.tm-roles input{width:auto;height:auto;margin:0}',
    // the Ask drawer
    '.ask-drawer{position:fixed;top:60px;right:0;bottom:0;width:min(420px,100vw);background:#fff;border-left:1px solid var(--line-2);box-shadow:-14px 0 34px rgba(19,32,57,.16);z-index:60;display:flex;flex-direction:column;transform:translateX(102%);transition:transform .18s ease}',
    '.ask-drawer.open{transform:none}',
    // A closing drawer takes no clicks and leaves the tab order (the side menu lesson of 6 Nov 2026).
    '.ask-drawer:not(.open){pointer-events:none;visibility:hidden;transition:transform .18s ease,visibility 0s linear .18s}',
    '.ask-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}',
    '.ask-head b{font-size:14px}.ask-head .x{margin-left:auto;background:none;border:0;font-size:22px;line-height:1;cursor:pointer;color:var(--text-2)}',
    '.ask-log{flex:1 1 auto;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
    '.ask-msg{max-width:92%;font-size:13px;line-height:1.5;white-space:pre-wrap;border-radius:12px;padding:8px 11px}',
    '.ask-msg.u{align-self:flex-end;background:var(--cyan);color:#fff}',
    '.ask-msg.a{align-self:flex-start;background:var(--panel-2);border:1px solid var(--line);color:var(--text)}',
    '.ask-msg.e{align-self:flex-start;background:#fdecec;border:1px solid #f3c2c2;color:#7f1d1d}',
    '.ask-meta{font-size:11px;color:var(--muted);margin-top:4px}',
    '.ask-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 8px}',
    '.ask-chips button{background:var(--panel-2);border:1px solid var(--line-2);border-radius:999px;font:inherit;font-size:12px;font-weight:600;color:var(--text-2);padding:5px 10px;cursor:pointer;text-align:left}',
    '.ask-chips button:hover{border-color:var(--cyan-dim);color:var(--cyan)}',
    '.ask-form{display:flex;gap:8px;padding:10px 14px 14px;border-top:1px solid var(--line)}',
    '.ask-form textarea{flex:1 1 auto;min-height:44px;max-height:140px;resize:vertical;font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line-2);border-radius:10px}',
    '.ask-form .act{align-self:flex-end;margin:0}',
  ].join('\n');
  function injectStyles(doc) {
    if (doc.getElementById('teamStyles')) return;
    var s = doc.createElement('style'); s.id = 'teamStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }

  // ---------------------------------------------------------------- helpers
  function uk(iso) { if (!iso) return ''; var s = String(iso).slice(0, 10).split('-'); return s.length === 3 ? s[2] + '/' + s[1] + '/' + s[0] : String(iso); }
  function ukTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return uk(iso);
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  // A cubic metre: the contracts export writes it 'm' + U+00B3, the meters export 'm3' (7 Nov 2026:
  // 925 water contracts read as kWh because only 'm3' was tested).
  var CUBED = String.fromCharCode(179);
  function isM3(u) { u = String(u || '').trim().toLowerCase(); return u === 'm3' || u === 'm' + CUBED; }
  function n0(v) { return v == null || v === '' ? '' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
  function gbp(v) { return v == null || v === '' || !isFinite(Number(v)) ? '' : '&pound;' + Math.round(Number(v)).toLocaleString('en-GB'); }
  function hoursSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : null; }
  function ageWords(iso) {
    var h = hoursSince(iso);
    if (h == null) return '';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return Math.round(h) + ' h';
    return Math.round(h / 24) + ' days';
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  /** CES's commission a year, as the CRM module works it out (rate x AQ, else UC's total over its years). */
  function commYear(k) {
    var rate = Number(k.commission_rate), aq = Number(k.aq), fixed = Number(k.commission_gbp_meter_year) || 0;
    if (rate > 0 && aq > 0 && /p\/kwh/i.test(k.commission_uom || '') && !isM3(k.aq_unit)) return rate * aq / 100 + fixed;
    var tot = Number(k.total_commission_gbp), m = Number(k.duration_months);
    if (tot > 0 && m > 0) return tot / (m / 12);
    return fixed || null;
  }
  var FUEL_ICON = {
    electricity: '<svg class="fi fi-e" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
    gas: '<svg class="fi fi-g" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 2 1 3 2 3 0-3 0-5 1-8z"/></svg>',
    water: '<svg class="fi fi-w" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7l5.7 5.7a8 8 0 1 1-11.3 0z"/></svg>',
  };
  function fuelIcon(f) { return FUEL_ICON[f] ? '<span title="' + f + '">' + FUEL_ICON[f] + '</span>' : ''; }

  // ================================================================ the pages
  function mount(host, opts) {
    var sb = opts.sb, esc = opts.esc, doc = host.ownerDocument;
    injectStyles(doc);
    host.innerHTML = '<div id="teamBody"></div>';
    var body = host.querySelector('#teamBody');
    var S = { view: null, mine: { win: '90' }, book: { q: '' }, req: { tab: 'new', q: '', sel: null }, mreq: { tab: 'open', sel: null },
              staff: null, people: null, as: null };
    var me = function () { return opts.me || {}; };
    var myStaff = function () { return me().staff || null; };
    /** Whose book is on screen: an admin looking at someone's page, else the person signed in. */
    var whoFor = function () { return (me().admin && S.as) || myStaff(); };
    var preview = function () { return !!(me().admin && S.as); };
    function q(builder, what) {
      return Promise.resolve(builder).then(function (r) {
        if (r.error) throw new Error(what + ': ' + r.error.message);
        return r;
      });
    }
    function fail(e) { body.insertAdjacentHTML('afterbegin', '<div class="note bad" style="margin-bottom:10px">' + esc(e.message || String(e)) + '</div>'); }
    function logo(name) { return opts.logo ? opts.logo(name) : ''; }
    function supName(name) { return '<span class="sup" title="' + esc(name || '') + '">' + logo(name) + '<span>' + esc(name || '') + '</span></span>'; }
    function pill(cls, text) { return '<span class="pill ' + cls + '">' + text + '</span>'; }
    function people() {
      if (S.people) return Promise.resolve(S.people);
      return q(sb.from('staff_members').select('id,display_name,colour,roles,active,uc_name'), 'staff').then(function (r) {
        S.people = {};
        (r.data || []).forEach(function (p) { S.people[p.id] = p; });
        return S.people;
      });
    }
    function personHtml(id, P) {
      var p = P && P[id];
      if (!p) return '<span class="crm-small">nobody yet</span>';
      return '<span class="tm-who"><span class="tm-dot" style="background:' + esc(p.colour || '#94a3b8') + '"></span>' + esc(p.display_name) + '</span>';
    }

    function go(view, arg) {
      S.view = view;
      if (!me().admin) S.as = null;
      if (opts.onView) { try { opts.onView(view); } catch (_) { /* the page's business */ } }
      body.innerHTML = '<div class="note">Loading&hellip;</div>';
      var f = { mine: renderMine, mybook: renderMyBook, requests: renderRequests, myrequests: renderMyRequests, staff: renderStaff }[view];
      if (!f) { body.innerHTML = '<div class="note bad">No such page.</div>'; return Promise.resolve(); }
      return Promise.resolve().then(function () { return f(arg); }).catch(function (e) { body.innerHTML = ''; fail(e); });
    }

    // ---------------------------------------------------------------- My renewals (brokers)
    function mineQuery(win, head) {
      var b = sb.from('renewal_watch_v').select(head ? 'id' : '*', head ? { count: 'exact', head: true } : {})
        .eq('account_manager', (whoFor() || {}).uc_name || '__nobody__');
      if (win === 'ticked') return b.not('outcome', 'is', null);
      b = b.is('outcome', null);
      if (win === 'overdue') return b.eq('lifecycle', 'ended');
      return b.eq('lifecycle', 'live').lte('days_to_end', Number(win));
    }
    // In a preview the buttons are drawn, so the page looks as it does to them, but take no clicks.
    function dis() { return preview() ? ' disabled title="Preview: only they can tick their own page"' : ''; }
    function outcomeHtml(k, i) {
      if (!k.outcome) {
        return '<div class="tm-out"><span class="nowrap"><button class="act sm" data-mark' + dis() + '>Mark</button> ' +
          '<button class="act ghost sm" data-check' + (preview() ? dis() : ' title="Ask Claude whether a renewal is already in place"') + '>Check</button></span>' +
          '<div class="tm-evd" data-ev="' + i + '"></div></div>';
      }
      var o = OUTCOME[k.outcome] || [k.outcome, k.outcome, 'p-mute'];
      return '<div class="tm-out">' + pill(o[2], esc(o[1])) +
        (k.outcome === 'renewal_in_place' && (k.renewal_supplier || k.renewal_start)
          ? '<span class="crm-small">' + esc(k.renewal_supplier || '') + (k.renewal_start ? ' from ' + uk(k.renewal_start) : '') + '</span>' : '') +
        '<span class="crm-small">' + esc(k.outcome_by || '') + ', ' + uk(k.outcome_at) + '</span>' +
        '<button class="act ghost sm" data-mark' + dis() + '>Change</button></div>';
    }
    /**
     * An admin's "whose page" picker and the preview banner (7 Nov 2026, CES: "I would like to see
     * how the brokers account looks"). Everyone else gets nothing.
     */
    function asBar(P) {
      if (!me().admin) return '';
      var own = myStaff();
      var list = Object.keys(P || {}).map(function (k) { return P[k]; })
        .filter(function (p) { return p.active !== false && p.uc_name && (!own || p.id !== own.id); })
        .sort(function (a, b) { return String(a.display_name).localeCompare(String(b.display_name)); });
      var cur = S.as ? S.as.id : '';
      var sel = '<label class="crm-small nowrap" style="display:inline-flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;margin:0">See the page of ' +
        '<select data-as aria-label="See someone else\'s page" style="height:28px;font-size:12px;padding:2px 6px;width:auto">' +
        '<option value="">' + (own && own.uc_name ? 'me (' + esc(own.name || '') + ')' : 'pick a person') + '</option>' +
        list.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === cur ? ' selected' : '') + '>' + esc(p.display_name) + '</option>'; }).join('') +
        '</select></label>';
      if (!S.as) return '<div style="margin:0 0 8px">' + sel + '</div>';
      return '<div class="note warn" style="margin:0 0 8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<span>You are looking at <b>' + esc(S.as.name) + '</b>\'s page, exactly as they see it. Read only: the buttons do nothing here.</span>' +
        sel + '<button class="act ghost sm" data-asoff>Back to mine</button></div>';
    }
    function wireAs() {
      var sel = body.querySelector('[data-as]');
      if (sel) sel.addEventListener('change', function () {
        var p = S.people && S.people[sel.value];
        S.as = p ? { id: p.id, name: p.display_name, uc_name: p.uc_name } : null;
        go(S.view === 'mybook' ? 'mybook' : 'mine');
      });
      var off = body.querySelector('[data-asoff]');
      if (off) off.addEventListener('click', function () { S.as = null; go(S.view === 'mybook' ? 'mybook' : 'mine'); });
    }
    function notLinked(title) {
      var own = !preview();
      body.innerHTML = '<div class="card">' + (me().admin ? '<div id="asHost"></div>' : '') + '<h2>' + title + '</h2><div class="note warn">' +
        (own ? 'This login is not linked to a person with a book of customers, so there are none to show. ' +
               'Ask an admin to add you on Settings &rsaquo; People, with the name your customers are filed under.'
             : 'That person has no CRM name on Settings &rsaquo; People.') + '</div></div>';
      if (!me().admin) return Promise.resolve();
      return people().then(function (P) { var h = body.querySelector('#asHost'); if (h) { h.innerHTML = asBar(P); wireAs(); } });
    }
    /**
     * Signs about a contract on the list, for the rows on screen (7 Nov 2026, CES: "detect when
     * there's a renewal in place"). Read, never acted on; the broker decides and presses Save.
     *   - a quote marked Won on the meter: "looks renewed", the tick offered pre-filled
     *   - a later contract on the same meter under ANOTHER customer: "looks like a change of
     *     tenancy", the "moved out" tick offered pre-filled (8 of the 1,577 open rows on 7 Nov)
     *   - a request to pricing naming the meter: work in hand
     * 07b took out 07a's "a new signed contract uploaded" sign: measured on the live data it fired on
     * 54 of the 1,577 open rows and was wrong on nearly all of them (the 5 Nov contract import put
     * older contracts and other customers' contracts naming the meter on file; only 5 were later
     * contracts, 4 of those a change of tenancy). Each read is its own; one failing leaves the others.
     */
    var LATER_GROUPS = ['supply', 'other_broker', 'pipeline'];
    function evidenceFor(rows) {
      var mpans = [], start0 = {};
      rows.forEach(function (k) {
        if (!k.mpan) return;
        if (mpans.indexOf(k.mpan) < 0) mpans.push(k.mpan);
        if (k.meter_start && (!start0[k.mpan] || k.meter_start < start0[k.mpan])) start0[k.mpan] = k.meter_start;
      });
      var ev = {}, add = function (m, e) { (ev[m] = ev[m] || []).push(e); };
      if (!mpans.length) return Promise.resolve(ev);
      var since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      var soft = function (b) { return Promise.resolve(b).then(function (r) { return (r && !r.error && r.data) || []; }).catch(function () { return []; }); };
      var chunks = [];
      for (var i = 0; i < mpans.length; i += 100) chunks.push(mpans.slice(i, i + 100));
      return Promise.all(chunks.map(function (ms) {
        var from = ms.map(function (m) { return start0[m] || '1900-01-01'; }).sort()[0];
        return Promise.all([
          soft(sb.from('pricing_quotes').select('mpan,status_at,best_supplier,created_at').in('mpan', ms).eq('status', 'won').gte('created_at', since)),
          soft(sb.from('pricing_requests').select('mpans,received_at,kind,status').overlaps('mpans', ms).gte('received_at', since)),
          // Contracts on these meters starting after the earliest one listed, still running or to come.
          soft(sb.from('crm_contracts_v').select('uc_tender_id,uc_customer_id,customer_name,mpan,supplier,meter_start,status_group')
            .in('mpan', ms).gt('meter_start', from).in('status_group', LATER_GROUPS)
            .or('meter_end.gte.' + today() + ',meter_end.is.null').limit(1000)),
        ]).then(function (r) {
          r[0].forEach(function (x) { add(x.mpan, { kind: 'won', at: x.status_at || x.created_at, supplier: x.best_supplier || '' }); });
          r[1].forEach(function (x) {
            if (x.status === 'not_request') return;
            (x.mpans || []).forEach(function (m) { if (ms.indexOf(m) >= 0) add(m, { kind: 'req', at: x.received_at }); });
          });
          r[2].forEach(function (c) {
            add(c.mpan, { kind: 'later', tender: c.uc_tender_id, cust: c.uc_customer_id, name: c.customer_name || '', start: c.meter_start, supplier: c.supplier || '' });
          });
        });
      })).then(function () { return ev; });
    }
    /** The change of tenancy for row k, if the evidence has one: the first later contract under someone else. */
    function cotOf(k, list) {
      return list.filter(function (e) {
        return e.kind === 'later' && e.cust && e.cust !== k.uc_customer_id && String(e.start || '') > String(k.meter_start || '');
      }).sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); })[0] || null;
    }
    function evidenceHtml(k, list) {
      var won = list.filter(function (e) { return e.kind === 'won'; })[0];
      var cot = cotOf(k, list);
      var req = list.filter(function (e) { return e.kind === 'req'; })[0];
      var out = '';
      if (won) {
        out += '<div class="tm-hint"><b>Looks renewed:</b> quote won ' + uk(won.at) + (won.supplier ? ' (' + esc(won.supplier) + ')' : '') +
          ' <button class="act sm" data-yes' + dis() + '>Renewal in place</button></div>';
      }
      if (cot) {
        out += '<div class="tm-hint cot"><b>Looks like a change of tenancy:</b> ' + esc(cot.name || 'another customer') + ' has this meter' +
          (cot.supplier ? ' with ' + esc(cot.supplier) : '') + ' from ' + uk(cot.start) +
          ' <button class="act sm" data-cot' + dis() + '>Moved out</button></div>';
      }
      if (req) out += '<div class="crm-small">Asked pricing about it ' + uk(req.at) + '</div>';
      return out;
    }
    function endsHtml(k) {
      var n = Number(k.days_to_end);
      if (k.lifecycle === 'ended') return '<span class="due-0">ended ' + uk(k.meter_end) + '</span><div class="crm-small">' + n0(-n) + ' days ago</div>';
      return '<span class="' + (n <= 30 ? 'due-0' : n <= 60 ? 'due-1' : '') + '">' + uk(k.meter_end) + '</span><div class="crm-small">' + (n === 0 ? 'today' : 'in ' + n0(n) + ' days') + '</div>';
    }
    function renderMine(arg) {
      var st = whoFor();
      if (arg && arg.win) S.mine.win = String(arg.win);
      var win = S.mine.win;
      if (!st || !st.uc_name) return notLinked('My renewals');
      return Promise.all([
        Promise.all(WINDOWS.map(function (w) { return q(mineQuery(w[0], true), 'count').then(function (r) { return [w[0], r.count || 0]; }); })),
        q(mineQuery(win, false).order('days_to_end', { ascending: win !== 'overdue' }).order('customer_name').limit(300), 'my renewals'),
        q(sb.from('pricing_requests').select('id,received_at,subject,summary,kind,status,assigned_to,assigned_at,started_at,done_at,customer_name')
          .eq('requested_by', st.id).order('received_at', { ascending: false }).limit(30), 'my requests'),
        people(),
      ]).then(function (r) {
        var counts = r[0], rows = r[1].data || [], reqs = r[2].data || [], P = r[3];
        if (opts.onCounts && !preview()) { try { opts.onCounts({ mine30: (counts.filter(function (c) { return c[0] === '30'; })[0] || [0, 0])[1] }); } catch (_) { /* page */ } }
        var value = rows.reduce(function (a, k) { return a + (commYear(k) || 0); }, 0);
        // Group by customer so "every meter of this customer" can be ticked at once.
        var byCust = {};
        rows.forEach(function (k) { (byCust[k.uc_customer_id] = byCust[k.uc_customer_id] || []).push(k); });
        var nCust = Object.keys(byCust).length;
        // 07b: a customer's meters ending the same day on the same fuel are one deal, one row. On
        // 7 Nov 2026 Adam Carter's 90 days held 161 meters, 148 of them Motor Parts Direct's water
        // meters all ending 15/12/2026: a wall of SES Water rows burying the other 13. The row ticks
        // them all; "Show them" opens the meters one by one. Under GROUP_MIN they stay as they were.
        var groups = [], gBy = {};
        rows.forEach(function (k, i) {
          var key = [k.uc_customer_id, k.meter_end, k.fuel, k.outcome || ''].join('|');
          var g = gBy[key];
          if (!g) { g = gBy[key] = { rows: [], idx: [] }; groups.push(g); }
          g.rows.push(k); g.idx.push(i);
        });
        var meterRow = function (k, i, gi) {
          return '<tr data-r="' + i + '"' + (gi != null ? ' data-in="' + gi + '" class="tm-mem" hidden' : '') + '><td>' + outcomeHtml(k, i) + '</td>' +
            '<td class="crm-wrap"><button class="crm-link ell" data-cust="' + esc(k.uc_customer_id) + '" title="' + esc(k.customer_name || '') + '">' + esc(k.customer_name || '') + '</button>' +
            (k.site_name ? '<span class="crm-small ell" title="' + esc(k.site_name) + '">' + esc(k.site_name) + '</span>' : '') +
            '<span class="crm-small nowrap">' + fuelIcon(k.fuel) + '<span class="mono">' + esc(k.mpan) + '</span></span></td>' +
            '<td>' + supName(k.supplier) + (k.via_ces === false ? '<div class="crm-small">not via CES</div>' : '') + '</td>' +
            '<td class="nowrap">' + endsHtml(k) + '</td>' +
            '<td class="num nowrap c-opt">' + (k.aq != null ? n0(k.aq) + ' <span class="crm-small">' + (isM3(k.aq_unit) ? 'm&sup3;' : 'kWh') + '</span>' : '') +
            (commYear(k) ? '<div class="crm-small">' + gbp(commYear(k)) + ' a year to CES</div>' : '') + '</td></tr>';
        };
        var uniq = function (a) { return a.filter(function (x, j) { return x && a.indexOf(x) === j; }); };
        var groupRow = function (g, gi) {
          var k0 = g.rows[0], n = g.rows.length;
          var sups = uniq(g.rows.map(function (k) { return k.supplier; }));
          var sites = uniq(g.rows.map(function (k) { return k.site_name; }));
          var comm = g.rows.reduce(function (a, k) { return a + (commYear(k) || 0); }, 0);
          var kwh = !isM3(k0.aq_unit) && k0.fuel !== 'water' ? g.rows.reduce(function (a, k) { return a + (Number(k.aq) || 0); }, 0) : 0;
          var o = k0.outcome ? (OUTCOME[k0.outcome] || [k0.outcome, k0.outcome, 'p-mute']) : null;
          return '<tr class="tm-grp" data-g="' + gi + '"><td><div class="tm-out">' +
            (o ? pill(o[2], esc(o[1])) + '<span class="crm-small">' + esc(k0.outcome_by || '') + ', ' + uk(k0.outcome_at) + '</span>' +
                 '<button class="act ghost sm" data-gmark' + dis() + '>Change all</button>'
               : '<span class="nowrap"><button class="act sm" data-gmark' + (preview() ? dis() : ' title="Tick all ' + n + ' meters"') + '>Mark</button> ' +
                 '<button class="act ghost sm" data-gcheck' + (preview() ? dis() : ' title="Ask Claude about these meters"') + '>Check</button></span>') +
            '<div class="tm-evd" data-gev="' + gi + '"></div></div></td>' +
            '<td class="crm-wrap"><button class="crm-link ell" data-cust="' + esc(k0.uc_customer_id) + '" title="' + esc(k0.customer_name || '') + '">' + esc(k0.customer_name || '') + '</button>' +
            (sites.length ? '<span class="crm-small ell" title="' + esc(sites.join(', ')) + '">' + esc(sites.slice(0, 2).join(', ')) +
              (sites.length > 2 ? ' and ' + n0(sites.length - 2) + ' more' : '') + '</span>' : '') +
            '<span class="crm-small nowrap">' + fuelIcon(k0.fuel) + '<b>' + n0(n) + ' meters</b> ' +
              '<button class="crm-link" data-open="' + gi + '" aria-expanded="false" style="font-size:12px;font-weight:700">Show them</button></span></td>' +
            '<td>' + supName(sups[0]) + (sups.length > 1 ? '<div class="crm-small">and ' + esc(sups.slice(1).join(', ')) + '</div>' : '') +
              (k0.via_ces === false ? '<div class="crm-small">not via CES</div>' : '') + '</td>' +
            '<td class="nowrap">' + endsHtml(k0) + '</td>' +
            '<td class="num nowrap c-opt">' + (kwh ? n0(kwh) + ' <span class="crm-small">kWh</span>' : '') +
              (comm ? '<div class="crm-small">' + gbp(comm) + ' a year to CES</div>' : '') + '</td></tr>';
        };
        body.innerHTML = '<div class="card fillcard tm"><div class="fc-head">' + asBar(P) +
          '<div class="fc-title"><span class="fc-count">' + esc(st.name) + ': <b>' + n0(rows.length) + '</b> meter' + (rows.length === 1 ? '' : 's') + ' ' +
            (win === 'ticked' ? 'ticked' : win === 'overdue' ? 'ended with nothing after them' : 'ending within ' + esc((WINDOWS.filter(function (w) { return w[0] === win; })[0] || ['', ''])[1]) + ' with nothing lined up') +
            (rows.length ? ' (' + n0(nCust) + ' customer' + (nCust === 1 ? '' : 's') + ')' : '') +
            (value && win !== 'ticked' ? ', about <b>' + gbp(value) + '</b> a year in commission' : '') + '</span></div>' +
          '<div class="sub clamp">Contracts in your book. Tick what happened to each one: it leaves this list and the pricing team can see it. ' +
            'A customer\'s meters ending together are one row. Open a customer to see everything on file.</div>' +
          '<div class="crm-seg" id="mineWins" style="margin:0 0 10px">' + counts.map(function (c) {
            var lab = (WINDOWS.filter(function (w) { return w[0] === c[0]; })[0] || [c[0], c[0]])[1];
            return '<button data-w="' + c[0] + '"' + (c[0] === win ? ' class="on"' : '') + '>' + lab + '<span class="c">' + n0(c[1]) + '</span></button>';
          }).join('') + '</div></div>' +
          '<div class="tm-cols"><div class="tm-col"><div class="grid" id="mineList">' +
          (rows.length ? '<table><thead><tr><th>What happened</th><th>Customer and meter</th><th>Supplier now</th><th>Ends</th><th class="num c-opt">AQ and commission</th></tr></thead><tbody>' +
            groups.map(function (g, gi) {
              if (g.rows.length < GROUP_MIN) return g.rows.map(function (k, j) { return meterRow(k, g.idx[j], null); }).join('');
              return groupRow(g, gi) + g.rows.map(function (k, j) { return meterRow(k, g.idx[j], gi); }).join('');
            }).join('') + '</tbody></table>'
            : '<div class="note good" style="margin:10px">' + (win === 'ticked' ? 'Nothing ticked yet.' : 'Nothing in this window. Pick a longer one above.') + '</div>') +
          '</div></div>' +
          '<div class="tm-col"><h3>My requests to pricing</h3><div class="grid" id="mineReqs" style="padding:8px;background:var(--panel-2)">' +
          (reqs.length ? reqs.map(function (x) { return reqCard(x, P); }).join('')
            : '<div class="crm-small" style="padding:6px">Nothing from you in the pricingteam@ inbox lately. Email pricingteam@cesgb.com as usual: requests show here with who has them.</div>') +
          '</div></div></div></div>';
        wireAs();
        [].forEach.call(body.querySelectorAll('#mineWins [data-w]'), function (b) {
          b.addEventListener('click', function () { S.mine.win = b.getAttribute('data-w'); go('mine'); });
        });
        [].forEach.call(body.querySelectorAll('[data-cust]'), function (b) {
          b.addEventListener('click', function () { if (opts.openCompany) opts.openCompany(b.getAttribute('data-cust')); });
        });
        [].forEach.call(body.querySelectorAll('#mineList [data-mark]'), function (b) {
          b.addEventListener('click', function () {
            var tr = b.closest('tr'), k = rows[Number(tr.getAttribute('data-r'))];
            outcomeForm(tr, k, byCust[k.uc_customer_id] || [k]);
          });
        });
        // A deal's row: open its meters, tick them all, or ask Claude about them.
        var openGroup = function (gi, on) {
          var btn = body.querySelector('#mineList [data-open="' + gi + '"]');
          var show = on != null ? on : btn && btn.getAttribute('aria-expanded') !== 'true';
          [].forEach.call(body.querySelectorAll('#mineList tr[data-in="' + gi + '"]'), function (tr) { tr.hidden = !show; });
          if (btn) { btn.setAttribute('aria-expanded', show ? 'true' : 'false'); btn.textContent = show ? 'Hide them' : 'Show them'; }
        };
        [].forEach.call(body.querySelectorAll('#mineList [data-open]'), function (b) {
          b.addEventListener('click', function () { openGroup(b.getAttribute('data-open')); });
        });
        [].forEach.call(body.querySelectorAll('#mineList [data-gmark]'), function (b) {
          b.addEventListener('click', function () {
            var tr = b.closest('tr'), g = groups[Number(tr.getAttribute('data-g'))];
            outcomeForm(tr, g.rows[0], byCust[g.rows[0].uc_customer_id] || g.rows, null, g.rows);
          });
        });
        [].forEach.call(body.querySelectorAll('#mineList [data-gcheck]'), function (b) {
          b.addEventListener('click', function () {
            var g = groups[Number(b.closest('tr').getAttribute('data-g'))], k0 = g.rows[0];
            if (opts.ask) opts.ask('Is a renewal already in place for ' + (k0.customer_name || 'this customer') + '\'s ' + g.rows.length + ' ' + (k0.fuel || '') +
              ' meters ending ' + uk(k0.meter_end) + ' (' + uniq(g.rows.map(function (k) { return k.supplier; })).join(', ') + ')? Check their contracts, ' +
              'the saved quotes and any requests to pricing, and tell me what you found and what you would tick.',
              { page: 'team:mine', company_id: k0.uc_customer_id || null, mpan: k0.mpan });
          });
        });
        // Check: Claude reads the meter's contracts, saved quotes and requests and says what it finds.
        [].forEach.call(body.querySelectorAll('#mineList [data-check]'), function (b) {
          b.addEventListener('click', function () {
            var k = rows[Number(b.closest('tr').getAttribute('data-r'))];
            if (opts.ask) opts.ask('Is a renewal already in place for meter ' + k.mpan + ' (' + (k.customer_name || '') + (k.site_name ? ', ' + k.site_name : '') +
              '), whose ' + (k.supplier || '') + ' contract ends ' + uk(k.meter_end) + '? Check its contracts, the saved quotes and any requests to pricing, ' +
              'and tell me what you found and what you would tick.', { page: 'team:mine', company_id: k.uc_customer_id || null, mpan: k.mpan });
          });
        });
        // The signs, filled in once the list is on screen (never holding it up).
        if (rows.length && win !== 'ticked') {
          evidenceFor(rows).then(function (ev) {
            rows.forEach(function (k, i) {
              var cell = body.querySelector('#mineList [data-ev="' + i + '"]');
              if (!cell || !ev[k.mpan]) return;
              cell.innerHTML = evidenceHtml(k, ev[k.mpan]);
              var yes = cell.querySelector('[data-yes]');
              if (yes) yes.addEventListener('click', function () {
                var won = ev[k.mpan].filter(function (e) { return e.kind === 'won'; })[0];
                outcomeForm(cell.closest('tr'), k, byCust[k.uc_customer_id] || [k], { outcome: 'renewal_in_place', supplier: won ? won.supplier : '' });
              });
              var mv = cell.querySelector('[data-cot]');
              if (mv) mv.addEventListener('click', function () {
                var c = cotOf(k, ev[k.mpan]);
                outcomeForm(cell.closest('tr'), k, byCust[k.uc_customer_id] || [k], { outcome: 'moved_out',
                  note: c ? (c.name || 'Another customer') + ' has the meter from ' + uk(c.start) + (c.supplier ? ' (' + c.supplier + ')' : '') : '' });
              });
            });
            // A deal's row says how many of its meters have a sign, and opens them.
            groups.forEach(function (g, gi) {
              var cell = body.querySelector('#mineList [data-gev="' + gi + '"]');
              if (!cell) return;
              var signs = 0, asked = false;
              g.rows.forEach(function (k) {
                var list = ev[k.mpan] || [];
                if (list.some(function (e) { return e.kind === 'won'; }) || cotOf(k, list)) signs++;
                if (list.some(function (e) { return e.kind === 'req'; })) asked = true;
              });
              cell.innerHTML = (signs ? '<div class="tm-hint">' + n0(signs) + ' of these meters ' + (signs === 1 ? 'has a sign' : 'have signs') +
                  ' of what happened <button class="act sm" data-gsigns>Show them</button></div>' : '') +
                (asked ? '<div class="crm-small">Asked pricing about them</div>' : '');
              var sb2 = cell.querySelector('[data-gsigns]');
              if (sb2) sb2.addEventListener('click', function () { openGroup(gi, true); });
            });
          });
        }
      });
    }
    /**
     * All my customers (7 Nov 2026, 07b). Every customer in the person's UtilityClick book, renewed or
     * not: My renewals only lists contracts with nothing lined up, so a customer whose renewals are
     * all in place (Thaxted Primary School, given to Zak on the desk) would otherwise show nowhere.
     * A customer given to them on the desk is marked so, with what UtilityClick says.
     */
    function renderMyBook() {
      var st = whoFor();
      if (!st || !st.uc_name) return notLinked('My customers');
      var soft = function (b) { return Promise.resolve(b).then(function (r) { return (r && !r.error && r.data) || []; }).catch(function () { return []; }); };
      return Promise.all([
        q(sb.from('crm_customers_v').select('uc_customer_id,name,is_lead,active,meter_count,active_meter_count,live_contracts,next_ced,open_issues,loa_end,loa_status,registered_postcode')
          .eq('account_manager', st.uc_name).is('uc_removed_at', null)
          .order('next_ced', { ascending: true, nullsFirst: false }).order('name').limit(1000), 'my customers'),
        soft(sb.from('crm_account_overrides').select('uc_customer_id,uc_account_manager,set_by_name,set_at').eq('account_manager', st.uc_name)),
        people(),
      ]).then(function (r) {
        var rows = r[0].data || [], P = r[2], ovr = {};
        r[1].forEach(function (o) { ovr[o.uc_customer_id] = o; });
        var t = today();
        var soon = rows.filter(function (c) { return c.next_ced && c.next_ced >= t && (new Date(c.next_ced) - new Date(t)) / 864e5 <= 90; }).length;
        var live = rows.reduce(function (a, c) { return a + (Number(c.live_contracts) || 0); }, 0);
        var loaHtml = function (c) {
          if (c.loa_end) return c.loa_end >= t ? '<span class="crm-small">to ' + uk(c.loa_end) + '</span>' : '<span class="tm-bad">expired ' + uk(c.loa_end) + '</span>';
          return '<span class="crm-small">' + (c.loa_status ? esc(c.loa_status) : 'none on file') + '</span>';
        };
        var endHtml = function (c) {
          if (!c.next_ced) return '<span class="crm-small">none</span>';
          var n = Math.round((new Date(c.next_ced) - new Date(t)) / 864e5);
          return '<span class="' + (n <= 30 ? 'due-0' : n <= 90 ? 'due-1' : '') + '">' + uk(c.next_ced) + '</span><div class="crm-small">' +
            (n < 0 ? n0(-n) + ' days ago' : n === 0 ? 'today' : 'in ' + n0(n) + ' days') + '</div>';
        };
        body.innerHTML = '<div class="card fillcard tm"><div class="fc-head">' + asBar(P) +
          '<div class="fc-title"><span class="fc-count">' + esc(st.name) + ': <b>' + n0(rows.length) + '</b> customer' + (rows.length === 1 ? '' : 's') +
            ', <b>' + n0(live) + '</b> live contract' + (live === 1 ? '' : 's') + (soon ? ', <b>' + n0(soon) + '</b> with a contract ending in the next 90 days' : '') + '</span></div>' +
          '<div class="sub clamp">Every customer in your book, renewed or not, soonest contract end first. My renewals lists only the contracts with nothing lined up. ' +
            'Open a customer to see everything on file.</div>' +
          '<div style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="search" id="bookQ" placeholder="Find a customer or postcode" aria-label="Find in my customers" value="' + esc(S.book.q) + '" style="max-width:320px;height:32px">' +
            '<span class="crm-small" id="bookN"></span></div></div>' +
          '<div class="grid" id="bookList">' + (rows.length ? '<table><thead><tr><th>Customer</th><th class="num">Meters</th><th class="num">Live contracts</th><th>Next contract end</th><th class="c-opt">LOA</th></tr></thead><tbody>' +
            rows.map(function (c, i) {
              var o = ovr[c.uc_customer_id];
              return '<tr data-b="' + i + '" data-text="' + esc(((c.name || '') + ' ' + (c.registered_postcode || '')).toLowerCase()) + '">' +
                // The whole name (the list has the room): "The Light Cinemas (Holdi..." told nobody anything.
                '<td class="crm-wrap" style="min-width:240px"><button class="crm-link" style="text-align:left;white-space:normal;max-width:none" data-cust="' + esc(c.uc_customer_id) + '">' + esc(c.name || '') + '</button>' +
                ' ' + (c.is_lead ? pill('p-mute', 'Lead') : c.active === false ? pill('p-mute', 'Inactive') : '') +
                (o ? ' <span class="pill p-warn" title="Given to ' + esc(st.name) + ' on the desk by ' + esc(o.set_by_name || '') + ' on ' + uk(o.set_at) + '">set on the desk</span>' +
                  '' : '') +
                (c.registered_postcode ? '<span class="crm-small">' + esc(c.registered_postcode) + '</span>' : '') + '</td>' +
                '<td class="num nowrap">' + n0(c.active_meter_count) + (Number(c.meter_count) !== Number(c.active_meter_count) ? ' <span class="crm-small">of ' + n0(c.meter_count) + '</span>' : '') + '</td>' +
                '<td class="num">' + n0(c.live_contracts) + '</td>' +
                '<td class="nowrap">' + endHtml(c) + '</td>' +
                '<td class="nowrap c-opt">' + loaHtml(c) + '</td></tr>';
            }).join('') + '</tbody></table>'
            : '<div class="note" style="margin:10px">No customers under ' + esc(st.uc_name) + ' yet.</div>') + '</div></div>';
        wireAs();
        var box = body.querySelector('#bookQ'), nEl = body.querySelector('#bookN');
        var filter = function () {
          var v = String(box.value || '').trim().toLowerCase(); S.book.q = box.value || '';
          var shown = 0;
          [].forEach.call(body.querySelectorAll('#bookList tr[data-b]'), function (tr) {
            var on = !v || tr.getAttribute('data-text').indexOf(v) >= 0;
            tr.style.display = on ? '' : 'none'; if (on) shown++;
          });
          nEl.textContent = v ? n0(shown) + ' of ' + n0(rows.length) : '';
        };
        box.addEventListener('input', filter);
        if (S.book.q) filter();
        [].forEach.call(body.querySelectorAll('[data-cust]'), function (b) {
          b.addEventListener('click', function () { if (opts.openCompany) opts.openCompany(b.getAttribute('data-cust')); });
        });
      });
    }
    /** The broker's own request, as they see it: who has it and for how long. */
    function reqCard(x, P) {
      var st = RSTATUS[x.status] || [x.status, 'p-mute'];
      var line;
      if (x.status === 'new') {
        var h = hoursSince(x.received_at);
        line = '<span class="tm-age ' + (h > 4 ? 'late' : '') + '">Nobody has it yet: ' + ageWords(x.received_at) + '</span>';
      } else if (x.status === 'assigned') {
        line = personHtml(x.assigned_to, P) + ' took it ' + ageWords(x.assigned_at) + ' ago, not started yet';
      } else if (x.status === 'in_progress') {
        line = personHtml(x.assigned_to, P) + ' is on it (' + ageWords(x.started_at || x.assigned_at) + ')';
      } else if (x.status === 'waiting') {
        line = personHtml(x.assigned_to, P) + ' is waiting on someone';
      } else if (x.status === 'done') {
        line = '<span class="tm-age ok">Done</span> ' + ukTime(x.done_at) + (x.assigned_to ? ' by ' + personHtml(x.assigned_to, P) : '');
      } else {
        line = 'Filed: the team did not treat it as a request';
      }
      return '<div class="tm-req"><div class="s">' + (x.kind && KINDS[x.kind] ? '<span class="tm-kind">' + KINDS[x.kind] + '</span>' : '') +
        esc(x.summary || x.subject || '(no subject)') + '</div>' +
        '<div class="m">Sent ' + ukTime(x.received_at) + (x.customer_name ? ', ' + esc(x.customer_name) : '') + ' ' + pill(st[1], st[0]) + '</div>' +
        '<div class="m">' + line + '</div></div>';
    }
    /**
     * What happened to a contract: the tick. group (07b): a deal's meters, all saved together;
     * "also the other meters" then offers the customer's other rows in the list.
     */
    function outcomeForm(tr, k, siblings, preset, group) {
      var old = tr.parentNode.querySelector('tr.tm-formrow');
      if (old) old.parentNode.removeChild(old);
      var row = doc.createElement('tr');
      row.className = 'tm-formrow';
      var mine = group && group.length ? group : [k];
      var others = siblings.filter(function (x) { return mine.indexOf(x) < 0; });
      var pick0 = (preset && preset.outcome) || k.outcome;
      var sup0 = (preset && preset.supplier) || k.renewal_supplier || '';
      var note0 = (preset && preset.note) || k.outcome_note || '';
      var what = mine.length > 1
        ? n0(mine.length) + ' ' + esc(k.fuel || '') + ' meters with ' + esc(mine.map(function (x) { return x.supplier; }).filter(function (x, j, a) { return x && a.indexOf(x) === j; }).join(', ')) +
          ', ending ' + uk(k.meter_end) + '. Saved for all ' + n0(mine.length) + '.'
        : esc(k.mpan) + ' with ' + esc(k.supplier || '') + ', ends ' + uk(k.meter_end);
      row.innerHTML = '<td colspan="' + tr.children.length + '"><div class="tm-form" role="group" aria-label="What happened to ' + (mine.length > 1 ? n0(mine.length) + ' meters' : esc(k.mpan)) + '">' +
        '<div class="crm-small" style="margin-bottom:4px"><b>' + esc(k.customer_name || '') + '</b>, ' + what + '</div>' +
        '<div class="opts">' + OUTCOMES.map(function (o) {
          return '<label><input type="radio" name="tmOut" value="' + o[0] + '"' + (pick0 === o[0] ? ' checked' : '') + '> ' + esc(o[1]) + '</label>';
        }).join('') + '</div>' +
        '<div class="row2 tm-ren"' + (pick0 === 'renewal_in_place' ? '' : ' hidden') + '><input data-sup placeholder="With which supplier?" value="' + esc(sup0) + '" aria-label="Renewal supplier">' +
          '<input data-start type="date" value="' + esc(k.renewal_start || '') + '" aria-label="Renewal start"></div>' +
        '<div class="row2"><input data-note placeholder="Note (optional)" style="flex:1 1 260px" value="' + esc(note0) + '" aria-label="Note"></div>' +
        (others.length ? '<div class="row2"><label><input type="checkbox" data-all> Also the other ' + others.length + ' meter' + (others.length === 1 ? '' : 's') + ' of ' + esc(k.customer_name || 'this customer') + ' in this list</label></div>' : '') +
        '<div class="row2"><button class="act sm" data-save>Save</button>' + (k.outcome ? '<button class="act ghost sm" data-clear>Take the tick off</button>' : '') +
          '<button class="act ghost sm" data-cancel>Cancel</button><span class="crm-small" data-msg></span></div></div></td>';
      tr.parentNode.insertBefore(row, tr.nextSibling);
      var form = row.querySelector('.tm-form');
      [].forEach.call(form.querySelectorAll('input[name=tmOut]'), function (r) {
        r.addEventListener('change', function () { form.querySelector('.tm-ren').hidden = r.value !== 'renewal_in_place' || !r.checked; });
      });
      var send = function (outcome) {
        var msg = form.querySelector('[data-msg]');
        var all = form.querySelector('[data-all]') && form.querySelector('[data-all]').checked;
        var keys = mine.concat(all ? others : []).map(function (x) { return { t: x.uc_tender_id, m: x.mpan }; });
        msg.textContent = 'Saving...';
        return q(sb.rpc('renewal_set_outcome', {
          p_keys: keys, p_outcome: outcome,
          p_note: (form.querySelector('[data-note]') || {}).value || null,
          p_supplier: outcome === 'renewal_in_place' ? ((form.querySelector('[data-sup]') || {}).value || null) : null,
          p_start: outcome === 'renewal_in_place' ? ((form.querySelector('[data-start]') || {}).value || null) : null,
        }), 'save').then(function () { go('mine'); })
          .catch(function (e) { msg.innerHTML = '<span class="tm-bad">' + esc(e.message) + '</span>'; });
      };
      form.querySelector('[data-save]').addEventListener('click', function () {
        var pick = form.querySelector('input[name=tmOut]:checked');
        if (!pick) { form.querySelector('[data-msg]').innerHTML = '<span class="tm-bad">Pick what happened first.</span>'; return; }
        send(pick.value);
      });
      if (form.querySelector('[data-clear]')) form.querySelector('[data-clear]').addEventListener('click', function () { send(null); });
      form.querySelector('[data-cancel]').addEventListener('click', function () { row.parentNode.removeChild(row); });
      var first = form.querySelector('input[name=tmOut]'); if (first) first.focus();
    }

    // ---------------------------------------------------------------- Requests (pricing team)
    var REQ_COLS = 'id,received_at,from_email,from_name,subject,preview,summary,kind,urgency,customer_name,uc_customer_id,mpans,uc_task,' +
                   'requested_by,status,is_request,assigned_to,assigned_at,started_at,done_at,category_state,category_note,web_link,due_hint';
    var REQ_TABS = [['new', 'New'], ['open', 'Taken, not done'], ['done', 'Done'], ['filed', 'Filed'], ['all', 'All']];
    var MY_TABS = [['open', 'To do'], ['done', 'Done']];
    function reqQuery(tab, mine, head) {
      var b = sb.from('pricing_requests').select(head ? 'id' : REQ_COLS, head ? { count: 'exact', head: true } : {});
      if (mine) b = b.eq('assigned_to', (myStaff() || {}).id || '00000000-0000-0000-0000-000000000000');
      if (tab === 'new') b = b.eq('status', 'new');
      else if (tab === 'open') b = b.in('status', ['assigned', 'in_progress', 'waiting']);
      else if (tab === 'done') b = b.eq('status', 'done');
      else if (tab === 'filed') b = b.eq('status', 'not_request');
      return b;
    }
    function categorise(id) {
      // Outlook colour, after the database has the assignment. Never in the way: the request is
      // taken whether or not Outlook can be coloured, and the panel says which.
      if (!sb.functions || !sb.functions.invoke) return Promise.resolve();
      return Promise.resolve(sb.functions.invoke('request-mail', { body: { mode: 'categorise', request_id: id } })).catch(function () { /* shown on the row */ });
    }
    function reqRow(x, i, selId, P) {
      var st = RSTATUS[x.status] || [x.status, 'p-mute'];
      var h = hoursSince(x.received_at);
      return '<tr class="crm-row' + (x.id === selId ? ' sel' : '') + '" data-q="' + i + '" tabindex="0">' +
        '<td class="nowrap">' + ukTime(x.received_at) + '<div class="crm-small' + (x.status === 'new' && h > 4 ? ' tm-hi' : '') + '">' + ageWords(x.received_at) + ' ago</div></td>' +
        '<td class="crm-wrap"><span class="ell" style="font-weight:700" title="' + esc(x.from_email || '') + '">' + esc(x.from_name || x.from_email || '') + '</span>' +
          (x.requested_by && P[x.requested_by] && (P[x.requested_by].roles || []).indexOf('broker') >= 0 ? '<span class="crm-small">broker</span>' : '') + '</td>' +
        '<td style="min-width:0"><div class="tm-sum">' + (x.kind && KINDS[x.kind] ? '<span class="tm-kind">' + KINDS[x.kind] + '</span>' : '') +
          (x.urgency === 'high' ? '<span class="tm-kind" style="color:var(--fail)">urgent</span>' : '') + esc(x.summary || x.subject || '') + '</div>' +
          (x.customer_name ? '<span class="crm-small ell">' + esc(x.customer_name) + '</span>' : '') + '</td>' +
        '<td>' + (x.assigned_to ? personHtml(x.assigned_to, P) : (x.status === 'new' ? '<button class="act sm nowrap" data-take="' + i + '">Take it</button>' : '')) + '</td>' +
        '<td class="nowrap">' + pill(st[1], st[0]) + '</td></tr>';
    }
    function renderRequests(arg) { return requestsPage(false, arg); }
    function renderMyRequests(arg) { return requestsPage(true, arg); }
    function requestsPage(mine, arg) {
      var R = mine ? S.mreq : S.req, TABS = mine ? MY_TABS : REQ_TABS;
      if (arg && arg.tab) R.tab = arg.tab;
      if (arg && arg.select) R.sel = arg.select;
      if (mine && !myStaff()) {
        body.innerHTML = '<div class="card"><h2>My requests</h2><div class="note warn">This is the shared pricing login, so it has no requests of its own. ' +
          'Sign in with your own account (Microsoft) to take requests and see yours here.</div></div>';
        return Promise.resolve();
      }
      return Promise.all([
        Promise.all(TABS.map(function (t) { return q(reqQuery(t[0], mine, true), 'count').then(function (r) { return [t[0], r.count || 0]; }); })),
        q(reqQuery(R.tab, mine, false).order('received_at', { ascending: R.tab === 'new' }).limit(200), 'requests'),
        q(sb.rpc('requests_summary'), 'summary'),
        people(),
      ]).then(function (r) {
        var counts = r[0], rows = r[1].data || [], summ = r[2].data || {}, P = r[3];
        var term = (R.q || '').trim().toLowerCase();
        if (term) rows = rows.filter(function (x) { return [x.subject, x.summary, x.customer_name, x.from_name, x.from_email].join(' ').toLowerCase().indexOf(term) >= 0; });
        if (opts.onCounts) { try { opts.onCounts({ requestsNew: Number(summ['new']) || 0 }); } catch (_) { /* page */ } }
        body.innerHTML = '<div class="card fillcard tm"><div class="fc-head">' +
          '<div class="fc-title"><span class="fc-count">' +
            (mine ? n0(summ.mine_open || 0) + ' to do' : '<b>' + n0(summ['new'] || 0) + '</b> new' + (summ.oldest_new_hours != null ? ', the oldest ' + n0(summ.oldest_new_hours) + ' h' : '') + ', ' + n0(summ.open || 0) + ' taken, ' + n0(summ.done_today || 0) + ' done today') +
            '</span><span class="fc-actions"><span class="crm-small">' + (summ.last_scan ? 'Inbox read ' + ukTime(summ.last_scan) : 'Inbox not read yet') + '</span>' +
            '<button class="act ghost sm" id="reqScan">Check the inbox now</button></span></div>' +
          (summ.last_error ? '<div class="note warn" style="margin:0 0 8px;padding:6px 10px">Last inbox read failed: ' + esc(summ.last_error) + '</div>' : '') +
          '<div class="toolbar"><input id="reqQ" class="tb-q" value="' + esc(R.q || '') + '" placeholder="Customer, sender or words in the request" aria-label="Search requests"></div>' +
          '<div class="crm-tabs" id="reqTabs">' + counts.map(function (c) {
            var lab = (TABS.filter(function (t) { return t[0] === c[0]; })[0] || [c[0], c[0]])[1];
            return '<button data-t="' + c[0] + '"' + (c[0] === R.tab ? ' class="on"' : '') + '>' + lab + '<span class="c">' + n0(c[1]) + '</span></button>';
          }).join('') + '</div></div>' +
          '<div class="sv" id="reqSv"><div class="sv-main"><div class="grid" id="reqList">' +
          (rows.length ? '<table><thead><tr><th>Received</th><th>From</th><th>What they want</th><th>Who</th><th>Status</th></tr></thead><tbody>' +
            rows.map(function (x, i) { return reqRow(x, i, R.sel, P); }).join('') + '</tbody></table>'
            : '<div class="note" style="margin:10px">' + (mine ? 'Nothing taken. Take one from Requests.' : 'Nothing here.') + '</div>') +
          '</div></div><div class="sv-detail" id="reqDetail" aria-live="polite"><div class="crm-small" style="padding:6px">Pick a request to see it.</div></div></div></div>';
        var again = function () { go(mine ? 'myrequests' : 'requests'); };
        [].forEach.call(body.querySelectorAll('#reqTabs [data-t]'), function (b) {
          b.addEventListener('click', function () { R.tab = b.getAttribute('data-t'); R.sel = null; again(); });
        });
        body.querySelector('#reqQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { R.q = this.value; again(); } });
        body.querySelector('#reqScan').addEventListener('click', function () {
          var b = this; b.disabled = true; b.textContent = 'Reading the inbox...';
          Promise.resolve(sb.functions.invoke('request-mail', { body: { mode: 'scan' } })).then(function (res) {
            if (res && res.error) throw res.error;
            again();
          }).catch(function (e) { b.disabled = false; b.textContent = 'Check the inbox now'; fail(e); });
        });
        var pick = function (i) {
          var x = rows[i]; if (!x) return;
          R.sel = x.id;
          [].forEach.call(body.querySelectorAll('#reqList tr[data-q]'), function (tr) { tr.classList.toggle('sel', Number(tr.getAttribute('data-q')) === i); });
          paintRequest(body.querySelector('#reqDetail'), x.id, again);
        };
        [].forEach.call(body.querySelectorAll('#reqList tr[data-q]'), function (tr) {
          tr.addEventListener('click', function (e) { if (!e.target.closest('button')) pick(Number(tr.getAttribute('data-q'))); });
          tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') pick(Number(tr.getAttribute('data-q'))); });
        });
        [].forEach.call(body.querySelectorAll('#reqList [data-take]'), function (b) {
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            var x = rows[Number(b.getAttribute('data-take'))];
            b.disabled = true;
            take(x.id, null).then(function () { R.sel = x.id; again(); }).catch(function (err) { b.disabled = false; fail(err); });
          });
        });
        var idx = rows.findIndex(function (x) { return x.id === R.sel; });
        if (idx >= 0) pick(idx); else if (rows.length) pick(0);
      });
    }
    function take(id, staffId, unassign) {
      return q(sb.rpc('request_assign', { p_id: id, p_staff: staffId || null, p_unassign: !!unassign }), 'take').then(function (r) {
        categorise(id);
        return r;
      });
    }
    function paintRequest(box, id, onChange) {
      box.innerHTML = '<div class="crm-small">Loading&hellip;</div>';
      return Promise.all([
        q(sb.from('pricing_requests').select('*').eq('id', id).single(), 'request'),
        q(sb.from('pricing_request_events').select('at,by_name,event,detail').eq('request_id', id).order('at'), 'history'),
        people(),
      ]).then(function (r) {
        var x = r[0].data, ev = r[1].data || [], P = r[2];
        var st = RSTATUS[x.status] || [x.status, 'p-mute'];
        var pricingPeople = Object.keys(P).map(function (k) { return P[k]; })
          .filter(function (p) { return p.active && (p.roles || []).some(function (z) { return z === 'pricing' || z === 'admin'; }); })
          .sort(function (a, b) { return String(a.display_name).localeCompare(String(b.display_name)); });
        var colour = x.category_state === 'set' ? 'Coloured in Outlook'
          : x.category_state === 'pending' ? 'Colouring in Outlook...'
          : x.category_state === 'failed' ? 'Outlook colour failed: ' + esc(x.category_note || '')
          : x.category_state === 'none' ? esc(x.category_note || 'No Outlook colour (the Requests app is not set up yet)') : '';
        box.innerHTML = '<div class="qd-h"><div style="min-width:0"><h3>' + esc(x.subject || '(no subject)') + '</h3>' +
          '<div class="qd-facts">From <b>' + esc(x.from_name || '') + '</b> ' + esc(x.from_email || '') + ', ' + ukTime(x.received_at) + ' (' + ageWords(x.received_at) + ' ago)' +
          (x.customer_name ? '<br>Customer: ' + (x.uc_customer_id ? '<button class="crm-link" data-cust="' + esc(x.uc_customer_id) + '">' + esc(x.customer_name) + '</button>' : esc(x.customer_name)) : '') +
          ((x.mpans || []).length ? '<br>Meters: ' + x.mpans.map(function (m) { return '<span class="mono">' + esc(m) + '</span>' + (me().pricing ? ' <button class="act ghost sm" data-price="' + esc(m) + '">Price</button>' : ''); }).join(' ') : '') +
          (x.due_hint ? '<br>When: <b>' + esc(x.due_hint) + '</b>' : '') + '</div></div>' + pill(st[1], st[0]) + '</div>' +
          (x.summary ? '<div class="note" style="margin:6px 0"><b>Claude:</b> ' + esc(x.summary) + '</div>' : '') +
          (x.uc_task ? '<div class="note warn" style="margin:6px 0"><b>CRM update asked for:</b> ' + esc(x.uc_task) + ' <button class="act sm" data-help>Help me do it</button></div>' : '') +
          '<div class="qd-st" role="group" aria-label="Who has it">' +
            (myStaff() && x.assigned_to !== myStaff().id ? '<button class="on" data-takeme>Take it</button>' : '') +
            '<select data-assign aria-label="Give it to" style="width:auto;max-width:220px;height:30px;font-size:12.5px;padding:2px 8px"><option value="">Give it to...</option>' + pricingPeople.map(function (p) {
              return '<option value="' + esc(p.id) + '"' + (p.id === x.assigned_to ? ' selected' : '') + '>' + esc(p.display_name) + '</option>'; }).join('') + '</select>' +
            (x.assigned_to ? '<button data-unassign>Unassign</button>' : '') + '</div>' +
          '<div class="crm-small" style="margin:-2px 0 6px">' + (x.assigned_to ? 'With ' + personHtml(x.assigned_to, P) + ' since ' + ukTime(x.assigned_at) + (x.assigned_by_name ? ', given by ' + esc(x.assigned_by_name) : '') : 'Nobody has it yet.') +
            (colour ? ' &middot; ' + colour : '') + '</div>' +
          '<div class="qd-st" role="group" aria-label="Status">' + ['in_progress', 'waiting', 'done', 'not_request'].map(function (s) {
            return '<button data-st="' + s + '"' + (x.status === s ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' +
              { in_progress: 'In progress', waiting: 'Waiting on someone', done: 'Done', not_request: 'Not a request' }[s] + '</button>';
          }).join('') + '</div>' +
          '<div class="row2" style="display:flex;gap:6px;margin:4px 0 8px"><input data-note placeholder="Add a note" style="flex:1 1 auto;height:30px;font-size:12.5px" aria-label="Note">' +
            '<button class="act ghost sm" data-addnote>Add</button></div>' +
          '<div class="qd-act">' + (x.web_link ? '<a class="act ghost sm" href="' + esc(x.web_link) + '" target="_blank" rel="noopener">Open in Outlook</a>' : '') +
            '<button class="act ghost sm" data-ask>Ask Claude about this</button></div>' +
          (x.preview ? '<div class="tm-prev">' + esc(x.preview) + '</div>' : '') +
          '<div class="crm-h3" style="margin:10px 0 4px">History</div>' +
          (ev.length ? ev.map(function (e) {
            var d = e.detail || {};
            var what = e.event === 'assigned' ? 'gave it to ' + esc(d.to_name || '') : e.event === 'unassigned' ? 'unassigned it'
              : e.event === 'status' ? 'set it to ' + esc((RSTATUS[d.status] || [d.status])[0]) + (d.note ? ': ' + esc(d.note) : '')
              : e.event === 'note' ? 'noted: ' + esc(d.note || '') : e.event === 'created' ? 'found it in the inbox' : esc(e.event);
            return '<div class="tm-ev"><b>' + esc(e.by_name || 'the inbox reader') + '</b> ' + what + ' <span class="crm-small">' + ukTime(e.at) + '</span></div>';
          }).join('') : '<div class="crm-small">Nothing yet.</div>');
        var err = function (e) { box.insertAdjacentHTML('afterbegin', '<div class="note bad">' + esc(e.message || String(e)) + '</div>'); };
        var redo = function () { if (onChange) onChange(); else paintRequest(box, id, onChange); };
        if (box.querySelector('[data-takeme]')) box.querySelector('[data-takeme]').addEventListener('click', function () { take(id, null).then(redo).catch(err); });
        box.querySelector('[data-assign]').addEventListener('change', function () { if (this.value) take(id, this.value).then(redo).catch(err); });
        if (box.querySelector('[data-unassign]')) box.querySelector('[data-unassign]').addEventListener('click', function () { take(id, null, true).then(redo).catch(err); });
        [].forEach.call(box.querySelectorAll('[data-st]'), function (b) {
          b.addEventListener('click', function () {
            var note = box.querySelector('[data-note]').value;
            q(sb.rpc('request_set_status', { p_id: id, p_status: b.getAttribute('data-st'), p_note: note || null }), 'status').then(redo).catch(err);
          });
        });
        box.querySelector('[data-addnote]').addEventListener('click', function () {
          var v = box.querySelector('[data-note]').value;
          if (!v.trim()) return;
          q(sb.rpc('request_note', { p_id: id, p_note: v }), 'note').then(function () { paintRequest(box, id, onChange); }).catch(err);
        });
        [].forEach.call(box.querySelectorAll('[data-cust]'), function (b) { b.addEventListener('click', function () { if (opts.openCompany) opts.openCompany(b.getAttribute('data-cust')); }); });
        [].forEach.call(box.querySelectorAll('[data-price]'), function (b) {
          b.addEventListener('click', function () {
            var m = b.getAttribute('data-price');
            q(sb.from('crm_meters_v').select('*').eq('mpan', m).limit(1), 'meter').then(function (rr) {
              var row = (rr.data || [])[0];
              if (!row) throw new Error('Meter ' + m + ' is not on the desk.');
              if (opts.priceMeter) opts.priceMeter(row);
            }).catch(err);
          });
        });
        var ask = function (qText) {
          if (opts.ask) opts.ask(qText, { page: 'request', request_id: id, company_id: x.uc_customer_id || null, mpan: (x.mpans || [])[0] || null });
        };
        box.querySelector('[data-ask]').addEventListener('click', function () {
          ask('Help me action this request: "' + (x.summary || x.subject || '') + '"' + (x.customer_name ? ' for ' + x.customer_name : '') +
              '. What does the customer have with us now, and what are the steps?');
        });
        if (box.querySelector('[data-help]')) box.querySelector('[data-help]').addEventListener('click', function () {
          ask('This request asks for a CRM update: "' + x.uc_task + '"' + (x.customer_name ? ' for ' + x.customer_name : '') +
              '. Check what the customer record holds now and list exactly what needs changing, field by field.');
        });
      });
    }

    // ---------------------------------------------------------------- People (admins)
    function renderStaff() {
      if (!me().admin) {
        body.innerHTML = '<div class="card"><h2>People</h2><div class="note warn">Only an admin can change the staff list.</div></div>';
        return Promise.resolve();
      }
      return Promise.all([q(sb.rpc('staff_list'), 'staff'),
                          q(sb.from('crm_account_managers_v').select('account_manager').order('account_manager'), 'UC names')]).then(function (r) {
        var list = r[0].data || [], ams = (r[1].data || []).map(function (x) { return x.account_manager; }).filter(Boolean);
        var roleBoxes = function (roles, i) {
          return '<div class="tm-roles">' + [['broker', 'Broker'], ['pricing', 'Pricing team'], ['admin', 'Admin'], ['management', 'Management']].map(function (o) {
            return '<label><input type="checkbox" data-role="' + o[0] + '"' + ((roles || []).indexOf(o[0]) >= 0 ? ' checked' : '') + '> ' + o[1] + '</label>';
          }).join('') + '</div>';
        };
        var presetSel = function (v) {
          return '<select data-preset aria-label="Outlook colour">' + PRESETS.map(function (p) {
            return '<option value="' + p[0] + '"' + (p[0] === v ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>';
        };
        var rowHtml = function (s, i) {
          return '<tr data-i="' + i + '"><td><input type="text" data-name value="' + esc(s.name || '') + '" aria-label="Name"><input type="email" data-email value="' + esc(s.email || '') + '" aria-label="Microsoft email" style="margin-top:4px">' +
            // 7 Nov 2026: the other addresses they send from (adam.carter@ as well as adam@), so their
            // requests in pricingteam@ reach their page.
            '<input type="text" data-alias value="' + esc((s.aliases || []).join(', ')) + '" placeholder="Other addresses they email from" aria-label="Other email addresses" style="margin-top:4px"></td>' +
            '<td>' + roleBoxes(s.roles, i) + '</td>' +
            '<td><input type="text" data-uc list="tmAms" value="' + esc(s.uc_name || '') + '" placeholder="as the CRM export writes it" aria-label="CRM name">' +
              (s.id && s.uc_name ? '<button class="act ghost sm" data-viewas style="margin-top:4px">See their page</button>' : '') + '</td>' +
            // 7 Nov 2026 (07b): the category the team ALREADY uses for this person in pricingteam@
            // ("Joe", "Ben", "Daniel R"); taking a request applies it rather than making a new one.
            '<td><input type="text" data-cat list="tmCats" value="' + esc(s.outlook_category || '') + '" placeholder="their category in Outlook" aria-label="Outlook category" style="min-width:110px">' +
              '<div class="nowrap" style="margin-top:4px"><span class="tm-dot" data-swatch style="width:16px;height:16px;background:' + esc(s.colour || '#94a3b8') + '"></span>' + presetSel(s.outlook_preset || 'preset7') + '</div>' +
              (s.id && !s.outlook_category && ((s.roles || []).indexOf('pricing') >= 0 || (s.roles || []).indexOf('admin') >= 0)
                ? '<div class="crm-small tm-bad" style="max-width:190px">Not set: taking a request would make a new category called ' + esc(s.name || '') + '</div>' : '') + '</td>' +
            '<td class="crm-small">' + (s.id ? (s.logins && s.logins.length ? 'Username: ' + s.logins.map(esc).join(', ') : 'No username login') + '<br>' +
              (s.microsoft ? 'Microsoft: signed in' : 'Microsoft: not yet') + '<div style="display:flex;gap:4px;margin-top:4px"><input type="text" data-login placeholder="username" style="width:90px;min-width:0" aria-label="Link a username login">' +
              '<button class="act ghost sm" data-link>Link</button></div>' : 'New') + '</td>' +
            '<td><label class="crm-small" style="display:flex;gap:4px;align-items:center;text-transform:none;letter-spacing:0;margin:0"><input type="checkbox" data-active' + (s.active === false ? '' : ' checked') + ' style="width:auto;height:auto"> active</label></td>' +
            '<td class="nowrap"><button class="act sm" data-save>' + (s.id ? 'Save' : 'Add') + '</button><div class="crm-small" data-msg></div></td></tr>';
        };
        var rows = list.concat([{ id: null, name: '', email: '', roles: [], active: true }]);
        body.innerHTML = '<div class="card fillcard"><div class="fc-head"><div class="fc-title"><span class="fc-count"><b>' + n0(list.length) + '</b> on the staff list</span></div>' +
          '<div class="sub clamp">Who can sign in and what they see. A person signs in with the Microsoft account of the email here. ' +
          'Brokers see their own book (their CRM name) on their landing page; the pricing team takes requests. ' +
          'Outlook category: the name the team already gives this person\'s emails in pricingteam@ (the list suggests the ones in use). ' +
          'Taking a request puts that category on the email; with none set, Outlook makes a new one in the person\'s full name.</div></div>' +
          '<datalist id="tmAms">' + ams.map(function (a) { return '<option value="' + esc(a) + '">'; }).join('') + '</datalist>' +
          '<datalist id="tmCats"></datalist>' +
          '<div class="grid"><table class="tm-staff"><thead><tr><th>Name and Microsoft email</th><th>Roles</th><th>CRM name</th><th>Outlook category and colour</th><th>Logins</th><th></th><th></th></tr></thead><tbody>' +
          rows.map(rowHtml).join('') + '</tbody></table></div></div>';
        // The categories in use in pricingteam@, for the suggestions. Never in the way: a failure
        // (no Microsoft app yet) leaves the box free text.
        Promise.resolve().then(function () { return sb.functions.invoke('request-mail', { body: { mode: 'categories' } }); }).then(function (res) {
          var seen = (res && !res.error && res.data && res.data.seen) || [];
          var dl = body.querySelector('#tmCats');
          if (dl) dl.innerHTML = seen.map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.name) + ' (' + n0(c.count) + ' emails)</option>'; }).join('');
        }).catch(function () { /* suggestions only */ });
        [].forEach.call(body.querySelectorAll('tr[data-i]'), function (tr) {
          var s = rows[Number(tr.getAttribute('data-i'))];
          var msg = tr.querySelector('[data-msg]');
          var sw = tr.querySelector('[data-swatch]');
          tr.querySelector('[data-preset]').addEventListener('change', function () {
            var p = PRESETS.filter(function (x) { return x[0] === this.value; }, this)[0]; if (p) sw.style.background = p[2];
          });
          tr.querySelector('[data-save]').addEventListener('click', function () {
            var roles = [].map.call(tr.querySelectorAll('[data-role]:checked'), function (c) { return c.getAttribute('data-role'); });
            var preset = tr.querySelector('[data-preset]').value;
            var hex = (PRESETS.filter(function (x) { return x[0] === preset; })[0] || [0, 0, null])[2];
            msg.textContent = 'Saving...';
            var aliases = tr.querySelector('[data-alias]').value.split(/[,;\s]+/).map(function (a) { return a.trim(); }).filter(Boolean);
            var before = (s.aliases || []).join(',');
            var cat = String(tr.querySelector('[data-cat]').value || '').trim();
            var id;
            q(sb.rpc('staff_upsert', { p_id: s.id, p_email: tr.querySelector('[data-email]').value, p_name: tr.querySelector('[data-name]').value,
              p_roles: roles, p_uc_name: tr.querySelector('[data-uc]').value || null, p_colour: hex, p_outlook_preset: preset,
              p_active: tr.querySelector('[data-active]').checked }), 'save').then(function (r) {
                id = (r.data && r.data.id) || (typeof r.data === 'string' ? r.data : null) || s.id;
                if (!id || aliases.join(',') === before) return null;
                return q(sb.rpc('staff_set_aliases', { p_id: id, p_aliases: aliases }), 'other addresses');
              }).then(function () {
                if (!id || cat === String(s.outlook_category || '')) return null;
                return q(sb.rpc('staff_set_outlook', { p_id: id, p_category: cat || null }), 'Outlook category');
              }).then(function () { S.people = null; go('staff'); })
              .catch(function (e) { msg.innerHTML = '<span class="tm-bad">' + esc(e.message) + '</span>'; });
          });
          var va = tr.querySelector('[data-viewas]');
          if (va) va.addEventListener('click', function () {
            S.as = { id: s.id, name: s.name, uc_name: s.uc_name };
            if (opts.onViewAs) { try { opts.onViewAs(S.as); return; } catch (_) { /* fall through */ } }
            go('mine');
          });
          var link = tr.querySelector('[data-link]');
          if (link) link.addEventListener('click', function () {
            var v = tr.querySelector('[data-login]').value.trim();
            if (!v) return;
            msg.textContent = 'Linking...';
            q(sb.rpc('staff_link_login', { p_staff: s.id, p_login: v }), 'link').then(function () { go('staff'); })
              .catch(function (e) { msg.innerHTML = '<span class="tm-bad">' + esc(e.message) + '</span>'; });
          });
        });
      });
    }

    return { go: go, VERSION: VERSION, state: S, refreshPeople: function () { S.people = null; },
             /** An admin: open someone's page as they see it (null: back to one's own). */
             viewAs: function (p) { S.as = me().admin && p && p.uc_name ? { id: p.id, name: p.name || p.display_name, uc_name: p.uc_name } : null; } };
  }

  // ================================================================ Ask Claude
  /**
   * The drawer. Questions go to the desk-assistant edge function with the person's own session,
   * so it can only read what they can read. It never changes anything.
   */
  function chat(o) {
    var sb = o.sb, esc = o.esc, doc = root.document;
    injectStyles(doc);
    var log = [];
    var el = doc.createElement('aside');
    el.className = 'ask-drawer'; el.id = 'askDrawer'; el.setAttribute('aria-label', 'Ask Claude'); el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="ask-head"><b>Ask Claude</b><span class="crm-small">answers from the desk, as you</span>' +
      '<button class="act ghost sm" id="askNew" style="margin-left:auto" title="Start again: Claude forgets this conversation">New chat</button>' +
      '<button class="x" id="askClose" aria-label="Close" style="margin-left:4px">&times;</button></div>' +
      '<div class="ask-log" id="askLog" aria-live="polite"></div>' +
      '<div class="ask-chips" id="askChips"></div>' +
      '<div class="ask-form"><textarea id="askQ" placeholder="Ask anything about customers, contracts, renewals, requests or pricebooks" aria-label="Your question"></textarea>' +
      '<button class="act" id="askGo">Ask</button></div>';
    doc.body.appendChild(el);
    var logEl = el.querySelector('#askLog'), qEl = el.querySelector('#askQ'), goEl = el.querySelector('#askGo');
    var ctxNow = function () { try { return o.context ? o.context() : {}; } catch (_) { return {}; } };
    function paintChips() {
      var me = o.me ? o.me() : {}, c = ctxNow();
      var chips = me.pricing
        ? ['What is new in the requests inbox?', 'Which pricebooks are out of date?', 'Which renewals end this month with nothing lined up?']
        : ['Which of my renewals end in the next 30 days?', 'Who has my requests, and since when?', 'Which of my customers have no contract uploaded?'];
      if (c.company_id) chips.unshift('Summarise this customer for me');
      el.querySelector('#askChips').innerHTML = log.length ? '' : chips.map(function (t) { return '<button>' + esc(t) + '</button>'; }).join('');
      [].forEach.call(el.querySelectorAll('#askChips button'), function (b) { b.addEventListener('click', function () { send(b.textContent); }); });
    }
    function add(role, text, meta) {
      var d = doc.createElement('div');
      d.className = 'ask-msg ' + (role === 'user' ? 'u' : role === 'error' ? 'e' : 'a');
      d.textContent = text;
      if (meta) { var m = doc.createElement('div'); m.className = 'ask-meta'; m.textContent = meta; d.appendChild(m); }
      logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
      return d;
    }
    function readError(res) {
      var e = res && res.error;
      if (!e) return Promise.resolve(null);
      var ctx = e.context;
      if (ctx && typeof ctx.json === 'function') {
        return ctx.json().then(function (j) { return (j && (j.error || j.message)) || e.message; }).catch(function () { return e.message; });
      }
      return Promise.resolve(e.message || String(e));
    }
    function send(text, extraCtx) {
      text = String(text || '').trim();
      if (!text) return;
      open(true);
      add('user', text);
      log.push({ role: 'user', content: text });
      paintChips();
      qEl.value = '';
      goEl.disabled = true;
      var wait = add('assistant', 'Looking...');
      var context = Object.assign({}, ctxNow(), extraCtx || {});
      return Promise.resolve(sb.functions.invoke('desk-assistant', { body: { messages: log.slice(-12), context: context } })).then(function (res) {
        return readError(res).then(function (msg) {
          wait.parentNode.removeChild(wait);
          if (msg) { add('error', msg); log.pop(); return; }
          var d = res.data || {};
          log.push({ role: 'assistant', content: d.text || '' });
          var meta = [d.model ? 'Claude (' + String(d.model).replace(/^claude-/, '') + ')' : '', (d.tools || []).length ? 'looked at ' + d.tools.join(', ') : '',
                      d.remaining_today != null ? d.remaining_today + ' questions left today' : ''].filter(Boolean).join(' . ');
          add('assistant', d.text || '(no answer)', meta);
        });
      }).catch(function (e) {
        if (wait.parentNode) wait.parentNode.removeChild(wait);
        add('error', 'Could not reach the assistant: ' + (e.message || e));
        log.pop();
      }).then(function () { goEl.disabled = false; qEl.focus(); });
    }
    function open(on) {
      var want = on == null ? !el.classList.contains('open') : !!on;
      el.classList.toggle('open', want);
      el.setAttribute('aria-hidden', want ? 'false' : 'true');
      if (want) { paintChips(); setTimeout(function () { qEl.focus(); }, 50); }
    }
    el.querySelector('#askClose').addEventListener('click', function () { open(false); });
    el.querySelector('#askNew').addEventListener('click', function () { log.length = 0; logEl.innerHTML = ''; paintChips(); qEl.focus(); });
    goEl.addEventListener('click', function () { send(qEl.value); });
    qEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(qEl.value); } });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('open')) open(false); });
    return { open: open, ask: send, el: el };
  }

  root.TeamDesk = { VERSION: VERSION, mount: mount, chat: chat, _internals: { OUTCOMES: OUTCOMES, commYear: commYear, ageWords: ageWords } };
})(typeof window !== 'undefined' ? window : globalThis);
