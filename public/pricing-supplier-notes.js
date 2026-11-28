/*
 * pricing-supplier-notes.js - what suppliers' emails say about their pricebooks, on the desk
 * (CES, 28 Nov 2026, build 28a).
 *
 * CES, 28 Nov 2026: "for the mailbox to use the Claude API to notice important emails from suppliers in
 * reference to the pricebooks, e.g. new pricebook is out prices valid to xxx, so it adds a note next to
 * the suppliers name showing when their pricebook expires, or if it says pulling pricebooks immediately
 * it pauses quoting that supplier and references why and then when a new pricebook comes out it uses
 * that."
 *
 * The reading is done by the pricebook-notices edge function (every 15 minutes on weekdays), which
 * writes one pricebook_notices row per supplier email. This file only shows it:
 *   - tileLine(supplier): one or two short lines on the supplier's status tile ("valid to Fri 27 Nov,
 *     1pm", "pulled 18 Nov 14:59", "portal issue 3 Nov");
 *   - detailHtml(supplier): the clicked tile's notices, each with the supplier's own words quoted, when
 *     the email came, and what was done about it;
 *   - mountPanel(host): Pricebooks > Supplier notices, the last 30 days of what the watcher read.
 *
 * WHAT IS DONE ABOUT IT is the database's business, not this page's. CES chose (28 Nov 2026):
 *   - a "valid until" is a NOTE ONLY. The tile says so and says "expired" once it has passed; quoting
 *     carries on (the book's own end date, where the file carries one, still stops it as before);
 *   - a pulled book is paused, and the pause belongs to the book, so the supplier's next book quotes again;
 *   - the watcher starts in WATCH mode: it records what it would have done and pauses nothing. Every
 *     would-be pause says so plainly, with a Pause now button for the pricing team.
 * The supplier's quoted words are checked by the function against the email text before anything is
 * acted on (evidence_ok); a quote that could not be found is flagged here.
 *
 * Data: rpc pricebook_supplier_notes() (the notices still describing the current books),
 * rpc pricebook_automation_status() (mode, last runs), the pricebook_notices table (the page), and
 * rpc pricebook_notice_dismiss / pricebook_notice_apply for the buttons. All read as the signed-in
 * person; the database refuses anyone outside CES staff, and the buttons to anyone outside pricing.
 *
 * Pure helpers are on SupplierNotes._test for the Node tests.
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-28.1';
  var TZ = 'Europe/London';
  var CACHE_MS = 30000;            // the status bar is read on every Pricebooks page; this saves the repeat
  var NOTICE_DAYS = 30;            // the Supplier notices page

  var KIND = {
    new_book: ['New book', 'p-ok'], withdrawn: ['Pulled', 'p-fail'], expiry: ['Expiry', 'p-warn'],
    price_change: ['Price change', 'p-warn'], portal_issue: ['Portal issue', 'p-warn'], info: ['Information', 'p-mute'],
    irrelevant: ['Not about pricebooks', 'p-mute'],
  };
  var ACTIONABLE = ['would_pause', 'scheduled', 'would_schedule'];

  var S = { notes: [], status: null, at: 0, err: '', loading: null };

  // ------------------------------------------------------------------ pure helpers
  function str(v) { return v == null ? '' : String(v); }
  function escHtml(s) {
    return str(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /** A moment in UK time, as parts: {weekday, day, month, year, hour, minute}, or null. */
  function ukParts(d) {
    var dt = d instanceof Date ? d : new Date(d);
    if (d == null || d === '' || isNaN(dt)) return null;
    try {
      var f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                                                  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      var o = {};
      f.formatToParts(dt).forEach(function (p) { o[p.type] = p.value; });
      if (o.hour === '24') o.hour = '00';
      return o;
    } catch (e) {
      return { weekday: '', day: String(dt.getDate()), month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()],
               year: String(dt.getFullYear()), hour: ('0' + dt.getHours()).slice(-2), minute: ('0' + dt.getMinutes()).slice(-2) };
    }
  }
  /** "18 Nov 14:59": when an email came or a pull took effect. */
  function whenShort(d) {
    var p = ukParts(d);
    return p ? p.day + ' ' + p.month + ' ' + p.hour + ':' + p.minute : '';
  }
  /** "Fri 27 Nov, 1pm": how suppliers write a deadline, and how the desk says it back. */
  function whenUntil(d) {
    var p = ukParts(d);
    if (!p) return '';
    var day = (p.weekday ? p.weekday + ' ' : '') + p.day + ' ' + p.month;
    var h = Number(p.hour), m = Number(p.minute);
    if (h === 23 && m >= 59) return day;                       // "valid until 27 November": the whole day
    if (h === 0 && m === 0) return day + ', midnight';
    if (h === 12 && m === 0) return day + ', noon';
    return day + ', ' + ((h % 12) || 12) + (m ? ':' + p.minute : '') + (h < 12 ? 'am' : 'pm');
  }
  /** "Mon 30 Nov": a day on its own. */
  function whenDay(d) {
    var p = ukParts(d);
    return p ? (p.weekday ? p.weekday + ' ' : '') + p.day + ' ' + p.month : '';
  }
  function ms(d) { var t = Date.parse(d); return isFinite(t) ? t : null; }
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fuelWords(fuels) {
    var f = (fuels || []).filter(Boolean);
    if (!f.length || (f.indexOf('electricity') >= 0 && f.indexOf('gas') >= 0)) return '';
    return f[0] === 'gas' ? 'gas' : 'electricity';
  }

  /** The current notices for one supplier, newest first. */
  function notesFor(list, key) {
    return (list || []).filter(function (n) { return n && n.supplier_key === key; })
      .sort(function (a, b) { return (ms(b.received_at) || 0) - (ms(a.received_at) || 0); });
  }
  /** Is this notice's valid-until in the past? The database says so; the clock is the fallback. */
  function isExpired(n, now) {
    if (n.expired != null) return !!n.expired;
    var t = ms(n.valid_until);
    return t != null && t < (now == null ? Date.now() : now);
  }

  /** The line a pulled book gets on its tile. */
  function pullLine(n) {
    var fuel = fuelWords(n.fuels), f = fuel ? fuel + ' ' : '';
    var at = whenShort(n.effective_from && n.action !== 'paused' ? n.effective_from : n.received_at);
    if (n.action === 'paused') {
      return Number(n.live_paused) > 0 ? { cls: 'bad', text: f + 'pulled ' + whenShort(n.received_at) }
                                       : { cls: 'info', text: f + 'pulled ' + whenShort(n.received_at) + ', resumed' };
    }
    if (n.action === 'would_pause') return { cls: 'warn', text: f + 'pulled ' + at + ' (watch only)' };
    if (n.action === 'scheduled') return { cls: 'warn', text: f + 'pulling ' + whenShort(n.effective_from) };
    if (n.action === 'would_schedule') return { cls: 'warn', text: f + 'pulling ' + whenShort(n.effective_from) + ' (watch only)' };
    return { cls: 'warn', text: f + 'pulled ' + whenShort(n.received_at) };
  }

  /** The valid-until line: a note only (CES, 28 Nov 2026). Amber inside the last 24 hours, red once past. */
  function validLine(n, now) {
    var fuel = fuelWords(n.fuels), f = fuel ? fuel + ' ' : '';
    var t = ms(n.valid_until), clock = now == null ? Date.now() : now;
    if (isExpired(n, clock)) return { cls: 'bad', text: f + 'expired ' + whenUntil(n.valid_until) };
    return { cls: t != null && t - clock < 864e5 ? 'warn' : 'info', text: f + 'valid to ' + whenUntil(n.valid_until) };
  }

  /**
   * At most two short lines for a supplier's tile, most important first: a pulled book, then the
   * valid-until (or the day a waiting book goes live), then a portal issue or a price change.
   */
  function tileLines(list, key, now) {
    var mine = notesFor(list, key), out = [], clock = now == null ? Date.now() : now;
    if (!mine.length) return out;
    var pull = mine.filter(function (n) { return n.kind === 'withdrawn'; })[0];
    if (pull) out.push(pullLine(pull));
    var vu = mine.filter(function (n) { return n.valid_until && n.kind !== 'withdrawn'; })[0];
    if (vu) out.push(validLine(vu, clock));
    else {
      var ef = mine.filter(function (n) { return n.kind === 'new_book' && n.effective_from && ms(n.effective_from) > clock; })[0];
      if (ef) out.push({ cls: 'info', text: 'new book from ' + whenDay(ef.effective_from) });
    }
    var portal = mine.filter(function (n) { return n.kind === 'portal_issue'; })[0];
    if (portal) out.push({ cls: 'warn', text: 'portal issue ' + whenShort(portal.received_at).replace(/ \d\d:\d\d$/, '') });
    var pc = mine.filter(function (n) { return n.kind === 'price_change'; })[0];
    if (pc) out.push({ cls: 'warn', text: 'price change ' + (pc.effective_from ? whenDay(pc.effective_from) : whenShort(pc.received_at).replace(/ \d\d:\d\d$/, '')) });
    return out.slice(0, 2);
  }

  /** What was done about a notice, in a sentence. */
  function actionWords(n) {
    var k = (n.upload_ids || []).length;
    switch (n.action) {
      case 'paused':
        return 'Paused ' + count(k, 'book') + ' automatically' + (Number(n.live_paused) > 0 ? '.' : '. Since replaced by a newer book or resumed.');
      case 'would_pause':
        return 'Watch only: nothing was paused. In live mode this would have paused ' + count(k, 'book') + '.';
      case 'scheduled':
        return 'A pause is booked for ' + whenUntil(n.effective_from) + ' (' + count(k, 'book') + ').';
      case 'would_schedule':
        return 'Watch only: in live mode ' + count(k, 'book') + ' would be paused at ' + whenUntil(n.effective_from) + '.';
      case 'noted':
        return n.valid_until ? 'Noted. Quoting carries on; the tile turns red once this time has passed.' : 'Noted. Nothing to do.';
      case 'skipped': return 'Not acted on' + (n.action_note ? ': ' + n.action_note : '.');
      case 'failed': return 'Could not act on it' + (n.action_note ? ': ' + n.action_note : '.');
      default: return n.action_note || '';
    }
  }

  /** One notice, as the clicked tile and the page show it. */
  function itemHtml(n, opts) {
    opts = opts || {};
    var esc = opts.esc || escHtml, kind = KIND[n.kind] || [n.kind, 'p-mute'];
    var fuel = fuelWords(n.fuels);
    var meta = [];
    if (n.effective_from) meta.push((n.kind === 'withdrawn' ? 'takes effect ' : 'from ') + whenUntil(n.effective_from));
    if (n.valid_until) meta.push((isExpired(n, opts.now) ? 'expired ' : 'valid to ') + whenUntil(n.valid_until));
    if (n.version_hint) meta.push(n.version_hint);
    var h = '<div class="sn-item" data-sn-id="' + esc(n.notice_id || n.id) + '">'
      + '<div class="sn-h"><span class="pill ' + kind[1] + '">' + esc(kind[0]) + '</span>'
      + (fuel ? '<span class="sn-meta">' + esc(fuel) + '</span>' : '')
      + '<span class="sn-meta">email ' + esc(whenShort(n.received_at)) + '</span>'
      + (n.mode === 'watch' && ACTIONABLE.concat(['noted']).indexOf(n.action) >= 0 && n.kind === 'withdrawn' ? '<span class="pill p-warn">watch only</span>' : '')
      + '</div>';
    if (n.summary) h += '<div class="sn-sum">' + esc(n.summary) + '</div>';
    if (n.evidence) {
      h += '<div class="sn-ev">&ldquo;' + esc(n.evidence) + '&rdquo;'
        + (n.evidence_ok === false ? ' <span class="pill p-fail" title="The watcher could not find these words in the email itself">not found in the email</span>' : '')
        + '</div>';
    }
    if (meta.length) h += '<div class="sn-meta" style="margin-top:4px">' + esc(meta.join(' · ')) + '</div>';
    var act = actionWords(n);
    if (act) h += '<div class="sn-act">' + esc(act) + '</div>';
    if (opts.buttons) {
      var b = '';
      if (ACTIONABLE.indexOf(n.action) >= 0 && (n.upload_ids || []).length) {
        b += '<button class="act sm" type="button" data-sn-apply="' + esc(n.notice_id || n.id) + '">Pause now</button>';
      }
      if (!n.dismissed_at) b += '<button class="act ghost sm" type="button" data-sn-dismiss="' + esc(n.notice_id || n.id) + '">Dismiss</button>';
      if (b) h += '<div class="sn-btns">' + b + '</div>';
    }
    return h + '</div>';
  }

  // ------------------------------------------------------------------ reading
  function q(builder, what) {
    return Promise.resolve(builder).then(function (r) {
      if (r && r.error) throw new Error(what + ': ' + r.error.message);
      return r ? r.data : null;
    });
  }
  /** A missing function or table (the migration not run yet) is said once, plainly. */
  function plain(e) {
    var m = str(e && e.message ? e.message : e);
    if (/does not exist|could not find the function|schema cache|PGRST20[0-9]|42883|42P01/i.test(m)) {
      return 'The supplier notices are not in the database yet (migration 20261128_01 has not been run).';
    }
    return m;
  }

  /**
   * Read the current notices and the watcher's status. Never throws and never blocks the status bar:
   * a failure leaves the tiles as they were and keeps the reason for the Supplier notices page.
   */
  function load(sb, opts) {
    var fresh = opts && opts.fresh;
    if (!sb || typeof sb.rpc !== 'function') return Promise.resolve(S);
    if (!fresh && S.loading) return S.loading;
    if (!fresh && S.at && Date.now() - S.at < CACHE_MS) return Promise.resolve(S);
    S.loading = Promise.all([
      q(sb.rpc('pricebook_supplier_notes'), 'supplier notices').then(function (r) { return { ok: true, v: r || [] }; },
                                                                       function (e) { return { ok: false, e: e }; }),
      q(sb.rpc('pricebook_automation_status'), 'automation status').then(function (r) { return { ok: true, v: r || null }; },
                                                                        function (e) { return { ok: false, e: e }; }),
    ]).then(function (res) {
      if (res[0].ok) S.notes = res[0].v; else S.notes = [];
      if (res[1].ok) S.status = res[1].v;
      S.err = !res[0].ok ? plain(res[0].e) : (!res[1].ok ? plain(res[1].e) : '');
      S.at = Date.now();
      return S;
    }).catch(function (e) { S.err = plain(e); return S; })
      .then(function (x) { S.loading = null; return x; });
    return S.loading;
  }

  var STYLES = ''
    + '.sn-tl{font-size:11px;font-weight:800;margin-top:3px;line-height:1.35}'
    + '.sn-tl.bad{color:var(--fail)}.sn-tl.warn{color:var(--warn)}.sn-tl.info{color:var(--text-2)}.sn-tl.ok{color:var(--ok)}'
    + '.sn-det{margin-top:10px;display:grid;gap:8px}'
    + '.sn-det-h{font-size:12px;font-weight:700;color:var(--text-2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '.sn-item{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5;color:var(--text)}'
    + '.sn-h{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}'
    + '.sn-meta{font-size:11.5px;color:var(--muted)}'
    + '.sn-sum{margin-top:6px}'
    + '.sn-ev{margin:6px 0 0;padding:6px 10px;border-left:3px solid var(--line-2);background:var(--panel-2);font-size:12px;color:var(--text-2);overflow-wrap:anywhere}'
    + '.sn-act{font-size:12px;margin-top:6px;font-weight:600}'
    + '.sn-btns{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}'
    + '.sn-strip{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:12.5px;line-height:1.5}'
    + '.sn-filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:12px 0}'
    + '.sn-filters>div{min-width:170px}'
    + '.sn-filters label.sn-chk{display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-size:12px;color:var(--text-2);margin:0 0 8px}'
    + '.sn-filters label.sn-chk input{width:auto;height:auto}'
    + '.sn-table td{font-size:12px}'
    + '.sn-table .sn-sub{font-size:11px;color:var(--muted);overflow-wrap:anywhere}';
  function injectStyles(doc) {
    if (!doc || !doc.getElementById || doc.getElementById('snStyles')) return;
    var s = doc.createElement('style'); s.id = 'snStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }

  // ------------------------------------------------------------------ the tiles
  /** Short HTML for a supplier's status tile, or ''. The tile is a <button>, so no buttons in here. */
  function tileLine(key) {
    if (typeof document !== 'undefined') injectStyles(document);
    var lines = tileLines(S.notes, key);
    if (!lines.length) return '';
    var mine = notesFor(S.notes, key);
    var title = mine.slice(0, 3).map(function (n) {
      return (n.summary || '') + (n.evidence ? ' "' + n.evidence + '"' : '');
    }).join('\n');
    return lines.map(function (l) {
      return '<div class="sn-tl ' + l.cls + '" title="' + escHtml(title) + '">' + escHtml(l.text) + '</div>';
    }).join('');
  }

  /** The clicked tile's notices, with the buttons for the pricing team. '' when there are none. */
  function detailHtml(key, opts) {
    opts = opts || {};
    var mine = notesFor(S.notes, key);
    if (!mine.length) return S.err && opts.showErrors ? '<div class="sn-meta" style="margin-top:8px">' + escHtml(S.err) + '</div>' : '';
    var watch = S.status && S.status.notices_mode === 'watch';
    return '<div class="sn-det"><div class="sn-det-h">What the supplier&rsquo;s emails say'
      + (watch ? ' <span class="pill p-warn" title="The mailbox watcher is recording only. Nothing is paused automatically.">watch only</span>' : '')
      + '</div>'
      + mine.map(function (n) { return itemHtml(n, { buttons: opts.buttons !== false && (opts.isPricing ? opts.isPricing() : true) }); }).join('')
      + '</div>';
  }

  /** Find a notice by id in what is loaded (tiles) or on the page. */
  function findNotice(id, extra) {
    return (S.notes || []).concat(extra || []).filter(function (n) { return (n.notice_id || n.id) === id; })[0] || null;
  }

  /**
   * The Dismiss and Pause now buttons inside a container. Safe to call again on the same container
   * (the status detail is redrawn in place): the handler is attached once, the options are updated.
   * opts: {sb, who, isPricing, onChange, supplierName, extra: () => rows}
   */
  function wire(container, opts) {
    if (!container) return;
    container.__snOpts = opts || {};
    if (container.__snWired) return;
    container.__snWired = true;
    container.addEventListener('click', function (e) {
      var o = container.__snOpts || {};
      var btn = e.target && e.target.closest ? e.target.closest('[data-sn-apply],[data-sn-dismiss]') : null;
      if (!btn || !container.contains(btn)) return;
      e.preventDefault(); e.stopPropagation();
      if (o.isPricing && !o.isPricing()) return;
      var id = btn.getAttribute('data-sn-apply') || btn.getAttribute('data-sn-dismiss');
      var n = findNotice(id, o.extra ? o.extra() : null) || {};
      var who = o.who ? o.who() : null;
      var done = function () {
        return load(o.sb, { fresh: true }).then(function () { if (o.onChange) o.onChange(); });
      };
      if (btn.hasAttribute('data-sn-apply')) {
        var sup = o.supplierName ? o.supplierName(n.supplier_key) : (n.supplier_key || 'this supplier');
        var k = (n.upload_ids || []).length;
        if (!root.confirm('Pause ' + sup + ' now?\n\n' + (k ? count(k, 'book') + ' stop' + (k === 1 ? 's' : '') + ' quoting' : 'Its books stop quoting')
            + ' for everyone until a newer book arrives or someone resumes ' + (k === 1 ? 'it' : 'them') + '.'
            + (n.evidence ? '\n\nThe supplier said: "' + n.evidence + '"' : ''))) return;
        btn.disabled = true; btn.textContent = 'Pausing...';
        q(o.sb.rpc('pricebook_notice_apply', { p_id: id, p_by: who || null }), 'pause')
          .then(done).catch(function (err) { btn.disabled = false; btn.textContent = 'Pause now'; root.alert('Could not pause it.\n\n' + plain(err)); });
      } else {
        btn.disabled = true; btn.textContent = 'Dismissing...';
        q(o.sb.rpc('pricebook_notice_dismiss', { p_id: id, p_by: who || null }), 'dismiss')
          .then(done).catch(function (err) { btn.disabled = false; btn.textContent = 'Dismiss'; root.alert('Could not dismiss it.\n\n' + plain(err)); });
      }
    });
  }

  // ------------------------------------------------------------------ the page
  function statusStrip(st, err, esc, supplierName) {
    if (!st) {
      return '<div class="note' + (err ? ' bad' : '') + '">' + esc(err || 'Reading the watcher\u2019s status\u2026') + '</div>';
    }
    var h = '<div class="sn-strip">';
    if (st.notices_enabled === false) h += '<span><span class="pill p-fail">off</span> The mailbox watcher is switched off.</span>';
    else if (st.notices_mode === 'live') {
      h += '<span><span class="pill p-ok">live</span> Books a supplier pulls are paused automatically; the next book quotes again.</span>';
    } else {
      h += '<span><span class="pill p-warn">watch only</span> The watcher reads supplier emails and records what it would do. '
        + 'Nothing is paused automatically: use Pause now on a pulled book.</span>';
    }
    var r = st.last_notice_run;
    if (r && r.started_at) {
      h += '<span>Last read ' + esc(whenShort(r.started_at)) + ': '
        + (r.ok === false ? '<b style="color:var(--fail)">failed</b>' + (r.error ? ' (' + esc(str(r.error).slice(0, 160)) + ')' : '')
          : esc(count(Number(r.classified) || 0, 'email') + ' read, ' + count(Number(r.actions) || 0, 'action')))
        + '</span>';
    } else h += '<span>The watcher has not run yet.</span>';
    if (st.loader_enabled === false) h += '<span>Automatic loading: off.</span>';
    else if (!st.loader_configured) h += '<span>Automatic loading: not set up yet (GitHub repo or token missing).</span>';
    else {
      var L = st.last_loader_run;
      h += '<span>Automatic loading: on'
        + (L && L.at ? '. Last ' + esc(whenShort(L.at)) + ': ' + esc(L.outcome || '') + (L.supplier_key ? ' ' + esc(supplierName ? supplierName(L.supplier_key) : L.supplier_key) : '')
          + (L.file_name ? ', ' + esc(L.file_name) : '') : '') + '.</span>';
    }
    return h + '</div>';
  }

  /**
   * Pricebooks > Supplier notices. deps: {sb, esc, who, isPricing, supplierName, uk, onChange}.
   * Returns {refresh}.
   */
  function mountPanel(host, deps) {
    var doc = host.ownerDocument || root.document, esc = deps.esc || escHtml, sb = deps.sb;
    injectStyles(doc);
    var P = { rows: null, err: '', supplier: '', kind: 'relevant', dismissed: false, busy: false };
    var supName = function (k) { return deps.supplierName ? deps.supplierName(k) : (k || ''); };
    var pricing = function () { return deps.isPricing ? !!deps.isPricing() : true; };

    function read() {
      P.busy = true; paint();
      var since = new Date(Date.now() - NOTICE_DAYS * 864e5).toISOString();
      return Promise.all([
        load(sb, { fresh: true }),
        q(sb.from('pricebook_notices')
          .select('id,received_at,sender,subject,supplier_key,kind,fuels,product_keys,version_hint,effective_from,valid_until,immediate,'
                + 'summary,evidence,evidence_ok,confidence,mode,action,action_note,upload_ids,action_at,dismissed_at,dismissed_by_name')
          .gte('received_at', since).order('received_at', { ascending: false }).limit(1000), 'supplier notices')
          .then(function (r) { P.rows = r || []; P.err = ''; }, function (e) { P.rows = P.rows || []; P.err = plain(e); }),
      ]).then(function () { P.busy = false; paint(); });
    }
    function filtered() {
      return (P.rows || []).filter(function (n) {
        if (!P.dismissed && n.dismissed_at) return false;
        if (P.supplier && n.supplier_key !== P.supplier) return false;
        if (P.kind === 'relevant') return n.kind !== 'irrelevant';
        if (P.kind && P.kind !== 'all') return n.kind === P.kind;
        return true;
      });
    }
    function paint() {
      var rows = filtered();
      var sups = [];
      (P.rows || []).forEach(function (n) { if (n.supplier_key && sups.indexOf(n.supplier_key) < 0) sups.push(n.supplier_key); });
      sups.sort(function (a, b) { return supName(a).localeCompare(supName(b)); });
      var h = '<div class="card">'
        + '<h2>Supplier notices</h2>'
        + '<div class="sub keep">What the mailbox watcher read in supplier emails to pricingteam@cesgb.com in the last ' + NOTICE_DAYS + ' days: '
        + 'new books and how long they are valid, books pulled, portal problems. A &ldquo;valid until&rdquo; is a note only. Each one quotes the '
        + 'supplier&rsquo;s own words, checked against the email.</div>'
        + statusStrip(S.status, S.err, esc, supName)
        + '<div class="sn-filters">'
        + '<div><label for="snSup">Supplier</label><select id="snSup"><option value="">Every supplier</option>'
        + sups.map(function (k) { return '<option value="' + esc(k) + '"' + (k === P.supplier ? ' selected' : '') + '>' + esc(supName(k)) + '</option>'; }).join('')
        + '</select></div>'
        + '<div><label for="snKind">Show</label><select id="snKind">'
        + [['relevant', 'About pricebooks'], ['all', 'Everything read']].concat(Object.keys(KIND).map(function (k) { return [k, KIND[k][0]]; }))
          .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === P.kind ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('')
        + '</select></div>'
        + '<div style="flex:0 0 auto;min-width:0"><label class="sn-chk"><input type="checkbox" id="snDis"' + (P.dismissed ? ' checked' : '') + '> Show dismissed</label></div>'
        + '<div style="flex:0 0 auto;min-width:0"><button class="act ghost" type="button" id="snRefresh"' + (P.busy ? ' disabled' : '') + '>Refresh</button></div>'
        + '</div>';
      if (P.err) h += '<div class="note bad" style="margin-bottom:10px">' + esc(P.err) + '</div>';
      if (P.rows == null) h += '<div class="note">Reading&hellip;</div>';
      else {
        h += '<div class="scroll"><table class="sn-table"><thead><tr><th>Email</th><th>Supplier</th><th>What</th><th>What it says</th>'
          + '<th>Dates</th><th>What was done</th><th></th></tr></thead><tbody>';
        if (!rows.length) h += '<tr><td colspan="7" style="color:var(--muted)">Nothing in the last ' + NOTICE_DAYS + ' days.</td></tr>';
        rows.forEach(function (n) {
          var kind = KIND[n.kind] || [n.kind, 'p-mute'];
          var dates = [];
          if (n.effective_from) dates.push((n.kind === 'withdrawn' ? 'takes effect ' : 'from ') + whenUntil(n.effective_from));
          if (n.valid_until) dates.push((isExpired(n) ? 'expired ' : 'valid to ') + whenUntil(n.valid_until));
          var conf = n.confidence != null && isFinite(Number(n.confidence)) ? Math.round(Number(n.confidence) * 100) + '%' : '';
          var btns = '';
          if (pricing()) {
            if (ACTIONABLE.indexOf(n.action) >= 0 && (n.upload_ids || []).length) btns += '<button class="act sm" type="button" data-sn-apply="' + esc(n.id) + '">Pause now</button> ';
            if (!n.dismissed_at && n.kind !== 'irrelevant') btns += '<button class="act ghost sm" type="button" data-sn-dismiss="' + esc(n.id) + '">Dismiss</button>';
          }
          h += '<tr' + (n.dismissed_at ? ' style="opacity:.6"' : '') + '>'
            + '<td style="white-space:nowrap">' + esc(whenShort(n.received_at)) + '<div class="sn-sub">' + esc(str(n.subject).slice(0, 90)) + '</div>'
            + '<div class="sn-sub">' + esc(n.sender || '') + '</div></td>'
            + '<td>' + esc(n.supplier_key ? supName(n.supplier_key) : '') + (fuelWords(n.fuels) ? '<div class="sn-sub">' + esc(fuelWords(n.fuels)) + '</div>' : '') + '</td>'
            + '<td><span class="pill ' + kind[1] + '">' + esc(kind[0]) + '</span>' + (conf ? '<div class="sn-sub">' + esc(conf) + ' sure</div>' : '') + '</td>'
            + '<td style="min-width:260px">' + esc(n.summary || '')
            + (n.evidence ? '<div class="sn-ev">&ldquo;' + esc(n.evidence) + '&rdquo;' + (n.evidence_ok === false ? ' <span class="pill p-fail">not found in the email</span>' : '') + '</div>' : '')
            + '</td>'
            + '<td style="white-space:nowrap">' + esc(dates.join('\n')).replace(/\n/g, '<br>') + '</td>'
            + '<td style="min-width:180px">' + esc(actionWords(n)) + (n.dismissed_at ? '<div class="sn-sub">Dismissed ' + esc(whenShort(n.dismissed_at))
              + (n.dismissed_by_name ? ' by ' + esc(n.dismissed_by_name) : '') + '</div>' : '') + '</td>'
            + '<td style="white-space:nowrap">' + btns + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      h += '</div>';
      host.innerHTML = h;
      var sel = doc.getElementById('snSup'); if (sel) sel.addEventListener('change', function () { P.supplier = sel.value; paint(); });
      var kd = doc.getElementById('snKind'); if (kd) kd.addEventListener('change', function () { P.kind = kd.value; paint(); });
      var dis = doc.getElementById('snDis'); if (dis) dis.addEventListener('change', function () { P.dismissed = dis.checked; paint(); });
      var rf = doc.getElementById('snRefresh'); if (rf) rf.addEventListener('click', function () { read(); });
    }
    wire(host, { sb: sb, who: deps.who, isPricing: deps.isPricing, supplierName: supName,
                 extra: function () { return P.rows || []; },
                 onChange: function () { read(); if (deps.onChange) deps.onChange(); } });
    paint();
    read();
    return { VERSION: VERSION, refresh: read, state: P };
  }

  root.SupplierNotes = {
    VERSION: VERSION, load: load, tileLine: tileLine, detailHtml: detailHtml, wire: wire, mountPanel: mountPanel,
    state: S,
    _test: { ukParts: ukParts, whenShort: whenShort, whenUntil: whenUntil, whenDay: whenDay, tileLines: tileLines,
             pullLine: pullLine, validLine: validLine, actionWords: actionWords, itemHtml: itemHtml, notesFor: notesFor,
             isExpired: isExpired, fuelWords: fuelWords, plain: plain, statusStrip: statusStrip,
             setNotes: function (list, status) { S.notes = list || []; S.status = status || null; S.at = Date.now(); S.err = ''; } },
  };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).SupplierNotes;
