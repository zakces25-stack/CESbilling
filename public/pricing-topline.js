/*
 * pricing-topline.js - check a meter's MPAN top line against a supplier portal (CES, 28 Nov 2026, build 28b).
 *
 * CES, 28 Nov 2026: "a lot of our toplines have the wrong middle 3/4 digits. Is there a way we could use
 * drax/totalenergies mpan search feature incorporated into our website to update the toplines when we
 * quote a meter". Then: "Lets try the drax/total setup first to just get the toplines".
 *
 * Later the same day CES decided that using their own TotalEnergies and British Gas portal logins
 * automatically is fine ("lets use the totalenergies website to find mpans"). So TotalEnergies is now
 * automatic: the te-lookup edge function signs in to the TotalEnergies sales tool with CES's login (held in
 * Supabase secrets, never in this website or in the browser) and runs the same MPAN search a person runs
 * by hand. Drax and every other source stay as they were: a person runs the search and pastes what it
 * shows here (or drops a multi-site export). Either way this file reads Profile Class, MTC, SSC and LLFC,
 * shows what differs from the stored top line, and pricing_topline_apply() corrects `meters` and keeps an
 * audit row in meter_topline_checks. Two ways in:
 *
 *   1. Price a meter > Check against portal (openPasteDialog): one meter, while quoting it. "Look up on
 *      TotalEnergies" fills the comparison in a few seconds; the paste box takes anything else.
 *   2. Reference > Top line check (mountPage): the suspect list. "TotalEnergies lookups (automatic)" puts
 *      every suspect through TotalEnergies in the background (a slow queue on weekdays) and brings the
 *      results back for review; a portal's multi-site export or a paste still works for the rest.
 *
 * THE MIDDLE OF A TOP LINE. A printed supply number ("S 03 801 621 / 14 1234 5678 901") carries the
 * three-digit meter timeswitch code (MTC) in the middle. The desk's own top line carries the four-digit
 * SSC there instead (meterTopLine in pricing.html), because that is what the suppliers price on. They
 * are different numbers. A three-digit middle is an MTC and is NEVER written into the SSC; an MTC on its
 * own leaves the SSC for a person to confirm (the database marks it for review when the MTC changed).
 *
 * LEADING ZEROS. Spreadsheet exports drop them: SSC 0393 arrives as 393, profile class 03 as 3, LLFC 021
 * as 21. A value in a column that SAYS what it is (an SSC column, a PC column) is padded back. A bare
 * three-digit middle with no label stays an MTC.
 *
 * Pure helpers are on ToplineDesk._test for the Node tests (repo/public/__tests__/pricing-topline.test.js).
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-28.2';
  var FN = 'topline-read';                 // the Claude fallback for a paste nothing here could read
  var TE_FN = 'te-lookup';                 // the automatic TotalEnergies MPAN search (SPEC-PORTALS.md B)
  var TE_FILE = 'TotalEnergies lookups';   // S.file on the Top line check page while reviewing them
  var TE_SKIP_DAYS = 30;                   // a meter looked up this recently is not queued again
  var APPLY_CHUNK = 200;                   // rows per pricing_topline_apply call
  var MPAN_PRIMES = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];
  var SOURCES = [['drax', 'Drax portal'], ['totalenergies', 'TotalEnergies portal'], ['portal', 'Another supplier portal'], ['bill', "Customer's bill"]];

  // ------------------------------------------------------------------ pure helpers

  function str(v) { return v == null ? '' : String(v); }

  /** The mod-11 check digit, exactly as crm_mpan_ok() does it in the database. */
  function mpanOk(core) {
    var s = str(core);
    if (!/^\d{13}$/.test(s)) return false;
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += Number(s[i]) * MPAN_PRIMES[i];
    return (sum % 11) % 10 === Number(s[12]);
  }

  // Separators a portal or a paste puts between the boxes of a supply number. Without a leading S the
  // number has to sit on one line: in a pasted list of "core, top line" rows, one row's top line followed
  // by the NEXT row's core would otherwise read as a supply number for the wrong meter. With the S (a
  // bill's two-row box copied as text) the top line and the core may sit on separate lines.
  var SEP_LINE = '[ \\t|/\\\\.,:;_-]*';
  var SEP_ANY = '[\\s|/\\\\.,:;_-]*';
  function snSource(sep, withS) {
    // S, then the top line (PC, MTC, LLFC), then the core (distributor 2, 4, 4, 3). An LLFC can carry a
    // letter (D01, 02D), so it is three alphanumerics; everything else is digits. Never part of a longer
    // run of digits: the end is a lookahead, the start is checked in supplyNumbers (no lookbehind, which
    // older Safari cannot compile).
    return (withS ? '\\bS' + sep : '') + '(\\d{2})' + sep + '(\\d{3})' + sep + '([0-9A-Za-z]{3})' + sep
         + '(\\d{2})' + sep + '(\\d{4})' + sep + '(\\d{4})' + sep + '(\\d{3})(?![0-9])';
  }
  var SN_WITH_S = snSource(SEP_ANY, true), SN_PLAIN = snSource(SEP_LINE, false);

  /**
   * Every supply number written out in a piece of text: [{mpan, pc, mtc, llfc, index, text}]. The core
   * must pass its check digit and the profile class must be 00 to 08, which keeps a phone number
   * followed by an MPAN from being read as one.
   */
  function supplyNumbers(text) {
    var out = [], s = str(text);
    [[SN_WITH_S, true], [SN_PLAIN, false]].forEach(function (pair) {
      var re = new RegExp(pair[0], 'gi'), m;
      while ((m = re.exec(s))) {
        var core = m[4] + m[5] + m[6] + m[7];
        var prev = m.index > 0 ? s[m.index - 1] : '';
        var bad = !mpanOk(core) || !/^0[0-8]$/.test(m[1]) || (!pair[1] && /[0-9A-Za-z]/.test(prev))
               || out.some(function (o) { return m.index >= o.index && m.index < o.index + o.text.length; });
        if (bad) { re.lastIndex = m.index + 1; continue; }
        out.push({ mpan: core, pc: m[1], mtc: m[2], llfc: m[3].toUpperCase(), index: m.index, text: m[0] });
      }
    });
    // A results list written core first, top line after it, on one line ("1412345678901 03 801 621").
    // A four-digit middle there is an SSC (the desk's own way of writing it), a three-digit one an MTC.
    var rev = new RegExp('(\\d{2})' + SEP_LINE + '(\\d{4})' + SEP_LINE + '(\\d{4})' + SEP_LINE + '(\\d{3})' + SEP_LINE
                       + '(\\d{2})' + SEP_LINE + '(\\d{3,4})' + SEP_LINE + '([0-9A-Za-z]{3})(?![0-9A-Za-z])', 'g'), r;
    while ((r = rev.exec(s))) {
      var core2 = r[1] + r[2] + r[3] + r[4];
      var prev2 = r.index > 0 ? s[r.index - 1] : '';
      var bad2 = !mpanOk(core2) || !/^0[0-8]$/.test(r[5]) || /[0-9A-Za-z]/.test(prev2)
              || out.some(function (o) { return r.index < o.index + o.text.length && o.index < r.index + r[0].length; });
      if (bad2) { rev.lastIndex = r.index + 1; continue; }
      var item = { mpan: core2, pc: r[5], llfc: r[7].toUpperCase(), index: r.index, text: r[0], reversed: true };
      if (r[6].length === 4) item.ssc = r[6]; else item.mtc = r[6];
      out.push(item);
    }
    return out.sort(function (a, b) { return a.index - b.index; });
  }

  /**
   * A 13-digit core from whatever a cell or a box holds: a core, a core with spaces, a 21-digit supply
   * number with or without its S. Null when it is neither. The check digit is NOT tested here (mpanOk
   * does that): a typed core with a wrong digit is still worth showing as "not a valid MPAN".
   */
  function normMpan(v) {
    if (v == null || v === '') return null;
    var s = typeof v === 'number' ? (isFinite(v) ? String(Math.round(v)) : '') : str(v).trim();
    var sn = supplyNumbers(s);
    if (sn.length) return sn[0].mpan;
    var d = s.replace(/[^0-9]/g, '');
    if (/[a-z]/i.test(s.replace(/^\s*s\b/i, '').replace(/\b(mpan|core|no|number)\b/gi, ''))) {
      // Letters inside it (other than a leading S or a label) and not a supply number: not an MPAN.
      if (d.length !== 13) return null;
    }
    if (d.length === 13) return d;
    if (d.length === 21) return d.slice(8);
    return null;
  }

  /** One part read from a box or a label, checked and padded, or null with the reason. */
  function partOf(kind, raw, opts) {
    var v = str(raw).trim().toUpperCase();
    if (!v) return { value: null };
    if (/^\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, '');           // 393.0 from a spreadsheet
    if (kind === 'pc') {
      if (!/^\d{1,2}$/.test(v) || Number(v) > 8) return { value: null, warn: 'profile class "' + raw + '" is not 00 to 08' };
      return { value: ('0' + Number(v)).slice(-2) };
    }
    if (kind === 'mtc') {
      if (!/^\d{1,3}$/.test(v)) return { value: null, warn: 'MTC "' + raw + '" is not three digits' };
      return { value: ('00' + v).slice(-3) };
    }
    if (kind === 'ssc') {
      // An SSC is four digits. A shorter value is only padded when the box or label said SSC, because a
      // spreadsheet drops the leading zero (0393 -> 393); an unlabelled three-digit middle is an MTC.
      if (/^\d{4}$/.test(v)) return { value: v };
      if (opts && opts.labelled && /^\d{1,3}$/.test(v)) return { value: ('000' + v).slice(-4) };
      return { value: null, warn: 'SSC "' + raw + '" is not four digits' };
    }
    if (kind === 'llfc') {
      if (/^\d{1,3}$/.test(v)) return { value: ('00' + v).slice(-3) };
      if (/^[0-9A-Z]{3}$/.test(v)) return { value: v };
      return { value: null, warn: 'LLFC "' + raw + '" is not three letters or digits' };
    }
    return { value: null };
  }

  /** A combined SSC/MTC box: four digits is an SSC, three or fewer is an MTC (never padded into an SSC). */
  function sscOrMtc(raw) {
    var v = str(raw).trim().replace(/\.0+$/, '');
    if (/^\d{4}$/.test(v)) return { ssc: v };
    if (/^\d{1,3}$/.test(v)) return { mtc: ('00' + v).slice(-3) };
    return {};
  }

  /**
   * A top line typed or exported on its own ("03 801 621", "03 0393 621", "030393621"). A four-digit
   * middle is an SSC (the desk's convention), a three-digit middle an MTC (the printed convention).
   */
  function readTopLine(raw) {
    var s = str(raw).trim().toUpperCase();
    var m = s.match(/^S?[\s|\/.,:;_-]*(\d{1,2})[\s|\/.,:;_-]+(\d{3,4})[\s|\/.,:;_-]+([0-9A-Z]{2,3})$/)
         || s.match(/^(\d{2})(\d{4})([0-9A-Z]{3})$/) || s.match(/^(\d{2})(\d{3})([0-9A-Z]{3})$/);
    if (!m) return null;
    var out = { pc: partOf('pc', m[1]).value, llfc: partOf('llfc', m[3]).value };
    if (m[2].length === 4) out.ssc = m[2]; else out.mtc = m[2];
    return out;
  }

  // Labelled values in free text. Each value may sit after a colon, a tab, a pipe or on the next line
  // (a portal's two-column layout copied as text), and a label may carry a bracket ("Line Loss Factor
  // (Class)", "Profile Class (PC)"). Order matters only for tie-breaks.
  var PAREN = '(?:\\s*\\([^)\\n]{0,24}\\))?';
  var VAL = PAREN + '[\\s:=|#-]*';
  function label(src, value) { return new RegExp('\\b(?:' + src + ')\\b' + VAL + value, 'gi'); }
  var LABELS = [
    { f: 'ssc_mtc', re: label('ssc\\s*\\/\\s*mtc|mtc\\s*\\/\\s*ssc', '(\\d{1,4})\\b') },
    { f: 'pc', re: label('profile\\s*class(?:\\s*(?:id|code))?|pc', '(\\d{1,2})\\b') },
    { f: 'mtc', re: label('meter\\s*time\\s*-?\\s*switch(?:\\s*(?:code|class))?|mtc(?:\\s*(?:id|code))?', '(\\d{1,3})\\b') },
    { f: 'ssc', re: label('standard\\s*settlement\\s*config(?:uration)?(?:\\s*(?:id|code))?|settlement\\s*config(?:uration)?(?:\\s*(?:id|code))?|ssc(?:\\s*(?:id|code))?', '(\\d{1,4})\\b') },
    { f: 'llfc', re: label('line\\s*loss(?:\\s*factor)?(?:\\s*(?:class|id|code))*|llfc(?:\\s*(?:id|code))?|llf(?:\\s*(?:class|id|code))?', '([0-9A-Za-z]{1,3})\\b') },
    { f: 'topline', re: label('top\\s*line(?:\\s*data)?|supplementary\\s*data', '(\\d{2})[\\s|\\/.-]*(\\d{3,4})[\\s|\\/.-]*([0-9A-Za-z]{3})\\b') },
  ];
  // The value may sit on the next line, but the number itself never runs over a line end.
  var MPAN_LABEL = /\b(?:mpan(?:\s*core)?|supply\s*number|meter\s*point\s*(?:administration\s*)?number|s\s*number)\b[\s:=|#-]*(S?[ \t\d\/|.-]{13,40})/gi;
  var BARE_CORE = /\b(\d{2})[\s-]?(\d{4})[\s-]?(\d{4})[\s-]?(\d{3})\b/g;

  function snippet(text, a, b) {
    var s = str(text).slice(Math.max(0, a), Math.min(str(text).length, b));
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  /** Add one part to a result row, keeping the first value and noting a different later one. */
  function put(row, field, value, how) {
    if (value == null) return;
    if (row[field] == null) { row[field] = value; return; }
    if (row[field] !== value) {
      row.warnings.push('two different ' + field.toUpperCase() + 's in what was read (' + row[field] + ' and ' + value
        + (how ? ', ' + how : '') + '); kept ' + row[field]);
    }
  }

  function newRow(mpan) {
    return { mpan: mpan || null, mpan_ok: mpan ? mpanOk(mpan) : false, pc: null, mtc: null, ssc: null, llfc: null, evidence: '', warnings: [] };
  }

  /** Split pasted text into a table when it is one (tabs from a copied grid, or CSV with a header). */
  function textTable(text) {
    var lines = str(text).split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return null;
    var tabbed = lines.filter(function (l) { return l.indexOf('\t') >= 0; }).length;
    if (tabbed >= 2) return lines.map(function (l) { return l.split('\t'); });
    var commas = lines.filter(function (l) { return (l.match(/,/g) || []).length >= 2; }).length;
    if (commas >= 2 && commas >= lines.length * 0.6) return csvRows(lines.join('\n'));
    return null;
  }

  /** A small CSV reader (quotes, doubled quotes, commas or semicolons). Used when SheetJS is not there. */
  function csvRows(text) {
    var s = str(text).replace(/^﻿/, ''), rows = [], row = [], cell = '', q = false, i, c;
    var delim = (s.split(/\r?\n/)[0].match(/;/g) || []).length > (s.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
    for (i = 0; i < s.length; i++) {
      c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Header names a portal export or a spreadsheet uses, after normHead().
  var HEAD = {
    mpan: /^(full |core )?(mpan|mpan core|mpan number|mpan no|mpan id|mpan ref|mpan\/mprn|mprn\/mpan|meter point( admin(istration)?)?( number| no| ref(erence)?)?|supply number|supply no|s number)$/,
    pc: /^(pc|pc id|profile|profile class|profile class id|profile class code|profile code)$/,
    mtc: /^(mtc|mtc id|mtc code|meter time ?switch( code| class)?|time ?switch code)$/,
    ssc: /^(ssc|ssc id|ssc code|standard settlement config(uration)?( id| code)?|settlement config(uration)?( id| code)?)$/,
    ssc_mtc: /^(ssc\/mtc|mtc\/ssc|ssc mtc|mtc ssc)$/,
    llfc: /^(llf|llfc|llf class|llf id|llf code|llfc id|llfc code|line loss( factor)?( class)?( id| code)?)$/,
    topline: /^(top ?line|mpan top ?line|supplementary data|top ?line data)$/,
  };
  function normHead(c) {
    return str(c).toLowerCase().replace(/[_\-]+/g, ' ').replace(/[^a-z0-9\/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  /** Which column holds what in a header row: {mpan: i, pc: i, ...}. */
  function headerMap(cells) {
    var map = {};
    (cells || []).forEach(function (c, i) {
      var h = normHead(c);
      if (!h) return;
      Object.keys(HEAD).forEach(function (k) { if (map[k] == null && HEAD[k].test(h)) map[k] = i; });
    });
    return map;
  }
  /** The header row of a sheet (within its first 15 rows), or -1. It needs an MPAN and at least one part. */
  function findHeader(rows) {
    for (var h = 0; h < Math.min(15, (rows || []).length); h++) {
      var map = headerMap(rows[h]);
      if (map.mpan != null && (map.pc != null || map.mtc != null || map.ssc != null || map.llfc != null
          || map.ssc_mtc != null || map.topline != null)) return { index: h, map: map };
    }
    return { index: -1, map: null };
  }

  /**
   * One result per MPAN from a sheet with a header row: [{mpan, mpan_ok, pc, mtc, ssc, llfc, evidence,
   * warnings}]. Rows without an MPAN are skipped (a portal's totals line, a blank).
   */
  function parseTable(rows2d) {
    var rows = (rows2d || []).map(function (r) {
      return (Array.isArray(r) ? r : [r]).map(function (c) { return c == null ? '' : (typeof c === 'number' ? c : str(c).trim()); });
    });
    var hd = findHeader(rows);
    if (hd.index < 0) return [];
    var map = hd.map, byMpan = {}, order = [];
    for (var r = hd.index + 1; r < rows.length; r++) {
      var cells = rows[r];
      if (!cells.some(function (c) { return str(c) !== ''; })) continue;
      var rawMpan = cells[map.mpan];
      var mpan = normMpan(rawMpan);
      if (!mpan) continue;
      var row = byMpan[mpan];
      if (!row) { row = byMpan[mpan] = newRow(mpan); order.push(mpan); }
      row.evidence = row.evidence || cells.map(str).filter(Boolean).join(' | ').slice(0, 200);
      // A supply number in the MPAN column carries its own top line: used where the sheet has no box.
      var sn = supplyNumbers(str(rawMpan))[0];
      ['pc', 'mtc', 'ssc', 'llfc'].forEach(function (k) {
        if (map[k] == null) return;
        var p = partOf(k, cells[map[k]], { labelled: true });
        if (p.warn) row.warnings.push(p.warn);
        put(row, k, p.value);
      });
      if (map.ssc_mtc != null) {
        var sm = sscOrMtc(cells[map.ssc_mtc]);
        put(row, 'ssc', sm.ssc); put(row, 'mtc', sm.mtc);
      }
      if (map.topline != null) {
        var tl = readTopLine(cells[map.topline]);
        if (tl) { put(row, 'pc', tl.pc); put(row, 'mtc', tl.mtc); put(row, 'ssc', tl.ssc); put(row, 'llfc', tl.llfc); }
      }
      if (sn) {
        put(row, 'pc', sn.pc, 'supply number'); put(row, 'mtc', sn.mtc, 'supply number');
        put(row, 'ssc', sn.ssc, 'supply number'); put(row, 'llfc', sn.llfc, 'supply number');
      }
    }
    return order.map(function (k) { return byMpan[k]; });
  }

  /**
   * Everything readable in a paste: [{mpan, mpan_ok, pc, mtc, ssc, llfc, evidence, warnings}].
   *
   * A copied grid (tabs) or a CSV goes through parseTable first. Then the free text is read for supply
   * numbers ("S 03 801 621 14 1234 5678 901"), labelled values ("Profile Class: 03", "SSC 0393", "LLF
   * 621", value on the next line or not) and MPANs. Labelled values belong to the MPAN they follow; with
   * a single MPAN in the paste they all belong to it; with none they belong to opts.mpan (the meter on
   * screen), so a paste of just the portal's meter details box still works.
   */
  function parseText(text, opts) {
    opts = opts || {};
    var s = str(text);
    var fallback = normMpan(opts.mpan);
    var results = {}, order = [];
    function rowFor(mpan) {
      var k = mpan || '';
      if (!results[k]) { results[k] = newRow(mpan); order.push(k); }
      return results[k];
    }
    function finish() {
      // A row with no MPAN that found nothing is noise; one with parts but no MPAN is kept for the
      // caller to say "this paste does not name the meter".
      return order.map(function (k) { return results[k]; }).filter(function (r) {
        return r.mpan || r.pc || r.mtc || r.ssc || r.llfc;
      }).map(function (r) { r.evidence = r.evidence.slice(0, 200); return r; });
    }
    // 1. A table in the paste. When it reads as one, that is the answer: running the free-text reader
    //    over a grid as well would join one row's top line to the next row's MPAN.
    var tbl = textTable(s);
    if (tbl) {
      parseTable(tbl).forEach(function (t) {
        var row = rowFor(t.mpan);
        ['pc', 'mtc', 'ssc', 'llfc'].forEach(function (k) { put(row, k, t[k]); });
        row.evidence = row.evidence || t.evidence;
        row.warnings = row.warnings.concat(t.warnings);
      });
      if (order.length) return finish();
    }
    // 2. Anchors: where each MPAN is mentioned.
    var anchors = [], m, re;
    supplyNumbers(s).forEach(function (sn) { anchors.push({ index: sn.index, end: sn.index + sn.text.length, mpan: sn.mpan, sn: sn }); });
    re = new RegExp(MPAN_LABEL.source, 'gi');
    while ((m = re.exec(s))) {
      var lm = normMpan(m[1]);
      if (lm && mpanOk(lm)) anchors.push({ index: m.index, end: m.index + m[0].length, mpan: lm });
    }
    re = new RegExp(BARE_CORE.source, 'g');
    while ((m = re.exec(s))) {
      var core = m[1] + m[2] + m[3] + m[4];
      if (!mpanOk(core)) continue;
      var inside = anchors.some(function (a) { return m.index >= a.index && m.index < a.end; });
      if (!inside) anchors.push({ index: m.index, end: m.index + m[0].length, mpan: core });
    }
    anchors.sort(function (a, b) { return a.index - b.index; });
    var distinct = [];
    anchors.forEach(function (a) { if (distinct.indexOf(a.mpan) < 0) distinct.push(a.mpan); });
    function ownerAt(idx) {
      if (!distinct.length) return fallback;
      if (distinct.length === 1) return distinct[0];
      var own = anchors[0].mpan;
      for (var i = 0; i < anchors.length; i++) { if (anchors[i].index <= idx) own = anchors[i].mpan; else break; }
      return own;
    }
    // 3. Supply numbers carry PC, MTC (or, written the desk's way, the SSC) and LLFC.
    anchors.forEach(function (a) {
      var row = rowFor(a.mpan);
      if (a.sn) {
        put(row, 'pc', a.sn.pc, 'supply number'); put(row, 'mtc', a.sn.mtc, 'supply number');
        put(row, 'ssc', a.sn.ssc, 'supply number'); put(row, 'llfc', a.sn.llfc, 'supply number');
        row.evidence = row.evidence || snippet(s, a.index, a.end);
      } else if (!row.evidence) {
        var eol = s.indexOf('\n', a.end);
        row.evidence = snippet(s, a.index, Math.min(eol < 0 ? s.length : eol, a.end + 40));
      }
    });
    // 4. Labelled values. A label inside a supply number's own text is part of that number, not a label.
    var seen = [];
    LABELS.forEach(function (L) {
      var r2 = new RegExp(L.re.source, 'gi'), x;
      while ((x = r2.exec(s))) {
        var idx = x.index;
        if (anchors.some(function (a) { return a.sn && idx >= a.index && idx < a.end; })) continue;
        var owner = ownerAt(idx);
        var row = rowFor(owner);
        var got = [];
        if (L.f === 'topline') {
          var tl = readTopLine(x[1] + ' ' + x[2] + ' ' + x[3]);
          if (tl) { put(row, 'pc', tl.pc); put(row, 'mtc', tl.mtc); put(row, 'ssc', tl.ssc); put(row, 'llfc', tl.llfc); got.push(1); }
        } else if (L.f === 'ssc_mtc') {
          var sm = sscOrMtc(x[1]); put(row, 'ssc', sm.ssc); put(row, 'mtc', sm.mtc); got.push(1);
        } else {
          var p = partOf(L.f, x[1], { labelled: true });
          if (p.warn) row.warnings.push(p.warn);
          if (p.value != null) { put(row, L.f, p.value); got.push(1); }
        }
        if (got.length) seen.push({ owner: owner, text: snippet(s, idx, idx + x[0].length) });
      }
    });
    seen.forEach(function (e) {
      var row = results[e.owner || ''];
      if (row && row.evidence.length < 160) row.evidence = (row.evidence ? row.evidence + ' | ' : '') + e.text;
    });
    return finish();
  }

  /** The desk's top line (PC SSC LLFC), or null while a part is missing. */
  function topLineOf(p) {
    p = p || {};
    return p.pc && p.ssc && p.llfc ? p.pc + ' ' + p.ssc + ' ' + p.llfc : null;
  }
  /** The top line as the portal prints it (PC MTC LLFC), or null. */
  function printedTopLineOf(p) {
    p = p || {};
    return p.pc && p.mtc && p.llfc ? p.pc + ' ' + p.mtc + ' ' + p.llfc : null;
  }

  /** The stored parts of a meter row, in the same shape as a read. */
  function storedParts(meter) {
    meter = meter || {};
    var pc = meter.profile_class == null || meter.profile_class === '' ? null : ('0' + Number(meter.profile_class)).slice(-2);
    return { pc: pc, mtc: meter.mtc || null, ssc: meter.ssc || null, llfc: meter.llfc ? str(meter.llfc).toUpperCase() : null };
  }

  /** Part by part: what is stored against what was read. status: same, differs, new, not read. */
  function compareParts(stored, found) {
    return ['pc', 'ssc', 'mtc', 'llfc'].map(function (k) {
      var a = stored ? stored[k] : null, b = found ? found[k] : null;
      return { part: k, stored: a, found: b,
               status: b == null ? 'not read' : a == null ? 'new' : a === b ? 'same' : 'differs' };
    });
  }

  /** What a read says, as plain words for the dialog. */
  function readWarnings(found) {
    var w = [];
    if (!found) return w;
    if (found.mtc && !found.ssc) {
      w.push('The portal gave the meter timeswitch code (MTC ' + found.mtc + '), not the SSC. The MTC is saved; if it is not the one on file the SSC is marked for review, because one MTC can mean more than one SSC.');
    }
    if (!found.pc && !found.ssc && !found.mtc && !found.llfc) w.push('Nothing in that paste looks like a top line.');
    return w;
  }

  /** The rows pricing_topline_apply takes. */
  function applyRow(r) { return { mpan: r.mpan, pc: r.pc || null, mtc: r.mtc || null, ssc: r.ssc || null, llfc: r.llfc || null }; }

  /** CSV, Excel-safe: quoted where needed, a formula-looking cell neutralised, UTF-8 BOM for Excel. */
  function toCsv(rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (c) {
        var v = str(c);
        if (/^[=+@]/.test(v) || /^-[^0-9]/.test(v)) v = "'" + v;
        return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  /** Corrections for UtilityClick, from applied results: one line per MPAN that changed. */
  function ucCorrections(results, info, source, when) {
    var head = ['MPAN', 'Customer', 'Site', 'Postcode', 'Profile class', 'MTC', 'SSC', 'LLFC',
                'Top line was (PC SSC LLFC)', 'Top line now (PC SSC LLFC)', 'Printed top line now (PC MTC LLFC)', 'Source', 'Checked on'];
    var out = [head];
    (results || []).forEach(function (r) {
      if (!r || r.outcome !== 'corrected') return;
      var b = r.before || {}, f = r.found || {};
      var now = { pc: f.pc || (b.pc != null ? ('0' + Number(b.pc)).slice(-2) : null), mtc: f.mtc || b.mtc || null,
                  ssc: f.ssc || b.ssc || null, llfc: f.llfc || b.llfc || null };
      var i = (info && info[r.mpan]) || {};
      out.push([r.mpan, i.customer_name || '', i.site_name || '', i.postcode || '', now.pc || '', now.mtc || '', now.ssc || '',
                now.llfc || '', b.top_line || '', topLineOf(now) || '', printedTopLineOf(now) || '', source || '', when || '']);
    });
    return out;
  }

  // ------------------------------------------------------------------ the browser side
  var STYLES = ''
    + '.tl-wrap{position:fixed;inset:0;z-index:60;background:rgba(10,18,36,.45);display:grid;place-items:center;padding:16px}'
    + '.tl-card{width:100%;max-width:760px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:14px;'
    + 'box-shadow:0 20px 50px rgba(0,0,0,.3);padding:22px}'
    + '.tl-card h2{font-size:17px;margin:0 0 6px}'
    + '.tl-card p{font-size:12.5px;color:var(--muted);line-height:1.55;margin:0 0 10px}'
    + '.tl-card textarea{min-height:150px;font-family:"JetBrains Mono",monospace;font-size:12px;line-height:1.45}'
    + '.tl-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}'
    + '.tl-row>div{flex:1;min-width:180px}'
    + '.tl-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center}'
    + '.tl-cmp{margin-top:12px}'
    + '.tl-cmp td,.tl-cmp th{font-size:12.5px}'
    + '.tl-drop{border:2px dashed var(--line-2);border-radius:12px;padding:18px;text-align:center;cursor:pointer;margin-top:10px}'
    + '.tl-drop.over{border-color:var(--cyan);background:var(--cyan-glow)}'
    + '.tl-small{font-size:11.5px;color:var(--muted)}'
    + '.tl-ev{font-size:11px;color:var(--muted);max-width:420px;overflow-wrap:anywhere}'
    + '.tl-sum{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;margin:8px 0}';

  function injectStyles(doc) {
    if (!doc || doc.getElementById('tlStyles')) return;
    var s = doc.createElement('style'); s.id = 'tlStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }
  function q(builder, what) {
    return Promise.resolve(builder).then(function (r) {
      if (r && r.error) throw new Error(what + ': ' + r.error.message);
      return r ? r.data : null;
    });
  }
  function sourceOptions(esc, sel) {
    return SOURCES.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === sel ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('');
  }
  function download(doc, name, text, type) {
    var blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = doc.createElement('a');
    a.href = url; a.download = name; doc.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  /** supabase-js puts a non-2xx answer in error.context, not error.message. */
  function invokeRead(sb, text) {
    return Promise.resolve(sb.functions.invoke(FN, { body: { text: text } })).then(function (r) {
      if (!r.error) return r.data;
      var res = r.error.context, status = (res && res.status) || 0;
      var p = res && typeof res.text === 'function' ? res.text().catch(function () { return ''; }) : Promise.resolve('');
      return p.then(function (raw) {
        var b = null; try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = null; }
        var msg = (b && (b.error || b.message)) || (status === 429 ? 'The daily limit for Claude reads is used up.'
          : status === 404 ? 'The topline-read function is not deployed yet.' : r.error.message || 'Claude could not read it.');
        throw new Error(msg);
      });
    });
  }
  /** A Claude read back into the same shape as parseText, every part checked again here. */
  function fromClaude(rows) {
    return (rows || []).map(function (x) {
      var mpan = normMpan(x && x.mpan), row = newRow(mpan);
      ['pc', 'mtc', 'llfc'].forEach(function (k) { var p = partOf(k, x && x[k], { labelled: true }); if (p.warn) row.warnings.push(p.warn); put(row, k, p.value); });
      var s = partOf('ssc', x && x.ssc, { labelled: false }); if (s.warn) row.warnings.push(s.warn); put(row, 'ssc', s.value);
      row.evidence = str(x && x.evidence).slice(0, 200);
      if (x && x.evidence_ok === false) row.warnings.push('Claude\'s quote for this was not found word for word in the paste: check it.');
      return row;
    }).filter(function (r) { return r.mpan || r.pc || r.mtc || r.ssc || r.llfc; });
  }

  /** A date and time as people at CES read it: "28 Nov, 14:32" (UK time). Empty when it is not a date. */
  function whenUk(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function fmtN(n) { var v = Number(n) || 0; try { return v.toLocaleString('en-GB'); } catch (_) { return String(v); } }

  /**
   * One TotalEnergies lookup (a te-lookup result, or a done row from topline_lookup_results) in the same
   * shape parseText returns, every part checked here again with the same rules as a paste. The separate
   * fields come first; the top line TotalEnergies printed (PC SSC LLFC, "04 0244 204" or "040244204") then
   * fills a blank (an MHHS-migrated meter has no MTC and can come back with a blank LLFC field) and flags
   * any part it disagrees with. Null for a lookup that found nothing.
   */
  function teRow(res) {
    if (!res || (res.status && res.status !== 'done')) return null;
    var mpan = normMpan(res.mpan), row = newRow(mpan);
    // TotalEnergies labels every field (Profile Class, Standard Settlement Configuration, ...), so an SSC
    // that lost its leading zero on the way is padded back like a labelled column.
    ['pc', 'mtc', 'ssc', 'llfc'].forEach(function (k) {
      var p = partOf(k, res[k], { labelled: true });
      if (p.warn) row.warnings.push(p.warn);
      put(row, k, p.value);
    });
    var tl = res.top_line ? readTopLine(res.top_line) : null;
    if (tl) {
      put(row, 'pc', tl.pc, 'top line'); put(row, 'ssc', tl.ssc, 'top line');
      put(row, 'mtc', tl.mtc, 'top line'); put(row, 'llfc', tl.llfc, 'top line');
    } else if (res.top_line) {
      row.warnings.push('TotalEnergies\' top line "' + res.top_line + '" did not read as PC SSC LLFC');
    }
    var bits = [];
    var line = topLineOf(row);
    if (line) bits.push('top line ' + line);
    else if (res.top_line) bits.push('top line ' + str(res.top_line));
    if (row.mtc) bits.push('MTC ' + row.mtc);
    if (res.measurement_class) bits.push('measurement class ' + str(res.measurement_class));
    if (res.mhhs) bits.push('MHHS ' + str(res.mhhs));
    row.evidence = ('TotalEnergies MPAN search' + (bits.length ? ': ' + bits.join(', ') : '')).slice(0, 200);
    (Array.isArray(res.warnings) ? res.warnings : []).forEach(function (w) { if (w) row.warnings.push(str(w)); });
    return row;
  }

  /** The JSON body of a non-2xx edge function answer (supabase-js puts the Response in error.context). */
  function errorBody(err) {
    var res = err && err.context, status = (res && res.status) || 0;
    var p = res && typeof res.text === 'function' ? Promise.resolve(res.text()).catch(function () { return ''; }) : Promise.resolve('');
    return p.then(function (raw) {
      var b = null; try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = null; }
      return { status: status, body: b || {} };
    });
  }

  /** What a failed te-lookup call means, in words for the person at the desk. */
  function teErrorText(status, body, fallback) {
    var b = body || {}, code = b.code || '', detail = b.error || b.message || '';
    if (status === 503 && code === 'not_configured') return 'The TotalEnergies login is not set up on the server yet. Search the TotalEnergies portal yourself and paste the result below.';
    if (status === 503 && code === 'disabled') return 'TotalEnergies lookups are switched off at the moment. Search the portal yourself and paste the result below.';
    if (status === 429) return detail || 'You have used today\'s TotalEnergies lookups. They free up over the next 24 hours; paste the portal result below meanwhile.';
    if (status === 502) {
      return (code === 'login_failed' ? 'TotalEnergies did not answer: it refused the server\'s sign-in. ' : 'TotalEnergies did not answer just now. ')
        + 'Try again in a minute, or search the portal yourself and paste the result below.' + (detail ? ' (' + detail + ')' : '');
    }
    if (status === 401) return detail || 'Sign in again, then look it up.';
    if (status === 403) return detail || 'TotalEnergies lookups are for CES staff.';
    if (status === 404) return 'The te-lookup function is not deployed yet. Search the TotalEnergies portal yourself and paste the result below.';
    return detail || fallback || 'The TotalEnergies lookup failed.';
  }

  /** te-lookup for some MPANs: resolves to the response body {ok, results}, or throws with a sentence. */
  function invokeTe(sb, mpans) {
    if (!sb || !sb.functions || typeof sb.functions.invoke !== 'function') {
      return Promise.reject(new Error('The TotalEnergies lookup is not available on this page.'));
    }
    return Promise.resolve(sb.functions.invoke(TE_FN, { body: { mpans: mpans } })).then(function (r) {
      if (!r || !r.error) {
        var d = r ? r.data : null;
        if (d && d.error && !d.results) throw new Error(teErrorText(0, d));
        return d || {};
      }
      return errorBody(r.error).then(function (x) { throw new Error(teErrorText(x.status, x.body, r.error.message)); });
    });
  }

  /** PostgREST's "no such function" (not installed yet), as opposed to a real error. */
  function missingFn(r) {
    var e = r && r.error;
    if (!e) return false;
    return e.code === 'PGRST202' || e.code === '42883' || r.status === 404
      || /could not find the function|function .* does not exist/i.test(e.message || '');
  }

  /**
   * Price a meter > Check against portal. One meter: look it up on TotalEnergies or paste, compare, save
   * (pricing team) or use on this quote only (a broker, a typed-in meter). deps: {sb, esc, who, isPricing,
   * canSave, onSaved}. onSaved({mode:'saved', result}) after pricing_topline_apply; onSaved({mode:'local',
   * found, topLine}) when it is for this quote only (the page passes topLine to its own setMeterTopLine).
   */
  function openPasteDialog(meter, deps) {
    var doc = (deps && deps.doc) || root.document;
    var esc = deps.esc, sb = deps.sb;
    injectStyles(doc);
    var pricing = typeof deps.isPricing === 'function' ? !!deps.isPricing() : !!deps.isPricing;
    var canSave = deps.canSave != null ? !!deps.canSave : pricing;
    var stored = storedParts(meter);
    var want0 = normMpan(meter && meter.mpan), wantOk = mpanOk(want0);
    // te: the TotalEnergies result behind the row on screen (null when the row came from a paste).
    var S = { text: '', rows: [], pick: null, source: 'drax', busy: false, err: '', claude: false, timer: null, te: null };

    var wrap = doc.createElement('div');
    wrap.className = 'tl-wrap';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'tlTitle');
    doc.body.appendChild(wrap);

    function close() { if (S.timer) clearTimeout(S.timer); doc.removeEventListener('keydown', onKey); wrap.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    doc.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });   // the backdrop, once

    function choose() {
      var want = normMpan(meter && meter.mpan);
      var mine = S.rows.filter(function (r) { return r.mpan === want; });
      var noMpan = S.rows.filter(function (r) { return !r.mpan; });
      S.pick = mine[0] || (noMpan.length ? Object.assign({}, noMpan[0], { mpan: want, mpan_ok: mpanOk(want) }) : null);
      S.other = !S.pick && S.rows.length ? S.rows.map(function (r) { return r.mpan; }).filter(Boolean) : [];
    }
    function reparse() {
      S.rows = parseText(S.text, { mpan: meter && meter.mpan });
      S.claude = false;
      S.te = null;                         // a paste replaces a TotalEnergies lookup on screen
      choose();
      paint();
    }
    /** TotalEnergies' own MPAN search, through te-lookup. */
    function lookUpTe() {
      if (S.busy || !wantOk) return;
      S.busy = true; S.err = ''; paint();
      invokeTe(sb, [want0]).then(function (d) {
        var list = (d && d.results) || [];
        var res = list.filter(function (x) { return normMpan(x && x.mpan) === want0; })[0];
        if (!res) {
          S.err = list.length ? 'TotalEnergies answered for MPAN ' + list.map(function (x) { return str(x && x.mpan); }).join(', ') + ', not ' + want0 + '.'
                              : 'TotalEnergies sent nothing back for MPAN ' + want0 + '.';
          return;
        }
        if (res.status !== 'done') {
          S.err = res.status === 'not_found' ? (res.message || 'TotalEnergies has no meter with MPAN ' + want0 + '.')
            : res.status === 'invalid' ? (res.message || 'TotalEnergies would not search MPAN ' + want0 + ': it does not look valid.')
            : 'The TotalEnergies lookup failed' + (res.message ? ': ' + res.message : '.');
          return;
        }
        var row = teRow(res);
        if (!row || !(row.pc || row.mtc || row.ssc || row.llfc)) {
          S.err = 'TotalEnergies found MPAN ' + want0 + ' but sent no top line back.';
          return;
        }
        S.rows = [row];
        S.source = 'totalenergies';
        S.te = res;
        S.claude = false;
        choose();
      }).catch(function (e) { S.err = e.message || String(e); })
        .then(function () { S.busy = false; paint(); });
    }
    /** TotalEnergies' address for the meter, the time it was looked up, and a postcode that disagrees. */
    function teInfo() {
      var t = S.te;
      if (!t) return '';
      var where = [str(t.address).trim(), str(t.postcode).trim()].filter(Boolean).join(', ');
      var h = '<div class="tl-small" style="margin-top:6px">'
        + (where ? 'TotalEnergies has this meter at <b>' + esc(where) + '</b>. ' : 'TotalEnergies gave no address for this meter. ')
        + (whenUk(t.looked_up_at) ? 'Looked up ' + esc(whenUk(t.looked_up_at)) + '.' : '')
        + '</div>';
      var pcOnFile = str(meter && meter.postcode).replace(/\s+/g, '').toUpperCase();
      var pcTe = str(t.postcode).replace(/\s+/g, '').toUpperCase();
      if (pcOnFile && pcTe && pcOnFile !== pcTe) {
        h += '<div class="note warn" style="margin-top:8px">TotalEnergies has postcode ' + esc(t.postcode) + ' for this MPAN; this meter is on file at '
          + esc(meter.postcode) + '. Check it is the same site before saving.</div>';
      }
      if (t.supported === false) {
        h += '<div class="tl-small" style="margin-top:4px">TotalEnergies would not quote this meter itself'
          + (t.unsupported_reason ? ' (' + esc(t.unsupported_reason) + ')' : '') + '. The top line is still good to check against.</div>';
      }
      return h;
    }
    function cmpTable() {
      if (!S.pick) return '';
      var rows = compareParts(stored, S.pick);
      var names = { pc: 'Profile class', ssc: 'SSC', mtc: 'MTC', llfc: 'LLFC' };
      var pill = function (st) {
        return st === 'same' ? '<span class="pill p-ok">same</span>' : st === 'differs' ? '<span class="pill p-fail">different</span>'
          : st === 'new' ? '<span class="pill p-warn">new</span>' : '<span class="pill p-mute">not read</span>';
      };
      return '<table class="tl-cmp"><thead><tr><th>Part</th><th>On file</th><th>Portal</th><th></th></tr></thead><tbody>'
        + rows.map(function (r) {
          return '<tr><td>' + esc(names[r.part]) + '</td><td class="mono">' + esc(r.stored || 'none') + '</td><td class="mono">'
            + esc(r.found || '') + '</td><td>' + pill(r.status) + '</td></tr>';
        }).join('') + '</tbody></table>'
        + (S.pick.evidence ? '<div class="tl-ev" style="margin-top:6px">Read from: &ldquo;' + esc(S.pick.evidence) + '&rdquo;</div>' : '');
    }
    function paint() {
      var p = S.pick, warns = p ? p.warnings.concat(readWarnings(p)) : [];
      var changed = p && compareParts(stored, p).some(function (r) { return r.status === 'differs' || r.status === 'new'; });
      var h = '<div class="tl-card">'
        + '<h2 id="tlTitle">Check the top line against a portal</h2>'
        + '<p>Look MPAN <b class="mono">' + esc(meter && meter.mpan) + '</b> up on TotalEnergies with the button, or search it in the Drax '
        + 'or TotalEnergies broker portal yourself, copy what it shows (selecting the whole result and copying is fine) and paste it below. '
        + 'Nothing is saved until you press ' + (canSave ? 'Save' : 'Use') + '.</p>'
        + '<div class="tl-btns" style="margin:0 0 12px"><button class="act' + (S.te ? ' ghost' : '') + '" data-tl="te"'
        + (S.busy || !wantOk ? ' disabled' : '') + '>' + (S.te ? 'Look up on TotalEnergies again' : 'Look up on TotalEnergies') + '</button>'
        + '<span class="tl-small">' + (wantOk ? 'TotalEnergies\' own MPAN search, done for you in a few seconds.'
            : 'This MPAN fails its check digit, so there is nothing to look up.') + '</span></div>'
        + '<div class="tl-row"><div><label for="tlSource">Where it came from</label><select id="tlSource">' + sourceOptions(esc, S.source) + '</select></div>'
        + '<div><label>On file now</label><div class="mono" style="font-size:13px;padding:8px 0">'
        + esc([stored.pc || '··', stored.ssc || '····', stored.llfc || '···'].join(' ')) + (stored.mtc ? ' <span class="tl-small">MTC ' + esc(stored.mtc) + '</span>' : '')
        + '</div></div></div>'
        + '<label for="tlPaste" style="margin-top:10px">Paste the portal result</label>'
        + '<textarea id="tlPaste" spellcheck="false" placeholder="e.g. S 03 801 621 14 1234 5678 901, or the meter details: Profile Class 03, SSC 0393, LLF 621">'
        + esc(S.text) + '</textarea>';
      if (S.err) h += '<div class="note bad" style="margin-top:10px">' + esc(S.err) + '</div>';
      if (S.text.trim() && !p) {
        h += '<div class="note warn" style="margin-top:10px">'
          + (S.other && S.other.length ? 'That paste is for ' + esc(S.other.join(', ')) + ', not MPAN ' + esc(meter && meter.mpan) + '.'
             : 'Nothing in that paste reads as a top line.')
          + (pricing ? ' <button class="act ghost sm" data-tl="claude"' + (S.busy ? ' disabled' : '') + '>Read it with Claude</button>' : '')
          + '</div>';
      }
      if (p) {
        if (p.mpan && !mpanOk(p.mpan)) warns.unshift('MPAN ' + p.mpan + ' fails its check digit.');
        h += cmpTable();
        h += teInfo();
        if (S.claude) h += '<div class="tl-small" style="margin-top:4px">Read by Claude. Check it against the portal before saving.</div>';
        if (warns.length) h += '<div class="note warn" style="margin-top:10px">' + warns.map(esc).join('<br>') + '</div>';
      }
      h += '<div class="tl-btns">'
        + (canSave
          ? '<button class="act" data-tl="save"' + (p && !S.busy ? '' : ' disabled') + '>' + (changed ? 'Save to the meter' : 'Mark as checked') + '</button>'
          : '<button class="act" data-tl="local"' + (p && !S.busy ? '' : ' disabled') + '>Use on this quote</button>')
        + '<button class="act ghost" data-tl="close">Cancel</button>'
        + (!canSave ? '<span class="tl-small">' + (pricing ? 'A typed-in meter is not saved anywhere: this is for this quote only.'
            : 'Saving to the meter is the pricing team\'s: this is for this quote only.') + '</span>' : '')
        + (S.busy ? '<span class="tl-small">Working&hellip;</span>' : '')
        + '</div></div>';
      var pos = null, ta = doc.getElementById('tlPaste');
      if (ta && doc.activeElement === ta) pos = ta.selectionStart;
      wrap.innerHTML = h;
      var t2 = doc.getElementById('tlPaste');
      if (pos != null && t2) { t2.focus(); try { t2.setSelectionRange(pos, pos); } catch (_) { /* old browser */ } }
      wire();
    }
    function wire() {
      var ta = doc.getElementById('tlPaste');
      if (ta) ta.addEventListener('input', function () {
        S.text = ta.value; S.err = '';
        if (S.timer) clearTimeout(S.timer);
        S.timer = setTimeout(reparse, 250);
      });
      var src = doc.getElementById('tlSource');
      if (src) src.addEventListener('change', function () { S.source = src.value; });
      wrap.querySelectorAll('[data-tl]').forEach(function (b) {
        b.addEventListener('click', function () {
          var a = b.getAttribute('data-tl');
          if (a === 'close') return close();
          if (a === 'te') return lookUpTe();
          if (a === 'claude') return readWithClaude();
          if (a === 'save') return save();
          if (a === 'local') return useLocal();
        });
      });
    }
    function readWithClaude() {
      S.busy = true; S.err = ''; paint();
      invokeRead(sb, S.text.slice(0, 30000)).then(function (d) {
        S.rows = fromClaude(d && d.rows);
        choose();
        S.claude = !!S.pick;
        if (!S.pick) S.err = 'Claude could not find a top line for this MPAN in that paste either.';
      }).catch(function (e) { S.err = e.message || String(e); })
        .then(function () { S.busy = false; paint(); });
    }
    function save() {
      if (!S.pick) return;
      S.busy = true; S.err = ''; paint();
      var row = applyRow(Object.assign({}, S.pick, { mpan: normMpan(meter.mpan) }));
      var note = S.te ? 'TotalEnergies lookup' : S.claude ? 'pasted, read by Claude' : 'pasted';
      q(sb.rpc('pricing_topline_apply', { p_rows: [row], p_source: S.source, p_note: note, p_dry_run: false }), 'save the top line')
        .then(function (res) {
          var r = Array.isArray(res) ? res[0] : res;
          if (r && (r.outcome === 'invalid' || r.outcome === 'no_meter')) {
            throw new Error(r.outcome === 'invalid' ? 'The database refused it as not a valid MPAN.' : 'No electricity meter on file has that MPAN.');
          }
          close();
          if (deps.onSaved) deps.onSaved({ mode: 'saved', result: r, found: S.pick, source: S.source, te: S.te });
        })
        .catch(function (e) { S.busy = false; S.err = e.message || String(e); paint(); });
    }
    function useLocal() {
      if (!S.pick) return;
      var p = S.pick;
      var tl = [p.pc || stored.pc || '··', p.ssc || stored.ssc || '····', p.llfc || stored.llfc || '···'].join(' ');
      close();
      if (deps.onSaved) deps.onSaved({ mode: 'local', found: p, topLine: tl, source: S.source, te: S.te });
    }
    paint();
    var ta0 = doc.getElementById('tlPaste'); if (ta0) ta0.focus();
    return { close: close, state: S, lookUp: lookUpTe };
  }

  /**
   * Reference > Top line check: the suspect list (export it, push it through the portal's multi-site
   * tool) and the portal's results brought back (dry run, diff, apply the ticked ones).
   * deps: {sb, esc, XLSX, who, uk}.
   */
  function mountPage(host, deps) {
    var doc = host.ownerDocument || root.document, esc = deps.esc, sb = deps.sb;
    injectStyles(doc);
    var S = { suspects: null, sErr: '', sBusy: false, reason: '', source: 'drax', file: '', read: [], dry: null, tick: {},
              busy: false, err: '', msg: '', applied: null, info: {},
              // The TotalEnergies queue (topline_lookup_* RPCs): sum is topline_lookup_summary(), null for
              // anyone outside the pricing team; missing when the RPCs are not installed yet.
              te: { sum: null, loaded: false, busy: false, err: '', msg: '', missing: false } };

    /** An RPC that may not be installed yet: {data, missing} or a thrown sentence. */
    function rpcSoft(name, args, what) {
      return Promise.resolve(sb.rpc(name, args)).then(function (r) {
        if (missingFn(r)) return { data: null, missing: true };
        if (r && r.error) throw new Error(what + ': ' + r.error.message);
        return { data: r ? r.data : null, missing: false };
      });
    }
    function teLoad() {
      S.te.busy = true; paint();
      return rpcSoft('topline_lookup_summary', {}, 'the TotalEnergies queue').then(function (x) {
        S.te.missing = x.missing; S.te.sum = x.missing ? null : (x.data || null); S.te.err = '';
      }).catch(function (e) { S.te.err = e.message; })
        .then(function () { S.te.loaded = true; S.te.busy = false; paint(); });
    }
    function teQueue() {
      var n = (S.suspects || []).length;
      if (!n || S.te.busy) return;
      var per = Math.max(1, Number(S.te.sum && S.te.sum.per_run) || 25) * 6;
      if (!root.confirm('Look ' + fmtN(n) + ' meter' + (n === 1 ? '' : 's') + ' up on TotalEnergies?\n\n'
          + 'They go through in the background, about ' + fmtN(per) + ' an hour on weekdays (07:00 to 18:00 UK). '
          + 'Meters looked up in the last ' + TE_SKIP_DAYS + ' days are skipped. Nothing changes on a meter until the results are applied.')) return;
      S.te.busy = true; S.te.err = ''; S.te.msg = ''; paint();
      return rpcSoft('topline_lookup_enqueue_suspects', { p_limit: 5000, p_skip_days: TE_SKIP_DAYS }, 'queue the lookups').then(function (x) {
        if (x.missing) { S.te.missing = true; return; }
        var d = x.data || {};
        S.te.msg = 'Queued ' + fmtN(d.queued) + ' for TotalEnergies.'
          + (d.skipped_recent ? ' Skipped ' + fmtN(d.skipped_recent) + ' looked up in the last ' + TE_SKIP_DAYS + ' days.' : '')
          + (d.already_queued ? ' ' + fmtN(d.already_queued) + ' were already in the queue.' : '');
      }).catch(function (e) { S.te.err = e.message; })
        .then(function () { S.te.busy = false; return teLoad(); });
    }
    function teStop() {
      if (S.te.busy) return;
      if (!root.confirm('Stop the TotalEnergies queue?\n\nMeters waiting in the queue are taken out. Results already back stay for review.')) return;
      S.te.busy = true; S.te.err = ''; S.te.msg = ''; paint();
      return rpcSoft('topline_lookup_cancel_bulk', {}, 'stop the queue').then(function (x) {
        if (x.missing) { S.te.missing = true; return; }
        S.te.msg = 'Stopped: ' + fmtN(x.data) + ' taken out of the queue.';
      }).catch(function (e) { S.te.err = e.message; })
        .then(function () { S.te.busy = false; return teLoad(); });
    }
    /** The results waiting for review go through the same dry run, tick and apply as a portal export. */
    function teReview() {
      if (S.te.busy || S.busy) return;
      S.te.busy = true; S.te.err = ''; S.te.msg = ''; S.err = ''; S.msg = ''; paint();
      return rpcSoft('topline_lookup_results', { p_unapplied_only: true, p_limit: 2000 }, 'the TotalEnergies results').then(function (x) {
        if (x.missing) { S.te.missing = true; return; }
        var rows = merge((x.data || []).map(function (r) { return teRow(r); }).filter(Boolean));
        if (!rows.length) { S.te.msg = 'No TotalEnergies results are waiting for review.'; return; }
        S.read = rows; S.file = TE_FILE; S.source = 'totalenergies'; S.dry = null; S.applied = null;
        S.te.busy = false;
        return dryRun();
      }).catch(function (e) { S.te.err = e.message; })
        .then(function () { S.te.busy = false; paint(); });
    }
    /** After an apply from the review: the lookups behind it are done with, so they leave the review list. */
    function teMarkApplied(res) {
      var mpans = (res || []).filter(function (r) { return r && ['corrected', 'partial', 'match'].indexOf(r.outcome) >= 0; })
        .map(function (r) { return r.mpan; });
      if (!mpans.length) return Promise.resolve();
      return rpcSoft('topline_lookup_mark_applied', { p_mpans: mpans, p_note: 'applied on the Top line check page' }, 'mark the lookups applied')
        .then(function (x) { if (x.missing) S.te.missing = true; })
        .catch(function (e) { S.te.err = 'Applied, but the TotalEnergies lookups could not be marked as done: ' + e.message; })
        .then(teLoad);
    }

    function suspectsLoad() {
      S.sBusy = true; S.sErr = ''; paint();
      return q(sb.rpc('pricing_topline_suspects', { p_limit: 5000 }), 'suspect top lines').then(function (rows) {
        S.suspects = rows || [];
        // Kept across re-reads: a meter that has just been corrected leaves the list, and the
        // UtilityClick export still needs its customer and site.
        S.suspects.forEach(function (r) { S.info[r.mpan] = r; });
      }).catch(function (e) { S.sErr = e.message; S.suspects = S.suspects || []; })
        .then(function () { S.sBusy = false; paint(); });
    }
    function reasons() {
      var c = {};
      (S.suspects || []).forEach(function (r) { var k = r.reason || 'other'; c[k] = (c[k] || 0) + 1; });
      return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).map(function (k) { return [k, c[k]]; });
    }
    function shown() {
      return (S.suspects || []).filter(function (r) { return !S.reason || (r.reason || 'other') === S.reason; });
    }
    function exportSuspects() {
      var rows = [['MPAN', 'Postcode', 'Site', 'Customer', 'Supplier', 'Contract end', 'Top line on file (PC SSC LLFC)', 'MTC on file', 'Why it is on this list']];
      shown().forEach(function (r) {
        var st = storedParts(r);
        rows.push([r.mpan, r.postcode || '', r.site_name || '', r.customer_name || '', r.supplier || '', r.contract_end_date || '',
                   [st.pc || '..', st.ssc || '....', st.llfc || '...'].join(' '), r.mtc || '', r.reason || '']);
      });
      download(doc, 'top-lines-to-check-' + todayIso() + '.csv', toCsv(rows));
    }
    function copyMpans() {
      var list = shown().map(function (r) { return r.mpan; }).join('\n');
      var done = function () { S.msg = shown().length + ' MPANs copied, one per line.'; paint(); };
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(list).then(done, function () { S.err = 'The browser would not copy. Use Export CSV instead.'; paint(); });
      } else { S.err = 'The browser would not copy. Use Export CSV instead.'; paint(); }
    }

    function readRows2d(rows2d) {
      var t = parseTable(rows2d);
      if (t.length) return t;
      return parseText(rows2d.map(function (r) { return (r || []).join('\t'); }).join('\n'));
    }
    function readFile(file) {
      S.err = ''; S.msg = ''; S.file = file.name; S.dry = null; S.applied = null;
      var isCsv = /\.(csv|txt)$/i.test(file.name);
      return file.arrayBuffer().then(function (buf) {
        var out = [];
        if (isCsv || !deps.XLSX) {
          var text = new TextDecoder('utf-8').decode(buf);
          out = isCsv ? readRows2d(csvRows(text)) : parseText(text);
        } else {
          // raw:true: an MPAN typed as a number comes back as the number, not as Excel's "1.41235E+12"
          // display text. Text cells (a top line typed with spaces) stay text, and the padding in partOf
          // puts back the leading zero a number cell dropped (SSC 393 -> 0393, PC 3 -> 03).
          var wb = deps.XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
          wb.SheetNames.forEach(function (n) {
            var rows = deps.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, raw: true, defval: '' });
            out = out.concat(readRows2d(rows));
          });
        }
        S.read = merge(out);
        if (!S.read.length) S.err = 'Nothing in ' + file.name + ' reads as an MPAN with a top line. It needs an MPAN column and at least one of profile class, MTC, SSC or LLFC.';
        paint();
        if (S.read.length) return dryRun();
      }).catch(function (e) { S.err = 'Could not read ' + file.name + ': ' + (e.message || e); paint(); });
    }
    function readPaste(text) {
      S.err = ''; S.msg = ''; S.file = 'pasted'; S.dry = null; S.applied = null;
      S.read = merge(parseText(text));
      if (!S.read.length) { S.err = 'Nothing in that paste reads as an MPAN with a top line.'; paint(); return; }
      paint();
      return dryRun();
    }
    /** One row per MPAN; rows without an MPAN cannot be matched to a meter here. */
    function merge(rows) {
      var by = {}, order = [];
      rows.forEach(function (r) {
        if (!r.mpan) return;
        if (!by[r.mpan]) { by[r.mpan] = newRow(r.mpan); order.push(r.mpan); }
        var t = by[r.mpan];
        ['pc', 'mtc', 'ssc', 'llfc'].forEach(function (k) { put(t, k, r[k]); });
        t.evidence = t.evidence || r.evidence;
        t.warnings = t.warnings.concat(r.warnings || []);
      });
      return order.map(function (k) { return by[k]; });
    }
    function inChunks(rows, dry) {
      var out = [], i = 0;
      function next() {
        if (i >= rows.length) return Promise.resolve(out);
        var part = rows.slice(i, i + APPLY_CHUNK); i += APPLY_CHUNK;
        return q(sb.rpc('pricing_topline_apply', { p_rows: part.map(applyRow), p_source: S.source, p_note: S.file || null, p_dry_run: dry }),
                 dry ? 'check the top lines' : 'apply the top lines')
          .then(function (res) { out = out.concat(res || []); S.msg = (dry ? 'Checked ' : 'Applied ') + Math.min(i, rows.length) + ' of ' + rows.length + '...'; paint(); return next(); });
      }
      return next();
    }
    function dryRun() {
      S.busy = true; paint();
      return inChunks(S.read, true).then(function (res) {
        S.dry = res; S.tick = {};
        res.forEach(function (r) { if (r && ['corrected', 'partial', 'match'].indexOf(r.outcome) >= 0) S.tick[r.mpan] = true; });
        S.msg = '';
      }).catch(function (e) { S.err = e.message; }).then(function () { S.busy = false; paint(); });
    }
    function applyTicked() {
      var rows = S.read.filter(function (r) { return S.tick[r.mpan]; });
      if (!rows.length) return;
      if (!root.confirm('Apply ' + rows.length + ' top line' + (rows.length === 1 ? '' : 's') + ' to the meters on file?\n\n'
          + 'Every meter with that MPAN is updated and a check is recorded against it.')) return;
      S.busy = true; S.err = ''; paint();
      return inChunks(rows, false).then(function (res) {
        S.applied = res; S.msg = '';
        return Promise.all([suspectsLoad(), S.file === TE_FILE ? teMarkApplied(res) : null]);
      }).catch(function (e) { S.err = e.message; }).then(function () { S.busy = false; paint(); });
    }
    function exportUc() {
      var rows = ucCorrections(S.applied, S.info, (SOURCES.find(function (s) { return s[0] === S.source; }) || [])[1], todayIso());
      download(doc, 'top-line-corrections-for-utilityclick-' + todayIso() + '.csv', toCsv(rows));
    }

    var OUT = { corrected: ['p-warn', 'will correct'], partial: ['p-warn', 'part read'], match: ['p-ok', 'matches'],
                no_meter: ['p-mute', 'not on file'], invalid: ['p-fail', 'not valid'] };

    /** The TotalEnergies queue: what it is doing, and the buttons that drive it. */
    function teSection() {
      var T = S.te, h = '<h3 style="font-size:13px;margin:18px 0 6px">TotalEnergies lookups (automatic)</h3>';
      if (T.missing) return h + '<div class="note">The TotalEnergies lookup is not installed yet. Until it is, use the portal export or a paste below.</div>';
      if (T.err) h += '<div class="note bad" style="margin:0 0 10px">' + esc(T.err) + '</div>';
      if (T.msg) h += '<div class="note good" style="margin:0 0 10px">' + esc(T.msg) + '</div>';
      if (!T.loaded) return h + '<div class="note">Reading the TotalEnergies queue&hellip;</div>';
      var s = T.sum;
      if (!s) {
        return h + (T.err ? '' : '<div class="note">TotalEnergies lookups are run by the pricing team.</div>')
          + '<div class="tl-btns"><button class="act ghost" data-te="refresh"' + (T.busy ? ' disabled' : '') + '>Refresh</button></div>';
      }
      var per = Math.max(1, Number(s.per_run) || 25) * 6;
      var queued = Number(s.queued) || 0, running = Number(s.running) || 0, waiting = Number(s.done_unapplied) || 0;
      var n = (S.suspects || []).length;
      h += '<div class="sub keep" style="margin-bottom:8px">The server signs in to TotalEnergies with CES\'s own login and runs the same MPAN search '
        + 'you would, about ' + fmtN(per) + ' an hour on weekdays (07:00 to 18:00 UK). '
        + (s.auto_apply ? 'Clean results go straight onto the meters (automatic apply is on); every change is recorded.'
                        : 'Results wait here for you to review and apply (automatic apply is off).') + '</div>';
      if (s.enabled === false) h += '<div class="note warn" style="margin:0 0 10px">TotalEnergies lookups are switched off at the moment (te_lookup_enabled).</div>';
      if (s.last_login_error) {
        h += '<div class="note bad" style="margin:0 0 10px">The last TotalEnergies sign-in failed: ' + esc(s.last_login_error)
          + '. The queue waits until the login works.</div>';
      }
      var pill = function (cls, label, v) { return '<span><span class="pill ' + cls + '">' + esc(label) + '</span> ' + fmtN(v) + '</span>'; };
      h += '<div class="tl-sum">'
        + pill('p-mute', 'queued', queued)
        + (running ? pill('p-mute', 'looking up now', running) : '')
        + pill(waiting ? 'p-warn' : 'p-mute', 'waiting for review', waiting)
        + (waiting ? '<span>(' + fmtN(s.differs_unapplied) + ' differ from what is on file)</span>' : '')
        + pill('p-ok', 'applied', s.applied)
        + pill('p-mute', 'not found', s.not_found)
        + pill(Number(s.failed) ? 'p-fail' : 'p-mute', 'failed', s.failed)
        + '</div>';
      var bits = [];
      if (s.last_finished_at) bits.push('Last lookup ' + whenUk(s.last_finished_at) + '.');
      if (queued) bits.push('About ' + fmtN(Math.ceil(queued / per)) + ' working hour' + (Math.ceil(queued / per) === 1 ? '' : 's') + ' to go.');
      if (s.last_error) bits.push('Last problem: ' + s.last_error + '.');
      if (bits.length) h += '<div class="tl-small">' + esc(bits.join(' ')) + '</div>';
      var off = T.busy || S.busy;
      h += '<div class="tl-btns">'
        + '<button class="act" data-te="queue"' + (n && !off && s.enabled !== false ? '' : ' disabled') + '>Look all ' + fmtN(n) + ' up on TotalEnergies</button>'
        + (queued ? '<button class="act ghost" data-te="stop"' + (off ? ' disabled' : '') + '>Stop the queue</button>' : '')
        + '<button class="act ghost" data-te="review"' + (waiting && !off ? '' : ' disabled') + '>Review ' + fmtN(waiting) + ' result' + (waiting === 1 ? '' : 's') + '</button>'
        + '<button class="act ghost" data-te="refresh"' + (T.busy ? ' disabled' : '') + '>Refresh</button>'
        + '</div>';
      return h;
    }

    function paint() {
      var h = '<div class="card" style="max-width:1200px">'
        + '<h2>Top line check</h2>'
        + '<div class="sub keep">Meters whose top line the desk cannot trust yet. Let TotalEnergies look them up automatically, or export the '
        + 'list, run it through the Drax or TotalEnergies multi-site search (or look them up one by one), then bring the results back here: a CSV '
        + 'or Excel export, or a paste. Nothing changes until you tick and apply. Every check is recorded, and the corrections can be exported for UtilityClick.</div>';
      if (S.err) h += '<div class="note bad" style="margin:0 0 12px">' + esc(S.err) + '</div>';
      if (S.msg) h += '<div class="note" style="margin:0 0 12px">' + esc(S.msg) + '</div>';
      // 1. The suspects.
      h += '<h3 style="font-size:13px;margin:14px 0 6px">1. Top lines to check</h3>';
      if (S.sErr) h += '<div class="note bad" style="margin:0 0 10px">' + esc(S.sErr) + '</div>';
      if (S.suspects == null || S.sBusy) h += '<div class="note">Reading the meters&hellip;</div>';
      else {
        var rs = reasons();
        h += '<div class="tl-row" style="margin-bottom:8px"><div style="flex:0 0 auto;min-width:240px"><label for="tlReason">Show</label>'
          + '<select id="tlReason"><option value="">All ' + S.suspects.length + '</option>'
          + rs.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === S.reason ? ' selected' : '') + '>' + esc(x[0]) + ' (' + x[1] + ')</option>'; }).join('')
          + '</select></div><div style="flex:0 0 auto;min-width:0;display:flex;gap:8px">'
          + '<button class="act" data-tp="export"' + (shown().length ? '' : ' disabled') + '>Export CSV</button>'
          + '<button class="act ghost" data-tp="copy"' + (shown().length ? '' : ' disabled') + '>Copy the MPANs</button>'
          + '<button class="act ghost" data-tp="reload">Refresh</button></div></div>';
        var list = shown();
        h += '<div class="scroll" style="max-height:340px;overflow-y:auto"><table><thead><tr><th>MPAN</th><th>Customer</th><th>Site</th><th>Postcode</th>'
          + '<th>Top line on file</th><th>MTC</th><th>Why</th><th>Contract end</th></tr></thead><tbody>'
          + (list.length ? list.slice(0, 400).map(function (r) {
            var st = storedParts(r);
            return '<tr><td class="mono">' + esc(r.mpan) + '</td><td>' + esc(r.customer_name || '') + '</td><td>' + esc(r.site_name || '')
              + '</td><td>' + esc(r.postcode || '') + '</td><td class="mono">' + esc([st.pc || '··', st.ssc || '····', st.llfc || '···'].join(' '))
              + '</td><td class="mono">' + esc(r.mtc || '') + '</td><td>' + esc(r.reason || '') + '</td><td>' + esc(deps.uk ? deps.uk(r.contract_end_date) : (r.contract_end_date || '')) + '</td></tr>';
          }).join('') : '<tr><td colspan="8" style="color:var(--muted)">Nothing to check.</td></tr>')
          + '</tbody></table></div>'
          + (list.length > 400 ? '<div class="tl-small" style="margin-top:6px">Showing 400 of ' + list.length + '. The export has them all.</div>' : '');
      }
      // TotalEnergies, automatically.
      h += teSection();
      // 2. Bring the results back.
      h += '<h3 style="font-size:13px;margin:18px 0 6px">2. Bring the portal results back</h3>'
        + '<div class="tl-row"><div style="flex:0 0 auto;min-width:240px"><label for="tlSrc2">Where they came from</label><select id="tlSrc2">'
        + sourceOptions(esc, S.source) + '</select></div></div>'
        + '<div class="tl-drop" id="tlDrop" tabindex="0" role="button" aria-label="Choose the portal export"><b>Drop the portal export here</b>'
        + '<div class="tl-small" style="margin-top:6px">CSV or Excel with an MPAN column and any of profile class, MTC, SSC, LLFC or the top line. Or click to choose a file.</div></div>'
        + '<input type="file" id="tlFile" accept=".csv,.txt,.xlsx,.xls,.xlsm" class="hide" style="display:none">'
        + '<label for="tlPaste2" style="margin-top:10px">Or paste the results</label>'
        + '<textarea id="tlPaste2" spellcheck="false" style="min-height:90px;font-family:\'JetBrains Mono\',monospace;font-size:12px"></textarea>'
        + '<div class="tl-btns"><button class="act ghost" data-tp="paste"' + (S.busy ? ' disabled' : '') + '>Read the paste</button></div>';
      // 3. The diff.
      if (S.dry) {
        var c = {}; S.dry.forEach(function (r) { c[r.outcome] = (c[r.outcome] || 0) + 1; });
        var nt = Object.keys(S.tick).filter(function (k) { return S.tick[k]; }).length;
        h += '<h3 style="font-size:13px;margin:18px 0 6px">3. What would change (' + esc(S.file) + ')</h3>'
          + '<div class="tl-sum">' + Object.keys(OUT).filter(function (k) { return c[k]; }).map(function (k) {
            return '<span><span class="pill ' + OUT[k][0] + '">' + esc(OUT[k][1]) + '</span> ' + c[k] + '</span>';
          }).join('') + '</div>'
          + '<div class="scroll" style="max-height:420px;overflow-y:auto"><table><thead><tr><th style="width:30px"><input type="checkbox" id="tlTickAll" aria-label="Tick every row"></th>'
          + '<th>MPAN</th><th>Customer</th><th>Outcome</th><th>Changes</th><th>Notes</th></tr></thead><tbody>'
          + S.dry.map(function (r) {
            var o = OUT[r.outcome] || ['p-mute', r.outcome], can = ['corrected', 'partial', 'match'].indexOf(r.outcome) >= 0;
            var i = S.info[r.mpan] || {}, src = (S.read.find(function (x) { return x.mpan === r.mpan; }) || {});
            var notes = (r.warnings || []).concat(src.warnings || []);
            return '<tr><td><input type="checkbox" data-tick="' + esc(r.mpan) + '"' + (S.tick[r.mpan] ? ' checked' : '') + (can ? '' : ' disabled')
              + ' aria-label="Apply ' + esc(r.mpan) + '"></td><td class="mono">' + esc(r.mpan) + '</td><td>' + esc(i.customer_name || '')
              + '</td><td><span class="pill ' + o[0] + '">' + esc(o[1]) + '</span></td><td class="mono" style="font-size:11.5px">'
              + esc((r.changes || []).join('; ') || (r.outcome === 'match' ? 'none: confirms what is on file' : '')) + '</td><td class="tl-ev">'
              + esc(notes.join(' ')) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          + '<div class="tl-btns"><button class="act" data-tp="apply"' + (nt && !S.busy ? '' : ' disabled') + '>Apply ' + nt + ' ticked</button>'
          + '<span class="tl-small">A match is worth applying too: it records the check and takes the meter off the list.</span></div>';
      }
      // 4. Done.
      if (S.applied) {
        var a = {}; S.applied.forEach(function (r) { a[r.outcome] = (a[r.outcome] || 0) + 1; });
        h += '<div class="note good" style="margin-top:12px">Applied: ' + (a.corrected || 0) + ' corrected, ' + (a.match || 0) + ' confirmed'
          + (a.partial ? ', ' + a.partial + ' part read' : '') + '. UtilityClick still has the old values until someone changes them there.'
          + ' <button class="act sm" data-tp="uc"' + (a.corrected ? '' : ' disabled') + '>Export corrections for UtilityClick</button></div>';
      }
      if (S.busy) h += '<div class="tl-small" style="margin-top:8px">Working&hellip;</div>';
      h += '</div>';
      host.innerHTML = h;
      wire();
    }
    function wire() {
      var sel = doc.getElementById('tlReason');
      if (sel) sel.addEventListener('change', function () { S.reason = sel.value; paint(); });
      var src = doc.getElementById('tlSrc2');
      if (src) src.addEventListener('change', function () { S.source = src.value; });
      var drop = doc.getElementById('tlDrop'), input = doc.getElementById('tlFile');
      if (drop && input) {
        drop.addEventListener('click', function () { input.click(); });
        drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
        drop.addEventListener('drop', function (e) {
          e.preventDefault(); drop.classList.remove('over');
          var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f);
        });
        input.addEventListener('change', function () { if (input.files && input.files[0]) readFile(input.files[0]); });
      }
      var all = doc.getElementById('tlTickAll');
      if (all) all.addEventListener('change', function () {
        (S.dry || []).forEach(function (r) { if (['corrected', 'partial', 'match'].indexOf(r.outcome) >= 0) S.tick[r.mpan] = all.checked; });
        paint();
      });
      host.querySelectorAll('[data-tick]').forEach(function (b) {
        b.addEventListener('change', function () { S.tick[b.getAttribute('data-tick')] = b.checked; paint(); });
      });
      host.querySelectorAll('[data-tp]').forEach(function (b) {
        b.addEventListener('click', function () {
          var a = b.getAttribute('data-tp');
          if (a === 'export') exportSuspects();
          else if (a === 'copy') copyMpans();
          else if (a === 'reload') suspectsLoad();
          else if (a === 'paste') { var t = doc.getElementById('tlPaste2'); readPaste(t ? t.value : ''); }
          else if (a === 'apply') applyTicked();
          else if (a === 'uc') exportUc();
        });
      });
      host.querySelectorAll('[data-te]').forEach(function (b) {
        b.addEventListener('click', function () {
          var a = b.getAttribute('data-te');
          if (a === 'queue') teQueue();
          else if (a === 'stop') teStop();
          else if (a === 'review') teReview();
          else if (a === 'refresh') teLoad();
        });
      });
    }
    function refresh() { return Promise.all([suspectsLoad(), teLoad()]); }
    paint();
    refresh();
    return { VERSION: VERSION, state: S, refresh: refresh, paint: paint };
  }

  root.ToplineDesk = {
    VERSION: VERSION, openPasteDialog: openPasteDialog, mountPage: mountPage,
    parseText: parseText, parseTable: parseTable, normMpan: normMpan, topLineOf: topLineOf,
    _test: { mpanOk: mpanOk, supplyNumbers: supplyNumbers, normMpan: normMpan, partOf: partOf, sscOrMtc: sscOrMtc,
             readTopLine: readTopLine, parseText: parseText, parseTable: parseTable, findHeader: findHeader, headerMap: headerMap,
             textTable: textTable, csvRows: csvRows, topLineOf: topLineOf, printedTopLineOf: printedTopLineOf,
             storedParts: storedParts, compareParts: compareParts, readWarnings: readWarnings, applyRow: applyRow,
             toCsv: toCsv, ucCorrections: ucCorrections, fromClaude: fromClaude,
             teRow: teRow, teErrorText: teErrorText, missingFn: missingFn, whenUk: whenUk },
  };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).ToplineDesk;
