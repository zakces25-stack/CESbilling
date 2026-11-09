/*
 * pricing-loa.js - Letters of Authority on the pricing desk (build 09a, 9 Nov 2026).
 *
 *  - Each company's LOA tab: is the LOA in date, how long it has left (a tracker from signature to
 *    expiry with today on it), the signed copy itself, every LOA before it, and the renewal.
 *  - Renewals are drafted by the database every morning (crm_loa_renewals_due) for a company with
 *    live, upcoming or locked-in CES supply whose LOA expires within 60 days, has expired, or is not
 *    on the desk. The draft is CES's own 26.03.2026 template filled with the company's details.
 *    Nothing is ever sent by itself: a person checks the details and sends it (DocuSign, once it is
 *    connected, or by email and marked sent).
 *  - The LOA tracker page: every company with live CES supply and where its LOA stands.
 *
 * Expiry is the signature date + the months the LOA states (24 on the current template), read from
 * the document. A signed copy is never replaced by a guess: a date typed on the desk says so.
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-09.1';
  var BUCKET = 'crm-documents';
  // Relative to the page (pricing.html sits at the site root), so a copy opened from disk finds it too.
  var TEMPLATE = 'loa/CES-LOA-template-2026-03-26.pdf';
  // Where CES's template takes each detail: x and the text baseline from the TOP of the A4 page
  // (points), measured from the template converted with LibreOffice (pdfplumber word boxes), and the
  // room to the right margin. Helvetica 9 pt, shrunk to fit.
  var GEO = {
    company:   { x: 100,  y: 72.0,  w: 455 },
    address:   { x: 70,   y: 94.0,  w: 489 },
    reg_no:    { x: 150,  y: 105.0, w: 300 },
    email:     { x: 62,   y: 116.0, w: 380 },
    telephone: { x: 81,   y: 127.0, w: 300 },
    date:      { x: 36.1, y: 160.0, w: 200 }
  };
  var PAGE_H = 841.89;
  var CSS = [
    '.loa-root{display:flex;flex-direction:column;gap:12px;padding:2px}',
    '.loa-root.loa-sum{gap:0;padding:0}',
    '.loa-root .loa-card{background:var(--panel,#fff);border:1px solid var(--line,#dfe3ec);border-radius:12px;padding:14px 16px}',
    '.loa-root h3{font-size:14px;font-weight:800;margin:0 0 8px;color:var(--text,#16203a)}',
    '.loa-root .loa-state{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--text-2,#4a5268)}',
    '.loa-root .loa-big{font-size:20px;font-weight:800;color:var(--text,#16203a)}',
    '.loa-root label.loa-f{display:flex;flex-direction:column;gap:3px;font-size:11.5px;font-weight:700;text-transform:none;letter-spacing:0;color:var(--text-2,#4a5268);margin:0}',
    '.loa-root label.loa-f input,.loa-root label.loa-f select{height:32px;font-size:13px;font-weight:400;padding:5px 9px;width:100%}',
    '.loa-root .loa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 14px}',
    '.loa-root .loa-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}',
    '.loa-root .loa-msg{font-size:12.5px;margin-top:8px}',
    '.loa-root table{width:100%;border-collapse:collapse;font-size:12.5px}',
    '.loa-root th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-2,#4a5268);padding:6px 8px;border-bottom:1px solid var(--line,#dfe3ec)}',
    '.loa-root td{padding:7px 8px;border-bottom:1px solid var(--line,#eef0f5);vertical-align:top}',
    '.loa-steps{display:flex;gap:0;margin:6px 0 4px;font-size:12px}',
    '.loa-steps span{flex:1;text-align:center;padding:6px 4px;background:#eef1f7;color:#5b6378;border-right:2px solid #fff;font-weight:700}',
    '.loa-steps span:first-child{border-radius:8px 0 0 8px}.loa-steps span:last-child{border-radius:0 8px 8px 0;border-right:0}',
    '.loa-steps span.done{background:#1f7a46;color:#fff}.loa-steps span.now{background:#1d4ed8;color:#fff}',
    '.loa-track{margin:10px 0 4px}',
    '.loa-bar{position:relative;height:12px;border-radius:7px;background:#e7eaf1;overflow:visible}',
    '.loa-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:7px}',
    '.loa-bar b{position:absolute;top:-5px;width:3px;height:22px;background:#16203a;border-radius:2px}',
    '.loa-bar.none{background:repeating-linear-gradient(45deg,#eef0f5,#eef0f5 6px,#e1e5ee 6px,#e1e5ee 12px)}',
    '.loa-ends{display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-2,#4a5268);margin-top:6px}',
    '.loa-ok{color:#1f7a46}.loa-warn{color:#9a5b00}.loa-bad{color:#b42318}.loa-mute{color:#5b6378}',
    '.loa-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}',
    '.loa-pill.valid{background:#e3f4ea;color:#1f7a46}.loa-pill.expiring{background:#fdf1dc;color:#8a5200}',
    '.loa-pill.expired{background:#fde4e2;color:#b42318}.loa-pill.none{background:#eef0f5;color:#4a5268}',
    '.loa-chips{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px}',
    '.loa-chips button{border:1px solid var(--line,#dfe3ec);background:#fff;border-radius:10px;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;text-align:left;color:var(--text-2,#4a5268)}',
    '.loa-chips button b{display:block;font-size:17px;color:var(--text,#16203a)}',
    '.loa-chips button.on{border-color:#1d4ed8;box-shadow:0 0 0 2px #dbe5ff}',
    '.loa-list tr[data-c]{cursor:pointer}.loa-list tr[data-c]:hover td{background:#f5f8ff}'
  ].join('\n');

  // ------------------------------------------------------------ dates
  var MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function iso(d) { return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function addMonths(isoDay, n) {
    var p = isoDay.split('-').map(Number), y = p[0], m = p[1] - 1 + n, d = p[2];
    var ny = y + Math.floor(m / 12), nm = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(ny, nm, Math.min(d, last))));
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function today() { var t = new Date(); return iso(new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))); }
  function parseDate(s) {
    s = String(s || '').trim();
    var m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s), y, mo, d;
    if (m && MON[m[2].toLowerCase()] != null) { y = Number(m[3]); y = y < 100 ? y + 2000 : y; mo = MON[m[2].toLowerCase()]; d = Number(m[1]); }
    else if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s))) { d = Number(m[1]); mo = Number(m[2]) - 1; y = Number(m[3]); y = y < 100 ? y + 2000 : y; }
    else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s)) && MON[m[2].slice(0, 3).toLowerCase()] != null) { d = Number(m[1]); mo = MON[m[2].slice(0, 3).toLowerCase()]; y = Number(m[3]); }
    else return null;
    var dt = new Date(Date.UTC(y, mo, d));
    return dt.getUTCMonth() === mo && dt.getUTCDate() === d && y >= 2000 ? iso(dt) : null;
  }
  var DATE_RX = '(\\d{1,2}-[A-Za-z]{3}-\\d{2,4}|\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4})';
  /** The same rules the library load used (loa_lib.py find_dates): signature block, DocuSign stamp, letter date. */
  function findDates(text) {
    var flat = String(text || '').replace(/[ \t]+/g, ' '), low = flat.toLowerCase(), m, d;
    var i = low.lastIndexOf('yours faithfully'), tail = i >= 0 ? flat.slice(i) : flat.slice(-2500);
    m = new RegExp('\\bDate\\s*[:\\-]?\\s*' + DATE_RX, 'i').exec(tail);
    if (m && (d = parseDate(m[1]))) return { signed: d, how: 'the signature block' };
    m = new RegExp('(?:Signed|Completed)(?: On)?\\s*[:\\-]?\\s*' + DATE_RX, 'i').exec(flat);
    if (m && (d = parseDate(m[1]))) return { signed: d, how: 'the DocuSign stamp' };
    var k = low.indexOf('to whom'), head = k > 0 ? flat.slice(0, k) : flat.slice(0, 1500), re = new RegExp(DATE_RX, 'g');
    while ((m = re.exec(head))) { if ((d = parseDate(m[1])) && d <= today()) return { signed: d, how: 'the date the letter is dated' }; }
    return null;
  }
  function monthsIn(text) {
    var m = /valid for (?:the|a) period of (\d{1,3})\s*months/i.exec(String(text || ''));
    return m ? Number(m[1]) : null;
  }

  /** Where an LOA stands from its crm_loa_current_v row (or none). */
  function stateOf(cur) {
    var t = today();
    if (!cur || !cur.loa_id || !cur.expires_on) return { key: 'none', label: 'No LOA on the desk', cls: 'none', days: null };
    var left = daysBetween(t, cur.expires_on);
    if (left < 0) return { key: 'expired', label: 'Expired ' + ukDate(cur.expires_on), cls: 'expired', days: left };
    if (left <= 60) return { key: 'expiring', label: 'Expires ' + ukDate(cur.expires_on) + ' (' + left + ' day' + (left === 1 ? '' : 's') + ')', cls: 'expiring', days: left };
    return { key: 'valid', label: 'In date to ' + ukDate(cur.expires_on), cls: 'valid', days: left };
  }
  function ukDate(d) {
    if (!d) return '';
    var x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
    return x.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()] + ' ' + x.getUTCFullYear();
  }
  function pill(cur) { var s = stateOf(cur); return '<span class="loa-pill ' + s.cls + '" title="Letter of Authority">LOA: ' + s.label + '</span>'; }

  /** The tracker: signature on the left, expiry on the right, today marked; the fill says how much is used. */
  function tracker(cur) {
    var s = stateOf(cur);
    if (s.key === 'none') return '<div class="loa-track"><div class="loa-bar none"></div><div class="loa-ends"><span>No signed LOA on the desk</span><span></span></div></div>';
    var total = Math.max(1, daysBetween(cur.signed_on, cur.expires_on)), used = Math.min(total, Math.max(0, daysBetween(cur.signed_on, today())));
    var pct = Math.round(used / total * 1000) / 10;
    var col = s.key === 'valid' ? '#2e9d5e' : s.key === 'expiring' ? '#d98b00' : '#d64545';
    return '<div class="loa-track" role="img" aria-label="' + s.label + '"><div class="loa-bar"><i style="width:' + pct + '%;background:' + col + '"></i>' +
      '<b style="left:calc(' + Math.min(100, pct) + '% - 1px)" title="Today"></b></div>' +
      '<div class="loa-ends"><span>Signed ' + ukDate(cur.signed_on) + '</span><span>' + (s.days >= 0 ? s.days + ' day' + (s.days === 1 ? '' : 's') + ' left' : 'expired ' + (-s.days) + ' day' + (s.days === -1 ? '' : 's') + ' ago') +
      '</span><span>Expires ' + ukDate(cur.expires_on) + '</span></div></div>';
  }

  function textSafe(s) {
    // Helvetica in pdf-lib draws WinAnsi only: accents folded, curly quotes straightened, the rest dropped.
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa3]/g, '').replace(/\s+/g, ' ').trim();
  }
  /** CES's LOA (26.03.2026 template) with the company's details on it, as PDF bytes. */
  function buildPdf(PDFLib, templateBytes, details, dateIso) {
    return PDFLib.PDFDocument.load(templateBytes).then(function (pdf) {
      return pdf.embedFont(PDFLib.StandardFonts.Helvetica).then(function (font) {
        var page = pdf.getPages()[0];
        var put = function (key, text) {
          text = textSafe(text); if (!text) return;
          var g = GEO[key], size = 9;
          while (size > 6 && font.widthOfTextAtSize(text, size) > g.w) size -= 0.25;
          while (text.length > 4 && font.widthOfTextAtSize(text, size) > g.w) text = text.slice(0, -2);
          page.drawText(text, { x: g.x, y: PAGE_H - g.y, size: size, font: font, color: PDFLib.rgb(0, 0, 0) });
        };
        put('company', details.company); put('address', details.address); put('reg_no', details.reg_no);
        put('email', details.email); put('telephone', details.telephone);
        var p = (dateIso || today()).split('-'); put('date', p[2] + '/' + p[1] + '/' + p[0]);
        pdf.setTitle('Letter of Authority - ' + textSafe(details.company));
        pdf.setProducer('CES pricing desk'); pdf.setCreator('CES pricing desk');
        return pdf.save();
      });
    });
  }

  function create(o) {
    var sb = o.sb, esc = o.esc, RO = !!o.readOnly, docs = o.docs, doc = root.document;
    if (doc && !doc.getElementById('loaStyles')) { var st = doc.createElement('style'); st.id = 'loaStyles'; st.textContent = CSS; doc.head.appendChild(st); }
    var dsStatus = null;
    function q(p, what) { return Promise.resolve(p).then(function (r) { if (r.error) throw new Error(what + ': ' + r.error.message); return r; }); }
    function errText(e) { return (e && (e.message || e.error_description)) || String(e); }
    function fnCall(op, body) {
      return Promise.resolve(sb.functions.invoke('loa-docusign', { body: Object.assign({ op: op }, body || {}) })).then(function (r) {
        if (!r.error) return r.data;
        var ctx = r.error.context;
        return (ctx && ctx.json ? ctx.json().catch(function () { return null; }) : Promise.resolve(null)).then(function (j) {
          throw new Error((j && j.error) || r.error.message || 'DocuSign did not answer');
        });
      });
    }
    function docuSign() {
      if (dsStatus) return dsStatus;
      dsStatus = fnCall('status').then(function (d) { return d || { configured: false }; }).catch(function () { return { configured: false, unreachable: true }; });
      return dsStatus;
    }
    function sha256(buf) {
      return root.crypto.subtle.digest('SHA-256', buf).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    }
    function safeName(n) { var s = String(n || 'LOA.pdf').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_'); return s.length > 100 ? s.slice(-100) : s; }
    function pdfText(buf) {
      if (!o.loadPdfJs) return Promise.resolve('');
      return o.loadPdfJs().then(function (lib) { return lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; }).then(function (pdf) {
        var n = Math.min(pdf.numPages, 3), pages = [];
        for (var i = 1; i <= n; i++) pages.push(i);
        return Promise.all(pages.map(function (p) {
          return pdf.getPage(p).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
            return tc.items.map(function (it) { return it.str + (it.hasEOL ? '\n' : ' '); }).join('');
          });
        })).then(function (t) { return t.join('\n'); });
      }).catch(function () { return ''; });
    }
    var templateBytes = null;
    function template() {
      if (templateBytes) return Promise.resolve(templateBytes);
      return fetch(o.templateUrl || TEMPLATE).then(function (r) {
        if (!r.ok) throw new Error('The LOA template (' + TEMPLATE + ') did not load: ' + r.status);
        return r.arrayBuffer();
      }).then(function (b) { templateBytes = b; return b; });
    }
    function renewalPdf(renewal, name) {
      return Promise.all([o.loadPdfLib(), template()]).then(function (x) {
        return buildPdf(x[0], x[1], renewal.details || {}, today());
      });
    }
    function saveBlob(bytes, fileName) {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      var a = doc.createElement('a'); a.href = url; a.download = fileName; doc.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    // ------------------------------------------------------------ the overview card
    function summary(ctx) {
      var cur = ctx.loa, s = stateOf(cur), rn = renewalOf(ctx);
      var docRow = cur && cur.document_id ? (ctx.loaDocs || {})[cur.document_id] : null;
      return '<div class="loa-root loa-sum"><div class="loa-state"><span class="loa-pill ' + s.cls + '">' + esc(s.label) + '</span>' +
        (cur && cur.signed_on ? '<span>signed ' + esc(ukDate(cur.signed_on)) + '</span>' : '') + '</div>' + tracker(cur) +
        (rn ? '<div class="crm-small" style="margin-top:6px">' + renewalLine(rn) + '</div>' : '') +
        '<div class="loa-btns" style="margin-top:8px">' + (docRow ? '<button class="act sm" data-loa-open="' + esc(docRow.id) + '">Open the LOA</button>' : '') +
        '<button class="act ghost sm" data-goto="loa">' + (rn && rn.status === 'draft' ? 'Renewal ready to send &rarr;' : 'LOA details &rarr;') + '</button></div></div>';
    }
    function renewalOf(ctx) { return (ctx.loas || []).filter(function (l) { return l.kind === 'renewal' && !l.removed_at && (l.status === 'draft' || l.status === 'sent'); })[0] || null; }
    function renewalLine(rn) {
      var why = { expiring: 'the LOA expires soon', expired: 'the LOA has expired', none: 'no LOA is on the desk', manual: 'drafted on the desk' }[rn.reason] || '';
      if (rn.status === 'draft') return '<b>Renewal LOA drafted</b> ' + esc(ukDate(rn.created_at)) + (why ? ' (' + why + ')' : '') + ', not sent yet.';
      return '<b>Renewal LOA sent</b> ' + esc(ukDate(rn.envelope_sent_at)) + (rn.to_email ? ' to ' + esc(rn.to_email) : '') +
        (rn.envelope_id ? ' by DocuSign' : ' by email') + ', waiting for the signed copy.';
    }
    function wireOpen(scope, ctx) {
      [].forEach.call(scope.querySelectorAll('[data-loa-open]'), function (b) {
        b.addEventListener('click', function () {
          var d = (ctx.loaDocs || {})[b.getAttribute('data-loa-open')];
          if (d && docs) docs.view(d).catch(function (e) { alert(errText(e)); });
        });
      });
    }

    // ------------------------------------------------------------ the LOA tab
    function paint(box, ctx, again) {
      var cur = ctx.loa, s = stateOf(cur), rn = renewalOf(ctx), id = ctx.c.uc_customer_id;
      var docRow = cur && cur.document_id ? (ctx.loaDocs || {})[cur.document_id] : null;
      var signedRow = cur ? (ctx.loas || []).filter(function (l) { return l.id === cur.loa_id; })[0] : null;
      var how = { document: 'read from the signed LOA', docusign: 'from DocuSign', typed: 'typed on the desk', file_name: 'from the file name' };
      var h = '<div class="loa-root">';
      h += '<div class="loa-card"><h3>Current Letter of Authority</h3>' +
        '<div class="loa-state"><span class="loa-big ' + (s.key === 'valid' ? 'loa-ok' : s.key === 'expiring' ? 'loa-warn' : s.key === 'expired' ? 'loa-bad' : 'loa-mute') + '">' + esc(s.label) + '</span>' +
        (cur && cur.signed_on ? '<span>Signed ' + esc(ukDate(cur.signed_on)) + ' (' + esc(how[cur.date_source] || 'date on record') + '), valid ' + (signedRow ? signedRow.valid_months : 24) + ' months</span>' : '') + '</div>' +
        tracker(cur) +
        (signedRow ? '<div class="crm-small" style="margin-top:6px">' + esc(signedRow.file_name || '') +
          (signedRow.signatory_name ? ' &middot; signed by ' + esc(signedRow.signatory_name) + (signedRow.signatory_position ? ', ' + esc(signedRow.signatory_position) : '') : '') +
          ' &middot; added by ' + esc(signedRow.created_by_name || 'CES') + ' ' + esc(ukDate(signedRow.created_at)) + '</div>' : '') +
        '<div class="loa-btns">' + (docRow ? '<button class="act sm" data-loa-open="' + esc(docRow.id) + '">Open the LOA</button><button class="act ghost sm" data-loa-dl="' + esc(docRow.id) + '">Download</button>' : '') +
        (s.key === 'none' ? '<span class="crm-small">No signed LOA for this company is on the desk. Upload it below, or send the renewal.</span>' : '') + '</div></div>';

      // The renewal
      h += '<div class="loa-card" id="loaRenewal"><h3>Renewal</h3>';
      if (rn) {
        var d = rn.details || {};
        var step = rn.status === 'draft' ? 1 : 2;
        h += '<div class="loa-steps"><span class="done">Drafted ' + esc(ukDate(rn.created_at)) + '</span><span class="' + (step >= 2 ? 'done' : 'now') + '">' +
          (step >= 2 ? 'Sent ' + esc(ukDate(rn.envelope_sent_at)) : 'Check and send') + '</span><span class="' + (step >= 2 ? 'now' : '') + '">Signed and back</span></div>' +
          '<div class="crm-small" style="margin:6px 0 10px">' + renewalLine(rn) + (rn.envelope_status && rn.envelope_id ? ' DocuSign says: <b>' + esc(rn.envelope_status) + '</b>.' : '') + '</div>';
        var dis = rn.status !== 'draft' || RO ? ' disabled' : '';
        h += '<div class="loa-grid">' +
          fld('company', 'Company name', d.company, dis) + fld('reg_no', 'Company registration number', d.reg_no, dis) +
          fld('address', 'Registered office address', d.address, dis, true) + fld('email', 'Email on the LOA', d.email, dis) +
          fld('telephone', 'Telephone on the LOA', d.telephone, dis) + fld('to_name', 'Send to (name)', rn.to_name, dis) + fld('to_email', 'Send to (email)', rn.to_email, dis) +
          '</div>';
        h += '<div class="loa-btns">' +
          (rn.status === 'draft' && !RO ? '<button class="act sm" data-a="save">Save details</button>' : '') +
          '<button class="act ghost sm" data-a="pdf">Download the filled LOA (PDF)</button>' +
          (rn.status === 'draft' && !RO ? '<button class="act sm" data-a="ds" style="background:#1d4ed8;color:#fff">Send for signature (DocuSign)</button>' +
            '<button class="act ghost sm" data-a="emailed">I sent it by email</button><button class="act ghost sm" data-a="cancel">Cancel this renewal</button>' : '') +
          (rn.status === 'sent' && rn.envelope_id ? '<button class="act ghost sm" data-a="refresh">Check DocuSign now</button>' : '') +
          '</div><div class="loa-msg" id="loaMsg" aria-live="polite"></div>';
      } else {
        h += '<div class="crm-small">' + (s.key === 'valid' ? 'Nothing to do: a renewal is drafted by itself 60 days before this LOA expires.' : 'No renewal is under way.') + '</div>' +
          (RO ? '' : '<div class="loa-btns"><button class="act sm" data-a="draft">Draft a renewal LOA now</button></div><div class="loa-msg" id="loaMsg" aria-live="polite"></div>');
      }
      h += '</div>';

      // Upload a signed LOA
      if (!RO) {
        h += '<div class="loa-card"><h3>Add a signed LOA</h3><div class="crm-small" style="margin-bottom:8px">A PDF. The signature date is read from the document where it can be; check it before adding.</div>' +
          '<div class="loa-grid"><label class="loa-f">Signed LOA (PDF)<input type="file" id="loaFile" accept="application/pdf,.pdf"></label>' +
          '<label class="loa-f">Date signed<input type="date" id="loaSigned" max="' + today() + '"></label>' +
          '<label class="loa-f">Valid for (months)<input type="number" id="loaMonths" min="1" max="120" value="24"></label>' +
          '<label class="loa-f">Signed by (optional)<input type="text" id="loaWho" maxlength="120"></label></div>' +
          '<div class="crm-small" id="loaRead" style="margin-top:6px"></div>' +
          '<div class="loa-btns"><button class="act sm" id="loaAdd" disabled>Add this LOA</button></div><div class="loa-msg" id="loaAddMsg" aria-live="polite"></div></div>';
      }

      // History
      var hist = (ctx.loas || []).slice().sort(function (a, b) { return String(b.signed_on || b.created_at).localeCompare(String(a.signed_on || a.created_at)); });
      h += '<div class="loa-card"><h3>Every LOA on the desk (' + hist.length + ')</h3>' + (hist.length ? '<div style="overflow-x:auto"><table><thead><tr><th>What</th><th>Signed</th><th>Expires</th><th>Where from</th><th>File</th><th></th></tr></thead><tbody>' +
        hist.map(function (l) {
          var exp = l.kind === 'signed' && l.signed_on ? addMonths(l.signed_on, l.valid_months || 24) : null;
          var st2 = l.kind === 'signed' ? (exp < today() ? '<span class="loa-pill expired">Expired</span>' : l.id === (cur && cur.loa_id) ? '<span class="loa-pill valid">Current</span>' : '<span class="loa-pill valid">In date</span>')
            : '<span class="loa-pill none">Renewal: ' + esc(l.status) + '</span>';
          var dr = l.document_id ? (ctx.loaDocs || {})[l.document_id] : null;
          return '<tr><td>' + st2 + '</td><td>' + esc(ukDate(l.signed_on)) + '</td><td>' + esc(ukDate(exp)) + '</td><td>' +
            esc({ library: 'LOA folder', upload: 'uploaded', docusign: 'DocuSign', auto: 'drafted automatically', desk: 'drafted on the desk' }[l.source] || l.source) +
            (l.note ? '<div class="crm-small">' + esc(l.note) + '</div>' : '') + '</td><td class="crm-wrap">' + esc(l.file_name || '') + '</td><td>' +
            (dr ? '<button class="act ghost sm" data-loa-open="' + esc(dr.id) + '">Open</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="crm-small">None yet.</div>') + '</div>';
      h += '</div>';
      box.innerHTML = h;
      wireOpen(box, ctx);
      [].forEach.call(box.querySelectorAll('[data-loa-dl]'), function (b) {
        b.addEventListener('click', function () { var d = (ctx.loaDocs || {})[b.getAttribute('data-loa-dl')]; if (d && docs) docs.download(d).catch(function (e) { alert(errText(e)); }); });
      });
      var msg = function (t, bad) { var m = box.querySelector('#loaMsg'); if (m) m.innerHTML = '<span class="' + (bad ? 'loa-bad' : 'loa-ok') + '">' + t + '</span>'; };
      var val = function (k) { var el = box.querySelector('[data-k="' + k + '"]'); return el ? el.value.trim() : ''; };
      var details = function () { return { company: val('company'), reg_no: val('reg_no'), address: val('address'), email: val('email'), telephone: val('telephone') }; };
      var act = function (a, fn) { var b = box.querySelector('[data-a="' + a + '"]'); if (b) b.addEventListener('click', function () { b.disabled = true; Promise.resolve().then(fn).catch(function (e) { msg(esc(errText(e)), true); }).then(function () { b.disabled = false; }); }); };
      var saveDraft = function () {
        return q(sb.rpc('crm_loa_renewal_update', { p_id: rn.id, p_details: details(), p_to_name: val('to_name'), p_to_email: val('to_email') }), 'saving the details');
      };
      act('draft', function () { return q(sb.rpc('crm_loa_renewal_create', { p_customer: id }), 'drafting the LOA').then(again); });
      act('save', function () { return saveDraft().then(function () { msg('Saved.'); }); });
      act('pdf', function () {
        var r2 = Object.assign({}, rn, { details: rn.status === 'draft' ? details() : rn.details });
        return renewalPdf(r2).then(function (bytes) { saveBlob(bytes, 'LOA - ' + textSafe(r2.details.company || ctx.c.name) + ' - ' + today() + '.pdf'); msg('Downloaded. It is CES&rsquo;s LOA (26.03.2026) with these details filled in.'); });
      });
      act('emailed', function () {
        if (!val('to_email')) throw new Error('Put in the email address it was sent to first.');
        return saveDraft().then(function () { return q(sb.rpc('crm_loa_renewal_mark_sent', { p_id: rn.id, p_how: 'email' }), 'marking it sent'); }).then(again);
      });
      act('cancel', function () {
        var why = root.prompt ? root.prompt('Why is this renewal not needed? (shown in the history)') : 'not needed';
        if (why == null) return;
        return q(sb.rpc('crm_loa_renewal_cancel', { p_id: rn.id, p_reason: why }), 'cancelling').then(again);
      });
      act('ds', function () {
        if (!val('to_email') || !val('to_name')) throw new Error('Put in who it goes to (name and email) first.');
        return docuSign().then(function (st) {
          if (!st.configured) throw new Error('DocuSign is not connected to the desk yet (CES_SETUP.md, section DocuSign). Download the filled LOA and send it by email, then press "I sent it by email".');
          if (!root.confirm('Send the LOA to ' + val('to_name') + ' <' + val('to_email') + '> for signature with DocuSign now?')) return;
          return saveDraft().then(function () { return renewalPdf(Object.assign({}, rn, { details: details() })); }).then(function (bytes) {
            var path = id + '/loa-renewal/' + rn.id + '.pdf';
            return q(sb.storage.from(BUCKET).upload(path, new Blob([bytes], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: true }), 'storing the LOA')
              .then(function () { return fnCall('send', { renewal_id: rn.id, path: path }); });
          }).then(function (r) { msg('Sent. DocuSign envelope ' + esc(r && r.envelope_id || '') + '.'); return again(); });
        });
      });
      act('refresh', function () { return fnCall('refresh', { renewal_id: rn.id }).then(function (r) { msg('DocuSign says: ' + esc(r && r.status || 'no change')); return again(); }); });

      // Upload
      var file = box.querySelector('#loaFile'), add = box.querySelector('#loaAdd'), buf = null;
      if (file) file.addEventListener('change', function () {
        var f = file.files && file.files[0]; buf = null; add.disabled = true;
        var read = box.querySelector('#loaRead'); read.textContent = '';
        if (!f) return;
        if (!/\.pdf$/i.test(f.name)) { read.innerHTML = '<span class="loa-bad">A PDF, please.</span>'; return; }
        f.arrayBuffer().then(function (b) { buf = b; add.disabled = false; return pdfText(b); }).then(function (t) {
          var got = findDates(t), months = monthsIn(t);
          if (months) box.querySelector('#loaMonths').value = months;
          if (got) { box.querySelector('#loaSigned').value = got.signed; read.innerHTML = 'Date signed read from ' + esc(got.how) + ': <b>' + esc(ukDate(got.signed)) + '</b>. Check it.'; }
          else read.textContent = 'No date could be read from this PDF (it may be a scan): type the date it was signed.';
        });
      });
      if (add) add.addEventListener('click', function () {
        var f = file.files && file.files[0], signed = box.querySelector('#loaSigned').value, months = Number(box.querySelector('#loaMonths').value) || 24;
        var out = box.querySelector('#loaAddMsg');
        if (!f || !buf) { out.innerHTML = '<span class="loa-bad">Choose the PDF first.</span>'; return; }
        if (!signed) { out.innerHTML = '<span class="loa-bad">Give the date it was signed.</span>'; return; }
        add.disabled = true; out.textContent = 'Adding...';
        sha256(buf).then(function (sha) {
          var path = id + '/loa/' + sha.slice(0, 16) + '_' + safeName(f.name);
          return q(sb.storage.from(BUCKET).upload(path, new Blob([buf], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false }), 'storing the file').catch(function (e) {
            if (!/exists|duplicate/i.test(errText(e))) throw e;
          }).then(function () {
            return q(sb.from('crm_documents').insert({ uc_customer_id: id, kind: 'loa', file_name: f.name, storage_path: path, sha256: sha, size_bytes: f.size,
              content_type: 'application/pdf', source: 'upload', uploaded_by_name: (o.who && o.who()) || 'CES', uc_tender_ids: [], mpans: [] }).select('id').single(), 'saving the file');
          }).then(function (r) {
            return q(sb.rpc('crm_loa_add', { p_customer: id, p_document: r.data.id, p_signed_on: signed, p_valid_months: months,
              p_signatory: box.querySelector('#loaWho').value || null, p_position: null, p_note: null }), 'adding the LOA');
          });
        }).then(function () { return again(); }).catch(function (e) { add.disabled = false; out.innerHTML = '<span class="loa-bad">' + esc(errText(e)) + '</span>'; });
      });
      return Promise.resolve();
    }
    function fld(k, label, v, dis, wide) {
      return '<label class="loa-f"' + (wide ? ' style="grid-column:span 2"' : '') + '>' + label + '<input type="text" data-k="' + k + '" value="' + esc(v || '') + '"' + dis + '></label>';
    }

    // ------------------------------------------------------------ the tracker page
    var LS = { state: '', q: '', am: '', page: 0 };
    var STATES = [['', 'Every company'], ['expired', 'Expired'], ['expiring', 'Expiring in 60 days'], ['none', 'No LOA on the desk'], ['valid', 'In date'], ['sent', 'Renewal sent']];
    function list(body, nav) {
      body.innerHTML = '<div class="card fillcard loa-root"><div class="fc-head"><div class="fc-title"><h2>LOA tracker</h2></div>' +
        '<div class="sub">Every company with live, upcoming or locked-in CES supply, and where its Letter of Authority stands. A renewal is drafted by itself 60 days before an LOA expires, ' +
        'and for any company with no LOA on the desk; nobody is sent anything until someone on the team sends it.</div>' +
        '<div class="loa-chips" id="loaChips"></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end"><label class="loa-f" style="min-width:240px">Company<input type="search" id="loaQ" value="' + esc(LS.q) + '" placeholder="Search by name"></label></div></div>' +
        '<div class="grid" id="loaList"><div class="note">Loading&hellip;</div></div><div class="fc-foot" id="loaFoot"></div></div>';
      var t; body.querySelector('#loaQ').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { LS.q = e.target.value.trim(); LS.page = 0; load(); }, 250); });
      function chips() {
        return Promise.all(STATES.map(function (s) { return q(sb.rpc('crm_loa_list', { p_state: s[0] || null, p_q: null, p_am: null, p_limit: 1, p_offset: 0 }), 'LOA counts').then(function (r) { return [s[0], (r.data && r.data[0] && Number(r.data[0].total)) || 0]; }); }))
          .then(function (n) {
            var box = body.querySelector('#loaChips'); if (!box) return;
            box.innerHTML = n.map(function (x, i) { return '<button data-s="' + x[0] + '"' + (x[0] === LS.state ? ' class="on"' : '') + '><b>' + x[1] + '</b>' + STATES[i][1] + '</button>'; }).join('');
            [].forEach.call(box.querySelectorAll('[data-s]'), function (b) { b.addEventListener('click', function () { LS.state = b.getAttribute('data-s'); LS.page = 0; chips(); load(); }); });
          });
      }
      function load() {
        var per = 100;
        return q(sb.rpc('crm_loa_list', { p_state: LS.state || null, p_q: LS.q || null, p_am: LS.am || null, p_limit: per, p_offset: LS.page * per }), 'LOA list').then(function (r) {
          var rows = r.data || [], total = rows.length ? Number(rows[0].total) : 0, box = body.querySelector('#loaList');
          if (!box) return;
          box.innerHTML = rows.length ? '<table class="loa-list"><thead><tr><th>Company</th><th>Account manager</th><th>LOA</th><th>Signed</th><th>Expires</th><th>Renewal</th><th class="num">Live contracts</th></tr></thead><tbody>' +
            rows.map(function (x) {
              var cur = x.state === 'none' ? null : { loa_id: 1, signed_on: x.signed_on, expires_on: x.expires_on };
              return '<tr data-c="' + esc(x.uc_customer_id) + '"><td><b>' + esc(x.name) + '</b></td><td>' + esc(x.account_manager || '') + '</td><td>' + pill(cur) + '</td><td>' + esc(ukDate(x.signed_on)) + '</td><td>' + esc(ukDate(x.expires_on)) + '</td><td>' +
                (x.renewal_status === 'sent' ? '<span class="loa-pill valid">Sent ' + esc(ukDate(x.envelope_sent_at)) + '</span>' : x.renewal_status === 'draft' ? '<span class="loa-pill expiring">Drafted, not sent</span>' : '<span class="crm-small">&ndash;</span>') +
                '</td><td class="num">' + (x.live_contracts || 0) + '</td></tr>';
            }).join('') + '</tbody></table>' : '<div class="note" style="margin:10px">No company here.</div>';
          [].forEach.call(box.querySelectorAll('tr[data-c]'), function (tr) { tr.addEventListener('click', function () { nav.open(tr.getAttribute('data-c')); }); });
          var foot = body.querySelector('#loaFoot');
          if (foot) foot.innerHTML = total > per ? '<span class="crm-small">' + (LS.page * per + 1) + ' to ' + Math.min(total, LS.page * per + per) + ' of ' + total + '</span> ' +
            '<button class="act ghost sm" data-p="-1"' + (LS.page ? '' : ' disabled') + '>Previous</button> <button class="act ghost sm" data-p="1"' + ((LS.page + 1) * per < total ? '' : ' disabled') + '>Next</button>' : '';
          if (foot) [].forEach.call(foot.querySelectorAll('[data-p]'), function (b) { b.addEventListener('click', function () { LS.page += Number(b.getAttribute('data-p')); load(); }); });
        });
      }
      return Promise.all([chips(), load()]);
    }

    return { VERSION: VERSION, summary: summary, paint: paint, pill: pill, list: list, stateOf: stateOf, wireOpen: wireOpen, renewalOf: renewalOf, docuSign: docuSign };
  }

  root.CrmLoa = { VERSION: VERSION, create: create, findDates: findDates, parseDate: parseDate, addMonths: addMonths, stateOf: stateOf, buildPdf: buildPdf, GEO: GEO, textSafe: textSafe };
})(typeof window !== 'undefined' ? window : globalThis);
