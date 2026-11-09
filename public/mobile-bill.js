/*
 * mobile-bill.js - reads CES's itemised Vodafone business bill (PDF) in the browser.
 * Build 09a, 9 Nov 2026 (Robert Stead: "drop it in around the 9th of each month, like Teramind").
 *
 * What it trusts, and why:
 *  - The bill's own "Total of N calls" lines. Every mobile's parsed calls must add up to them, or
 *    that mobile is refused: a miscount would go straight into a broker's month-end figures.
 *  - The weekday printed beside each date. Rows carry no year, so the year comes from the usage
 *    period ("9 October to 8 November 2026"); a weekday that does not match refuses the mobile.
 *  - Nothing else. Texts and data rows have no hh:mm:ss length, so they never match a call row;
 *    incoming calls (listed only when roaming) and short codes (121 voicemail) are never counted.
 *
 * The number dialled is not kept: only a sha-256 of it (to tell a repeated call from a new one
 * when two bills overlap) and its last three digits. Calls on a mobile that is not a broker's are
 * not sent to the database at all.
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-09.1';
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function clean(t) { return String(t || '').replace(/\\n/g, ' ').replace(/[   ]/g, ' ').replace(/\s+/g, ' '); }

  /** "9 October to 8 November 2026" -> { from: '2026-10-09', to: '2026-11-08' } (the first year is implied). */
  function usagePeriod(text) {
    var m = /Your usage period\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?\s+to\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i.exec(text);
    if (!m) return null;
    var m1 = MONTHS[m[2].slice(0, 3).toLowerCase()], m2 = MONTHS[m[5].slice(0, 3).toLowerCase()];
    if (m1 == null || m2 == null) return null;
    var y2 = Number(m[6]), y1 = m[3] ? Number(m[3]) : (m1 > m2 ? y2 - 1 : y2);
    return { from: iso(y1, m1, Number(m[1])), to: iso(y2, m2, Number(m[4])), toYear: y2, toMonth: m2 };
  }

  /** The number dialled, the same however the bill writes it (0044..., 44..., 07...). */
  function normaliseDialled(raw) {
    var s = String(raw || '').trim();
    if (/^incoming/i.test(s)) return 'incoming';
    var d = s.replace(/\D/g, '');
    if (d.indexOf('0044') === 0) d = '0' + d.slice(4);
    else if (d.indexOf('44') === 0 && d.length === 12) d = '0' + d.slice(2);
    return d;
  }

  var ROW = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-2]\d:[0-5]\d)\s+((?:(?!\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Z][a-z]{2}\s)[\s\S]){1,90}?)\s(\d{2}):([0-5]\d):([0-5]\d)\b/g;

  /**
   * The whole bill's text -> { period, lines: [{ line, calls: [...], expected, ok, problem }], problems }.
   * A call: { line, date, time, dialled, tail, dest, sec, incoming }.
   */
  function parseText(text) {
    var t = clean(text), out = { version: VERSION, period: usagePeriod(t), lines: [], problems: [] };
    if (!out.period) { out.problems.push('This does not look like a Vodafone bill: there is no "Your usage period" line.'); return out; }
    var heads = [], m, re = /Mobile\s+((?:\d\s?){11})\b/g;
    while ((m = re.exec(t))) {
      var num = m[1].replace(/\s/g, '');
      if (/^07\d{9}$/.test(num)) heads.push({ at: m.index, line: num });
    }
    if (!heads.length) { out.problems.push('No mobile numbers were found in the bill.'); return out; }
    function lineAt(pos) { var h = null; for (var i = 0; i < heads.length && heads[i].at <= pos; i++) h = heads[i]; return h ? h.line : null; }
    var by = {};
    heads.forEach(function (h) { if (!by[h.line]) { by[h.line] = { line: h.line, calls: [], expected: 0, bad: [] }; out.lines.push(by[h.line]); } });
    var tre = /Total of (\d+) calls?\b/g;
    while ((m = tre.exec(t))) { var L = lineAt(m.index); if (L) by[L].expected += Number(m[1]); }
    ROW.lastIndex = 0;
    while ((m = ROW.exec(t))) {
      var line = lineAt(m.index); if (!line) continue;
      var mon = MONTHS[m[3].toLowerCase()], day = Number(m[2]);
      var year = mon > out.period.toMonth ? out.period.toYear - 1 : out.period.toYear;
      var dt = new Date(Date.UTC(year, mon, day));
      var mid = m[5].trim(), incoming = /^incoming/i.test(mid);
      var num = incoming ? 'Incoming' : (/^\+?\d[\d ]*\d/.exec(mid) || [''])[0];
      var dest = (incoming ? 'Incoming (roaming)' : mid.slice(num.length)).replace(/\s+/g, ' ').trim();
      var words = dest.split(' '); if (words.length === 2 && words[0] === words[1]) dest = words[0];
      var call = { line: line, date: iso(year, mon, day), time: m[4], dialled: normaliseDialled(num), tail: '', dest: dest.slice(0, 60),
                   sec: Number(m[6]) * 3600 + Number(m[7]) * 60 + Number(m[8]), incoming: incoming,
                   // 121 voicemail, 191 Vodafone: a short code is the phone's own service, not a call to anyone
                   service: !incoming && num.replace(/\D/g, '').length < 6 };
      call.tail = call.dialled === 'incoming' ? '' : call.dialled.slice(-3);
      if (dt.getUTCDate() !== day || dt.getUTCDay() !== DAYS[m[1].toLowerCase()]) by[line].bad.push(m[1] + ' ' + day + ' ' + m[3]);
      if (!incoming && !call.dialled) by[line].bad.push('a call on ' + day + ' ' + m[3] + ' with no number');
      by[line].calls.push(call);
    }
    out.lines.forEach(function (x) {
      x.ok = !x.bad.length && x.calls.length === x.expected;
      x.problem = x.bad.length ? 'the date or number does not read cleanly (' + x.bad.slice(0, 3).join(', ') + ')'
        : x.calls.length !== x.expected ? 'read ' + x.calls.length + ' call' + (x.calls.length === 1 ? '' : 's') + ' but the bill says ' + x.expected : '';
      delete x.bad;
    });
    return out;
  }

  /** Calls per calendar month for one mobile, outgoing only: { '2026-10': n, ... }. */
  function byMonth(calls) {
    var o = {};
    (calls || []).forEach(function (c) { if (c.incoming || c.service) return; var k = c.date.slice(0, 7); o[k] = (o[k] || 0) + 1; });
    return o;
  }

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  function subtle() {
    var c = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : (root.crypto && root.crypto.subtle ? root.crypto : null);
    if (!c) throw new Error('This browser cannot hash (crypto.subtle is missing).');
    return c.subtle;
  }
  function sha256Text(s) { return subtle().digest('SHA-256', new TextEncoder().encode(String(s))).then(hex); }
  function sha256Bytes(buf) { return subtle().digest('SHA-256', buf).then(hex); }

  /**
   * The rows record_mobile_bill takes, for the mobiles in `keep` only: each call once, a call
   * the bill lists twice (same minute, number and length) numbered 1, 2...
   */
  function rowsForSave(parsed, keep) {
    var want = {}; (keep || []).forEach(function (l) { want[l] = 1; });
    var calls = [];
    parsed.lines.forEach(function (x) { if (want[x.line] && x.ok) calls = calls.concat(x.calls.filter(function (c) { return !c.service; })); });
    var seen = {};
    return Promise.all(calls.map(function (c) { return sha256Text(c.dialled); })).then(function (hs) {
      return calls.map(function (c, i) {
        var k = [c.line, c.date, c.time, hs[i], c.sec].join('|');
        seen[k] = (seen[k] || 0) + 1;
        return { line: c.line, date: c.date, time: c.time, occ: seen[k], hash: hs[i], tail: c.tail, dest: c.dest, sec: c.sec, incoming: !!c.incoming };
      });
    });
  }

  /** Every page's text, in reading order (pdf.js). */
  function textFromPdf(pdfjs, data) {
    return pdfjs.getDocument({ data: data }).promise.then(function (doc) {
      var pages = [];
      for (var i = 1; i <= doc.numPages; i++) pages.push(i);
      return Promise.all(pages.map(function (n) {
        return doc.getPage(n).then(function (p) { return p.getTextContent(); }).then(function (tc) {
          return tc.items.map(function (it) { return (it.str || '') + (it.hasEOL ? '\n' : ' '); }).join('');
        });
      })).then(function (all) { return all.join('\n'); });
    });
  }

  var api = { VERSION: VERSION, parseText: parseText, usagePeriod: usagePeriod, normaliseDialled: normaliseDialled, byMonth: byMonth,
              rowsForSave: rowsForSave, sha256Bytes: sha256Bytes, sha256Text: sha256Text, textFromPdf: textFromPdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MobileBill = api;
})(typeof window !== 'undefined' ? window : globalThis);
