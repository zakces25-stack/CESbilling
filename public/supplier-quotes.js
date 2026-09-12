/* ═══════════════════════════════════════════════════════════════════════════════════════
   CES Supplier Quotes — one view, mounted by the sales portal AND the pricing desk.

   Drop what a supplier sent (PDF, Excel/CSV, a saved email, or pasted text) and get CES's
   Price Analysis table. The browser only extracts TEXT (pdf.js for PDFs, SheetJS for
   spreadsheets, the file itself for email). The reading is the quote-extract edge function:
   Sonnet transcribes every priced option AS WRITTEN and the server converts the units, so no
   figure is arithmetic done by a model. Whatever came back low-confidence is RED here until a
   broker corrects or confirms it. Annual figures are worked out in this page from the
   consumption boxes, identically for every row, so rows are comparable whatever the
   supplier's own document said.

   Why one file: sales.html and pricing.html both show this view. Two copies drift (see
   flex-shared.js for the lesson); one module cannot. Everything the view needs — markup,
   styles, state, the reader — is here. The host page hands over its Supabase client and gets
   back an api object; the ids the markup uses are stable so tests can drive either page.

   Rules that matter, 13 Sep 2026:
     - HIDDEN SHEETS ARE NOT READ. UGP's TPI export carries the three real quotes on a visible
       'Gas Term 1' sheet and two HIDDEN sheets ('Gas Term 2', 'Gas Term 3') with stale prices.
       Sending every sheet produced five quotes for three, two of them wrong (6.681 for 7.681).
       Skipped sheets are named in the staged-file list so nobody wonders.
     - FILES ARE STAGED, NOT READ ON DROP. Each staged file shows what it is, which sheets will
       be read, and gets its own Supplier and Fuel pickers, then one button reads them all.
     - THE SUPPLIER CELL SHOWS THE SUPPLIER. The model's "product" for an export is usually a
       sheet title or a term ("Term 3", "36 Months"); it lives in a tooltip, not the cell.
     - CES COMMISSION IS RECORDED, NEVER ADDED. A supplier's quote already has CES's commission
       inside the rates. The box records what that is (p/kWh) and the table shows it and the
       annual value; no rate on the table is ever moved by it. A test asserts that.
     - Capacity is p/kVA/month, standing charge p/day, rates p/kWh. Gas is one unit rate.
   ═══════════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var VERSION = '2026-09-14.3';
  // Where the two CES price sheet templates live. Same ?v= discipline as this file: .htaccess
  // caches for 30 days, so a changed template needs a changed URL or nobody receives it.
  var TEMPLATE_BASE = '/quote-templates/';
  var PDFJS_VER = '3.11.174';

  // ── CES's disclosure, WORD FOR WORD as CES supplied it, 14 Sep 2026 ─────────────────────
  //
  // Two placeholders are filled at render time: {PKWH} (the commission in p/kWh) and {ANNUAL}
  // (its estimated annual value). Everything else is CES's legal wording and is not to be
  // tidied, re-punctuated or "corrected" here. Note for whoever reads this next: the
  // ELECTRICITY text as supplied says the prices shown are "inclusive of of VAT, Climate
  // Charge Levy and exclusive of Nuclear RAB Levy", which duplicates a word and contradicts
  // both the gas text and CES's own quote sheet ("Prices shown exclude VAT, Climate Charge
  // and Nuclear RAB Levies"). It was flagged to CES on handover and left exactly as given:
  // changing a disclosure on a customer document is CES's call, not this file's.
  var DISCLOSURE = {
    gas: 'Due to the fluctuating energy markets, the prices quoted must be confirmed at the point of acceptance and may be subject to adjustment at any time prior to written confirmation from the supplier.  The savings indicated are by no means a guarantee of an actual saving / expenditure.  The annual saving will depend on the actual energy consumed. We work with most but not all energy suppliers so we cannot guarantee to have covered the entire market. The prices shown are exclusive of VAT, Climate Charge Levy and Green Gas Levy and are subject to supplier’s terms and conditions of supply which include clauses allowing suppliers to pass through Ofgem controlled 3rd party charges in exceptional circumstances’. The prices quoted include {PKWH}p/kwh commission or estimated annual value of {ANNUAL} for Commercial Energy Solutions Ltd (CES). Where a multi year contract is selected, total commission will be the estimated annual value multiplied by the number of contracted years. Services included: Contract renewal management, First bill and meter read validation, Utility Portal, Billing query management, Meter fault repair co-ordination, Reduced V.A.T declaration, Change of Tenancy, Capacity (kVa) assessment and Expenditure / Carbon (CO2e) reporting. CES is not a party to contract between you and the particular supplier and nor will we have any liability thereof.',
    electricity: 'Due to the fluctuating energy markets, the prices quoted must be confirmed at the point of acceptance and may be subject to adjustment at any time prior to written confirmation from the supplier.  The savings indicated are by no means a guarantee of an actual saving / expenditure.  The annual saving will depend on the actual energy consumed. We work with most but not all energy suppliers so we cannot guarantee to have covered the entire market. The prices shown are inclusive of of VAT, Climate Charge Levy and exclusive of Nuclear RAB Levy and are subject to supplier’s terms and conditions of supply which include clauses allowing suppliers to pass through Ofgem controlled 3rd party charges in exceptional circumstances’. The prices quoted include {PKWH}p/kwh or estimated annual value of {ANNUAL} commission for Commercial Energy Solutions Ltd (CES). Where a multi year contract is selected, total commission will be the estimated annual value multiplied by the number of contracted years. Services included: Contract renewal management, First bill and meter read validation, Utility Portal, Billing query management, Meter fault repair co-ordination, Reduced V.A.T declaration, Change of Tenancy, Capacity (kVa) assessment and Expenditure / Carbon (CO2e) reporting. CES is not a party to contract between you and the particular supplier and nor will we have any liability thereof.',
  };
  /** The disclosure for a fuel with the commission figures in it, or the placeholders if none. */
  function disclosureText(fuel, pkwh, annualKwh) {
    var t = DISCLOSURE[fuel === 'gas' ? 'gas' : 'electricity'];
    if (pkwh == null) return t.replace('{PKWH}', 'x.x').replace('{ANNUAL}', '£x');
    var annual = pkwh * (annualKwh || 0) / 100;
    return t.replace('{PKWH}', Number(pkwh).toFixed(2))
            .replace('{ANNUAL}', '£' + (annual >= 100 ? Math.round(annual).toLocaleString('en-GB') : annual.toFixed(2)));
  }

  // The suppliers CES deal with, for the Supplier pickers. Alphabetical; "Other" lets a
  // broker type one the list does not have.
  var SUPPLIERS = ['British Gas', 'British Gas Lite', 'Brook Green Supply', 'Corona Energy', 'Crown Gas & Power', 'Drax',
    'Ecotricity', 'EDF', 'E.ON Next', 'Good Energy', 'Marble Power', 'npower', 'Octopus Energy', 'Opus Energy', 'Pozitive Energy',
    'Regent Gas', 'Scottish Power', 'SEFE Energy', 'Shell Energy', 'SmartestEnergy', 'SSE', 'TotalEnergies', 'UGP', 'Utilita',
    'Valda Energy', 'YU Energy'];

  // Styles are scoped under .sqv so the module looks the same on the cream pricing desk and
  // the white sales portal, borrowing each page's variables only where a fallback is safe.
  var CSS = [
    '.sqv{font-size:13px;color:var(--text,#16242c)}',
    '.sqv .sq-card{background:var(--panel,#fff);border:1px solid var(--line,var(--border,#e2e5ec));border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(20,30,40,.04)}',
    '.sqv .sq-card.sq-result{padding:0;overflow:hidden}',
    '.sqv .sq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px 14px;margin-bottom:12px}',
    '.sqv .sq-lab{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#5c6b73);margin-bottom:4px}',
    '.sqv .sq-in{width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--line-2,var(--border,#cdd7d2));border-radius:8px;font-size:13px;background:#fff;color:inherit;font-family:inherit;height:auto}',
    '.sqv select.sq-in{height:auto}',
    '.sqv .sq-drop{border:2px dashed var(--line-2,var(--border,#cdd7d2));border-radius:10px;padding:18px;text-align:center;font-size:13px;color:var(--muted,#5c6b73);cursor:pointer;background:var(--panel-2,#fafbfd)}',
    '.sqv .sq-drop.over{border-color:var(--cyan,var(--navy,#0f766e));background:var(--cyan-glow,#eef1fb)}',
    '.sqv .sq-btn{display:inline-block;border:1px solid var(--cyan,var(--navy,#0f766e));background:var(--cyan,var(--navy,#0f766e));color:#fff;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}',
    '.sqv .sq-btn:disabled{opacity:.5;cursor:default}',
    '.sqv .sq-btn.ghost{background:transparent;color:var(--cyan,var(--navy,#0f766e))}',
    '.sqv .sq-btn.sm{padding:5px 10px;font-size:12px}',
    '.sqv .sq-btn.xs{padding:2px 7px;font-size:11px;border-radius:5px}',
    '.sqv .sq-cmp{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#6b7280)}',
    '.sqv .sq-cmp select{font-family:inherit;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ink,#111827);padding:4px 8px;border:1px solid var(--line,#e2e5ec);border-radius:7px;background:#fff}',
    '.sqv .sq-msg{font-size:12.5px;color:var(--muted,#5c6b73)}',
    '.sqv .sq-msg.bad{color:#b3261e}',
    '.sqv .sq-staged{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px}',
    '.sqv .sq-staged th{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#5c6b73);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line,#e2e5ec)}',
    '.sqv .sq-staged td{padding:7px 8px;border-bottom:1px solid var(--line,#eef0f4);vertical-align:middle}',
    '.sqv .sq-staged td.f{font-weight:600}',
    '.sqv .sq-staged .sub{display:block;font-weight:400;font-size:11.5px;color:var(--muted,#5c6b73);margin-top:2px;white-space:normal}',
    '.sqv .sq-staged .sub.warn{color:#7d5806}',
    '.sqv .sq-staged select.sq-in{padding:5px 8px;font-size:12.5px;min-width:150px}',
    '.sqv .sq-table{border-collapse:collapse;font-size:13px;width:100%;min-width:900px}',
    '.sqv .sq-table th{background:#d9d9d9;border:1px solid #333;padding:8px 8px;font-weight:700;text-align:center;font-size:12px;line-height:1.25;color:#111}',
    '.sqv .sq-table td{border:1px solid #333;padding:5px 8px;text-align:center;white-space:nowrap;color:#111;background:#fff}',
    '.sqv .sq-table td.sup{background:#d9d9d9;text-align:left;font-weight:600;min-width:170px}',
    '.sqv .sq-table tr.cur td{font-weight:700}',
    '.sqv .sq-table td.low{background:#fde2e2;color:#8a1c1c;font-weight:700;cursor:pointer}',
    '.sqv .sq-table td.diff.up{color:#c0392b;font-weight:700}',
    '.sqv .sq-table td.diff.down{color:#1a7f37;font-weight:700}',
    '.sqv .sq-table td.edit{cursor:pointer}',
    '.sqv .sq-table td.edit:hover{outline:2px solid var(--cyan,var(--navy,#0f766e));outline-offset:-2px}',
    '.sqv .sq-table input.cell{width:90px;padding:3px 6px;font-size:13px;text-align:center;border:1.5px solid var(--cyan,var(--navy,#0f766e));border-radius:4px;font-family:inherit}',
    '.sqv .sq-note{margin:10px 0;padding:8px 12px;border-radius:8px;font-size:12.5px}',
    '.sqv .sq-note.red{background:#fde2e2;color:#8a1c1c}',
    '.sqv .sq-note.amber{background:#fff4d6;color:#6b4e00}',
    '.sqv .sq-note.grey{color:var(--muted,#5c6b73);padding:0;margin:8px 0}',
    '.sqv .sq-legend{padding:0 18px 16px;font-size:11.5px;color:var(--muted,#5c6b73);line-height:1.5}',
    '.sqv .sq-swatch{display:inline-block;width:10px;height:10px;background:#fde2e2;border:1px solid #c0392b;vertical-align:middle;margin-right:5px}',
    '.sqv .sq-pick{font-weight:400;color:#8a6d1c;font-size:10.5px}',
    '.sqv .sq-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;border-bottom:1.5px solid var(--line,#e2e5ec)}',
    '.sqv .sq-title{font-weight:800;font-size:15px}',
    '.sqv .sq-sub{font-size:12px;color:var(--muted,#5c6b73)}',
    '.sqv .sq-comm{font-size:12.5px;padding:8px 18px 0;color:var(--text-2,#4a5b64)}',
    '.sqv .sq-disc{margin:0 18px 16px;border:1px solid #333;border-radius:4px;padding:12px 14px;font-size:11.5px;line-height:1.55;color:#111;background:#fff;text-align:justify}',
    '.sqv .sq-disc h4{margin:0 0 6px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}',
    '.sqv .sq-disc .miss{background:#fde2e2;color:#8a1c1c;font-weight:700;padding:0 3px}',
    '.sqv .sq-hhd{border:1px dashed var(--line-2,var(--border,#cdd7d2));border-radius:10px;padding:10px 14px;font-size:12px;color:var(--muted,#5c6b73);cursor:pointer;background:var(--panel-2,#fafbfd);margin-bottom:12px}',
    '.sqv .sq-hhd.over{border-color:var(--cyan,var(--navy,#0f766e))}',
    '.sqv .sq-hhd b{color:var(--text,#16242c)}',
  ].join('\n');

  var escDefault = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var num = function (v) { return Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; };
  var money = function (v) { return v == null ? '—' : '£' + Math.round(v).toLocaleString('en-GB'); };

  // ── Pure helpers, exported for tests ─────────────────────────────────────────────────────
  /**
   * Which sheets of a workbook to read: the VISIBLE ones. SheetJS records hidden sheets in
   * wb.Workbook.Sheets[i].Hidden (0 visible, 1 hidden, 2 very hidden), parallel to SheetNames.
   */
  function visibleSheets(wb) {
    var meta = (wb && wb.Workbook && wb.Workbook.Sheets) || [];
    var out = { visible: [], hidden: [] };
    (wb.SheetNames || []).forEach(function (name, i) {
      var h = meta[i] && meta[i].Hidden;
      (h ? out.hidden : out.visible).push(name);
    });
    return out;
  }
  /** The workbook as text for the reader: visible sheets only, each under its own heading. */
  function workbookText(XLSX, wb) {
    var sheets = visibleSheets(wb);
    var out = '';
    sheets.visible.forEach(function (sn) {
      out += '### Sheet: ' + sn + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false }) + '\n\n';
    });
    return { text: out, visible: sheets.visible, hidden: sheets.hidden };
  }
  /**
   * RFC 4180 rows. The same parser the pricing desk uses (pricing-parsers.js): quoted fields,
   * doubled quotes, CRLF, and a last row with no trailing newline (the case that was dropped
   * once and only a synthetic fixture caught, because every real CSV ends in a newline).
   */
  function csvRows(text) {
    var rows = [], row = [], cell = '', q = false;
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /**
   * A Stark half-hourly export into day / night kWh.
   *
   * Same reader as the pricing desk's Price tab, same fixed windows, so a split measured here
   * and a split measured there cannot disagree:
   *   night  00:00-07:00
   *   day    everything else
   * Position, not column index, decides the window (`i * 24 / n`), so the 46- and 50-reading
   * clock-change days do not shift it. Figures are scaled to 365 days; under 28 days of data
   * is warned about rather than quietly annualised from a fortnight.
   *
   * A file holding several MPANs is filtered to the one asked for, and says which it holds if
   * that MPAN is not in it. A file that carries no usable MPAN at all (Stark's site-aggregated
   * export writes "N/A" in that column) is read whole, because those are one meter per file.
   *
   * THE COLUMN IS FOUND BY AN EXACT HEADER, NOT A SUBSTRING. `/mpan/` matches "co-MPAN-y", so
   * a plain substring search picked column 0 of every real Stark file, read "Blank Table Ltd"
   * as the MPAN, stripped it to an empty string and skipped every row: the drop threw "no
   * readable half-hourly rows" on every genuine export. Real header, from Stark's Meter
   * Sequential CSV: Company Name, Site Name, Online Meter Name, MPAN, Meter ID, Type, Est, Date, 00:00…
   */
  function readStarkHhd(text, wantMpan) {
    var rows = csvRows(text);
    var hi = -1;
    for (var i = 0; i < rows.length; i++) {
      var r0 = rows[i];
      if (r0.some(function (c) { return /^\s*mpan\s*$/i.test(c); }) && r0.some(function (c) { return /^\s*date\s*$/i.test(c); })) { hi = i; break; }
      if (r0[0] && /company\s*name/i.test(r0[0]) && r0.some(function (c) { return /\bmpan\b/i.test(c); })) { hi = i; break; }
    }
    if (hi < 0) throw new Error('this does not look like a Stark export (no header row naming MPAN and Date)');
    var hdr = rows[hi].map(function (c) { return String(c).toLowerCase().trim(); });
    var pick = function (exact, loose) {
      var i2 = hdr.findIndex(function (c) { return exact.test(c); });
      return i2 >= 0 ? i2 : hdr.findIndex(function (c) { return loose.test(c); });
    };
    var mpanCol = pick(/^mpan$/, /\bmpan\b/);
    var dateCol = pick(/^date$/, /\bdate\b/);
    if (dateCol < 0) throw new Error('this Stark export has no Date column');
    var first = hdr.findIndex(function (c, i2) { return i2 > dateCol && /^\d{1,2}:\d{2}/.test(c); });
    var readStart = first > 0 ? first : dateCol + 1;
    var want = String(wantMpan || '').replace(/\D/g, '');
    // Does the file actually carry MPANs? Stark's site-aggregated export writes N/A in that
    // column, and then filtering on the MPAN would throw every row away.
    var hasMpans = mpanCol >= 0 && rows.slice(hi + 1).some(function (r) { return /\d{6,}/.test(String(r[mpanCol] || '')); });

    var day = 0, night = 0, days = 0, from = null, to = null, others = {};
    rows.slice(hi + 1).forEach(function (r) {
      var mpan = hasMpans ? String(r[mpanCol] || '').replace(/\D/g, '') : '';
      if (hasMpans && !mpan) return;
      if (hasMpans && want && mpan !== want) { others[mpan] = 1; return; }
      var m = String(r[dateCol] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (!m) return;
      var yy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      var date = new Date(Date.UTC(yy, Number(m[2]) - 1, Number(m[1])));
      var iso = date.toISOString().slice(0, 10);
      var cells = r.slice(readStart).map(function (c) { return String(c).trim(); });
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (!cells.length) return;
      var n = cells.length;                              // 48 normally; 46 / 50 on clock change
      cells.forEach(function (c, i3) {
        var v = Number(c);
        if (!c || c === '-' || !isFinite(v)) return;
        if (i3 * 24 / n < 7) night += v; else day += v;  // position in the day, clock-change safe
      });
      days++;
      if (!from || iso < from) from = iso;
      if (!to || iso > to) to = iso;
    });
    var otherList = Object.keys(others);
    if (!days) {
      throw new Error(want && otherList.length
        ? 'no rows for MPAN ' + want + '; the file holds ' + otherList.slice(0, 3).join(', ') + (otherList.length > 3 ? '…' : '')
        : 'no readable half-hourly rows');
    }
    var scale = 365 / days;
    return { day: day * scale, night: night * scale, measuredDay: day, measuredNight: night,
             days: days, from: from, to: to, scale: scale, others: otherList,
             mpanFiltered: hasMpans && !!want, hasMpans: hasMpans };
  }

  /** Annual expenditure for a row, on the consumption given. Rates are used AS THEY ARE. */
  function annualFor(r, fuel, k) {
    var sc = (Number(r.sc) || 0) * 365 / 100;
    if (fuel === 'gas') {
      var rate = r.unit != null ? r.unit : r.day;
      if (rate == null) return null;
      return (k.kwh || 0) * rate / 100 + sc;
    }
    var day = k.day || 0, night = k.night || 0, kva = k.kva || 0, energy;
    if (r.unit != null) energy = (day + night) * r.unit / 100;
    else if (r.day != null && r.night != null) energy = (day * r.day + night * r.night) / 100;
    else if (r.day != null) energy = (day + night) * r.day / 100;
    else return null;
    var cap = r.cap != null && kva ? kva * r.cap * 12 / 100 : 0;     // p/kVA/month x kVA x 12
    return energy + sc + cap;
  }

  // ── Writing an .xlsx, by hand ─────────────────────────────────────────────────────────────
  //
  // SheetJS is on both pages but the community build writes no styles, and the point of this
  // export is that the sheet LOOKS like the analysis on screen: grey bordered table, the
  // customer's details in boxes above it, the disclosure in a box below. So the workbook is
  // written here: a store-only zip (no compression, which every reader accepts) around the
  // handful of OOXML parts a one-sheet workbook needs.
  //
  // The zip timestamp is pinned, so exporting the same table twice gives byte-identical files.

  var CRC = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  function crc32(buf) {
    var c = -1;
    for (var i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC[(c ^ buf[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  }
  var xesc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    }).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  };

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // THE CES PRICE SHEET
  //
  // The customer's document is not one this file invents: it is CES's own "Gas Price Sheet"
  // and "HH Electric Price Sheet", filled in. So the broker sends the sheet the customer
  // already recognises, logo, borders, print setup and all.
  //
  // The rule that makes that safe, and it was learned on these exact two files: NOTHING that is
  // not being changed may be re-serialised. Round-tripping the workbook through a spreadsheet
  // library renames the XML namespace prefixes (r: becomes ns4:), rebuilds the style table with
  // different indices, and drops the grouped drawing that IS the CES logo — and Excel then
  // refuses the file with "we found a problem with some content". So: open the zip, edit three
  // parts AS TEXT, and copy every other entry back with its original compressed bytes untouched.
  //
  // Nothing here is hard-coded to a style number either. The row styles, the payment-method
  // cell, the trailing spacer cells and the thick bottom border are all READ OUT of the
  // template's own rows 15, 16 and the last row of its block, so if CES restyles the sheet the
  // export follows without anyone editing this file.
  // ═════════════════════════════════════════════════════════════════════════════════════════

  var TEMPLATES = {
    gas: {
      file: 'gas-price-sheet.xlsx',
      title: 'Gas Price Analysis',
      first: 15, last: 32,                          // the quote block as the template ships it
      // header cells: the label lives in the cell and the value is appended to it
      strings: { B9: 'Business Name: ', B10: 'Site: ', B11: 'Date: ', B12: 'MPRN: ', C12: 'CSD: ' },
      // where the consumption goes, and which of the view's figures fills it
      numbers: { F12: 'kwh' },
      cols: { supplier: 'B', sc: 'C', unit: 'D', term: 'E', pay: 'F', annual: 'G', diff: 'H' },
      annualF: function (r) { return '($C' + r + '*365)/100+($D' + r + '*$F$12)/100'; },
      diffF: function (r, base) { return 'SUM(G' + r + '-$G$' + base + ')'; },
      values: function (q) { return { sc: q.sc, unit: q.unit != null ? q.unit : q.day, term: q.term }; },
    },
    electricity: {
      file: 'hh-electric-price-sheet.xlsx',
      title: 'Electricity Price Analysis',
      first: 15, last: 40,
      strings: { B9: 'Business Name: ', B10: 'Site: ', B11: 'Date: ', B12: 'MPAN: ', D12: 'SSD: ' },
      numbers: { J12: 'day', K12: 'night', L12: 'kva' },
      // G (Feed-In / pass-through) and H (CCL) are HIDDEN columns in the template and the
      // portal has no figure for them: they are left empty, which contributes nothing to the
      // annual cost formula.
      cols: { supplier: 'B', sc: 'C', cap: 'D', day: 'E', night: 'F', term: 'I', pay: 'J', annual: 'K', diff: 'L' },
      annualF: function (r) {
        return 'SUM(C' + r + '*365)/100+(D' + r + '*$L$12*12)/100+(E' + r + '*$J$12)/100+(F' + r + '*$K$12)/100' +
               '+(G' + r + '*($J$12+$K$12))/100+(H' + r + '*($J$12+$K$12))/100';
      },
      diffF: function (r, base) { return 'SUM(K' + r + '-$K$' + base + ')'; },
      values: function (q) {
        // The template has a Day column and a Night column and no single-rate column, so a
        // one-rate quote goes in BOTH: day x rate + night x rate is the same as total x rate.
        //
        // The order these are tried in has to be annualFor()'s order exactly. It was the other
        // way round at first, and a row carrying a single rate AND day/night figures then cost
        // one thing on screen and a different thing on the sheet the customer received.
        var d = null, n = null;
        if (q.unit != null) { d = q.unit; n = q.unit; }
        else if (q.day != null && q.night != null) { d = q.day; n = q.night; }
        else if (q.day != null) { d = q.day; n = q.day; }
        return { sc: q.sc, cap: q.cap, day: d, night: n, term: q.term };
      },
    },
  };

  // ── zip, opened and closed without disturbing what is inside ─────────────────────────────
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('this browser cannot open the price sheet template (no DecompressionStream); use Chrome, Edge or a current Firefox'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  /** Every entry, keeping its COMPRESSED bytes so anything untouched can be copied verbatim. */
  function unzip(buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), dec = new TextDecoder();
    var eocd = -1;
    for (var i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('the price sheet template is not a readable .xlsx');
    var n = dv.getUint16(eocd + 10, true), at = dv.getUint32(eocd + 16, true);
    var entries = [], byName = {};
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(at, true) !== 0x02014b50) throw new Error('the template zip index is damaged');
      var method = dv.getUint16(at + 10, true), crc = dv.getUint32(at + 16, true);
      var csize = dv.getUint32(at + 20, true), usize = dv.getUint32(at + 24, true);
      var nlen = dv.getUint16(at + 28, true), elen = dv.getUint16(at + 30, true), clen = dv.getUint16(at + 32, true);
      var lho = dv.getUint32(at + 42, true);
      var name = dec.decode(buf.subarray(at + 46, at + 46 + nlen));
      // The LOCAL header's extra field is often a different length from the central one, so the
      // payload has to be found from the local header, never from the central directory's.
      var lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      var start = lho + 30 + lnlen + lelen;
      var e = { name: name, method: method, crc: crc, csize: csize, usize: usize, raw: buf.subarray(start, start + csize) };
      entries.push(e); byName[name] = e;
      at += 46 + nlen + elen + clen;
    }
    return { entries: entries, byName: byName };
  }
  function readPart(zip, name) {
    var e = zip.byName[name];
    if (!e) return Promise.resolve(null);
    if (e.method === 0) return Promise.resolve(new TextDecoder().decode(e.raw));
    return inflateRaw(e.raw).then(function (b) { return new TextDecoder().decode(b); });
  }
  /**
   * Write the archive back. Edited parts go in STORED (uncompressed, which every reader
   * accepts and which needs no deflate implementation); every other entry keeps the exact
   * compressed bytes, CRC and method it arrived with, so styles.xml, the drawing and the logo
   * image come out byte-identical to the template. The timestamp is pinned, so the same quotes
   * exported twice give the same file.
   */
  function rezip(zip, edits, drop) {
    var enc = new TextEncoder(), locals = [], central = [], offset = 0, count = 0;
    var DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
    zip.entries.forEach(function (e) {
      if (drop && drop.indexOf(e.name) >= 0) return;
      var edited = Object.prototype.hasOwnProperty.call(edits, e.name);
      var data, method, crc, usize;
      if (edited) { data = enc.encode(edits[e.name]); method = 0; crc = crc32(data); usize = data.length; }
      else { data = e.raw; method = e.method; crc = e.crc; usize = e.usize; }
      var name = enc.encode(e.name);
      var lh = new Uint8Array(30), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
      dv.setUint16(8, method, true); dv.setUint16(10, DOS_TIME, true); dv.setUint16(12, DOS_DATE, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, usize, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      locals.push(lh, name, data);
      var ch = new Uint8Array(46), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, method, true); cv.setUint16(12, DOS_TIME, true); cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, usize, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + data.length; count++;
    });
    var cdSize = central.reduce(function (n, b) { return n + b.length; }, 0);
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, count, true); ev.setUint16(10, count, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    var parts = locals.concat(central, [eocd]), total = 0;
    parts.forEach(function (b) { total += b.length; });
    var out = new Uint8Array(total), p = 0;
    parts.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  // ── the sheet surgery ────────────────────────────────────────────────────────────────────
  var splitSheet = function (xml) {
    var a = xml.indexOf('<sheetData>'), b = xml.indexOf('</sheetData>');
    if (a < 0 || b < 0) throw new Error('the template sheet has no sheetData');
    return { head: xml.slice(0, a + 11), body: xml.slice(a + 11, b), tail: xml.slice(b) };
  };
  /**
   * The template's rows, by number, as raw XML.
   *
   * Scanned rather than matched with one regular expression: a row's cells contain '/>' of
   * their own, so a lazy `<row ...>...(/>|</row>)` pattern stops at the first cell and returns
   * a fragment. The row TAG is measured first, and only then is its end looked for.
   */
  function sheetRows(body) {
    var out = {}, i = 0;
    while (i < body.length) {
      var s = body.indexOf('<row ', i); if (s < 0) break;
      var tagEnd = body.indexOf('>', s);
      if (tagEnd < 0) break;
      var end = body[tagEnd - 1] === '/' ? tagEnd + 1 : body.indexOf('</row>', tagEnd) + 6;
      var xml = body.slice(s, end);
      var num = Number((xml.match(/<row [^>]*\br="(\d+)"/) || [])[1]);
      if (num) out[num] = xml;
      i = end;
    }
    return out;
  }
  /** The style index of each column's cell in a row, e.g. {B:'41', C:'38'}, plus the row's own attributes. */
  function rowShape(rowXml) {
    var attrs = (rowXml.match(/^<row ([^>]*?)\/?>/) || [, ''])[1].replace(/\br="\d+"\s*/, '');
    var styles = {}, order = [], re = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>)/g, m;
    while ((m = re.exec(rowXml))) {
      var st = (m[2].match(/\bs="(\d+)"/) || [])[1];
      styles[m[1]] = st == null ? null : st;
      order.push(m[1]);
    }
    return { attrs: attrs, styles: styles, order: order };
  }
  var cellXml = function (col, row, style, kind, value) {
    var s = style == null ? '' : ' s="' + style + '"';
    if (kind === 'blank' || value == null || value === '') return '<c r="' + col + row + '"' + s + '/>';
    if (kind === 'str') return '<c r="' + col + row + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(value) + '</t></is></c>';
    if (kind === 'f') return '<c r="' + col + row + '"' + s + '><f>' + xesc(value) + '</f></c>';
    return '<c r="' + col + row + '"' + s + '><v>' + value + '</v></c>';
  };
  /** Shift every row and cell reference in a chunk of sheetData by delta. */
  function shiftRows(chunk, delta) {
    if (!delta) return chunk;
    return chunk
      .replace(/<row ([^>]*?)\br="(\d+)"/g, function (_, pre, n) { return '<row ' + pre + 'r="' + (Number(n) + delta) + '"'; })
      .replace(/<c r="([A-Z]+)(\d+)"/g, function (_, c, n) { return '<c r="' + c + (Number(n) + delta) + '"'; });
  }
  var shiftRef = function (ref, after, delta) {
    return ref.replace(/([A-Z]+)(\d+)/g, function (whole, c, n) {
      var r = Number(n);
      return r > after ? c + (r + delta) : whole;
    });
  };

  /**
   * Fill a CES price sheet template with a view of the quote table.
   *
   * `spec` is what `currentView()` returns, plus `compare` ('Current contract' | 'Renewal
   * offer'). The first row of the view is the comparison row and lands on row 15, which is the
   * row every Difference formula in the template points at; the rest follow in the order the
   * view gives them, which is cheapest first.
   *
   * Returns the finished .xlsx as bytes.
   */
  function fillPriceSheet(templateBytes, spec) {
    var T = TEMPLATES[spec.fuel === 'gas' ? 'gas' : 'electricity'];
    var zip = unzip(templateBytes);
    return Promise.all([readPart(zip, 'xl/worksheets/sheet1.xml'), readPart(zip, 'xl/workbook.xml'),
                        readPart(zip, 'xl/sharedStrings.xml'), readPart(zip, '[Content_Types].xml'),
                        readPart(zip, 'xl/_rels/workbook.xml.rels')])
      .then(function (parts) {
        var sheet = parts[0], book = parts[1], strings = parts[2], types = parts[3], rels = parts[4];
        if (!sheet || !book) throw new Error('the price sheet template is missing its worksheet');
        var S3 = splitSheet(sheet), rows = sheetRows(S3.body);
        if (!rows[T.first] || !rows[T.last]) throw new Error('the price sheet template does not have the expected quote rows');

        // The three shapes the block is built from, read out of the template itself.
        var baseShape = rowShape(rows[T.first]), midShape = rowShape(rows[T.first + 1]), endShape = rowShape(rows[T.last]);
        var quotes = spec.rows || [];
        if (!quotes.length) throw new Error('there are no quotes to put on the sheet');
        var n = quotes.length, firstR = T.first, lastR = firstR + n - 1, delta = lastR - T.last;

        var built = [];
        quotes.forEach(function (q, i) {
          var r = firstR + i;
          var shape = i === 0 ? baseShape : (i === n - 1 ? endShape : midShape);
          // One quote only means the comparison row IS the last row: it must carry the block's
          // bottom border, so the closing shape wins.
          if (n === 1) shape = endShape;
          var vals = T.values(q.r || q);
          var cells = [], seen = {};
          Object.keys(T.cols).forEach(function (key) {
            var col = T.cols[key]; seen[col] = 1;
            var st = shape.styles[col];
            if (key === 'supplier') cells.push([col, cellXml(col, r, st, 'str', q.r ? q.r.supplier : q.supplier)]);
            else if (key === 'pay') cells.push([col, cellXml(col, r, st, 'str', (q.r && q.r.pay) || 'DD')]);
            else if (key === 'annual') cells.push([col, cellXml(col, r, st, 'f', T.annualF(r))]);
            else if (key === 'diff') cells.push([col, i === 0 ? cellXml(col, r, st, 'str', 'n/a') : cellXml(col, r, st, 'f', T.diffF(r, firstR))]);
            else cells.push([col, cellXml(col, r, st, 'n', vals[key] == null ? null : vals[key])]);
          });
          // Columns the template has but this fuel does not fill (the hidden Feed-In and CCL
          // columns, and the spacer cells to the right) are kept, empty, so the row's borders
          // and shading are unbroken.
          shape.order.forEach(function (col) { if (!seen[col]) cells.push([col, cellXml(col, r, shape.styles[col], 'blank', null)]); });
          cells.sort(function (a, b) { return (a[0].length - b[0].length) || (a[0] < b[0] ? -1 : 1); });
          built.push('<row r="' + r + '" ' + shape.attrs + '>' + cells.map(function (c) { return c[1]; }).join('') + '</row>');
        });

        // Everything above the block is untouched; everything below it moves by delta.
        var above = [], below = [];
        Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
          if (r < T.first) above.push(rows[r]);
          else if (r > T.last) below.push(shiftRows(rows[r], delta));
        });
        var body = above.join('') + built.join('') + below.join('');

        // Header boxes: the label stays, the value is appended to it.
        Object.keys(T.strings).forEach(function (coord) {
          var label = T.strings[coord], key = { B9: 'business', B10: 'site', B11: 'dateText', B12: 'mpan', C12: 'csd', D12: 'csd' }[coord];
          var val = spec[key] == null ? '' : String(spec[key]);
          body = setCell(body, coord, function (st) { return cellXml(coord.replace(/\d+/, ''), Number(coord.match(/\d+/)[0]), st, 'str', label + val); });
        });
        Object.keys(T.numbers).forEach(function (coord) {
          var v = (spec.kwh || {})[T.numbers[coord]];
          body = setCell(body, coord, function (st) {
            return cellXml(coord.replace(/\d+/, ''), Number(coord.match(/\d+/)[0]), st, v == null || v === '' ? 'blank' : 'n', v == null ? null : Number(v));
          });
        });

        var tail = S3.tail;
        // The merges, the saved sort and the sheet's extent all have to follow the block.
        tail = tail.replace(/<mergeCell ref="([^"]+)"\/>/g, function (_, ref) { return '<mergeCell ref="' + shiftRef(ref, T.last, delta) + '"/>'; });
        tail = tail.replace(/<sortState\b[\s\S]*?<\/sortState>/, function (s) {
          if (n < 3) return '';                       // nothing left below the comparison row to sort
          return s.replace(/ref="([^"]+)"/g, function (__, ref) {
            return 'ref="' + ref.replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)/, function (w, c1, r1, c2, r2) {
              void w; void r2; return c1 + r1 + ':' + c2 + lastR;
            }) + '"';
          });
        });
        var head = S3.head.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, function (_, tl, c, r) {
          return '<dimension ref="' + tl + ':' + c + (Number(r) + delta) + '"/>';
        });
        // The template was saved scrolled down the page with a cell selected; open at the top.
        head = head.replace(/\s*topLeftCell="[^"]*"/, '')
                   .replace(/<selection[^>]*\/>/, '<selection activeCell="B9" sqref="B9"/>');

        var edits = {};
        edits['xl/worksheets/sheet1.xml'] = head + body + tail;

        // Every formula cell in the template carries a stale cached 0. Without this Excel shows
        // those zeros instead of recalculating, and the whole Annual Expenditure column reads
        // nothing. LibreOffice needs it too.
        var calc = book.match(/<calcPr\b[^>]*\/>/);
        if (calc) {
          var c2 = calc[0].indexOf('fullCalcOnLoad') >= 0 ? calc[0].replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')
                                                          : calc[0].replace(/\/>$/, ' fullCalcOnLoad="1"/>');
          book = book.replace(calc[0], c2);
        } else { book = book.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>'); }
        // The electricity sheet's tab is named for the meter; the gas one is not.
        if (T.file.indexOf('hh-electric') === 0 && spec.mpan) {
          book = book.replace(/(<sheet name=")[^"]*(")/, function (_, a, b) { return a + xesc(String(spec.mpan).slice(0, 28)) + b; });
        }
        edits['xl/workbook.xml'] = book;

        // The disclosure paragraph carries CES's commission placeholders.
        if (strings) edits['xl/sharedStrings.xml'] = fillDisclosureStrings(strings, spec);

        // calcChain lists which cells hold formulas and in what order. It is now wrong, and
        // Excel rebuilds it from scratch, so it is dropped along with the two references to it.
        var drop = [];
        if (zip.byName['xl/calcChain.xml']) {
          drop.push('xl/calcChain.xml');
          if (types) edits['[Content_Types].xml'] = types.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, '');
          if (rels) edits['xl/_rels/workbook.xml.rels'] = rels.replace(/<Relationship[^>]*calcChain\.xml"[^>]*\/>/, '');
        }
        return rezip(zip, edits, drop);
      });
  }
  /** Replace one cell in a chunk of sheetData, keeping whatever style it already had. */
  function setCell(body, coord, make) {
    var re = new RegExp('<c r="' + coord + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)');
    var m = body.match(re);
    if (!m) return body;
    var st = (m[1].match(/\bs="(\d+)"/) || [])[1];
    return body.replace(re, make(st == null ? null : st));
  }
  /**
   * The template's own disclosure paragraph has the commission left blank ("include 0.0p/kwh
   * commission or estimated annual value of £0", "include p/kwh commission, an estimated annual
   * value of £"). Fill both in, in the shared string table, so the sheet the customer reads
   * states what CES earns inside the rates.
   */
  function fillDisclosureStrings(xml, spec) {
    var p = spec.commission, kwh = spec.totalKwh || 0;
    var pen = p == null ? null : Number(p).toFixed(2);
    var ann = p == null ? null : '£' + Math.round(kwh * p / 100).toLocaleString('en-GB');
    if (pen == null) return xml;
    return xml
      .replace(/include \d+(?:\.\d+)?p\/kwh commission or estimated annual value of £[\d,]*/g,
               'include ' + pen + 'p/kwh commission or estimated annual value of ' + ann)
      .replace(/include p\/kwh commission, an estimated annual value of £ commission/g,
               'include ' + pen + 'p/kwh commission, an estimated annual value of ' + ann + ' commission');
  }

  // The workbook this file used to write by hand — its own styles, its own table, its own
  // idea of what the document should look like — is gone. The export fills CES's real price
  // sheet template instead, so there is only one answer to "what does the customer receive".

  // ── The view ──────────────────────────────────────────────────────────────────────────────
  function mount(host, opts) {
    opts = opts || {};
    var sb = opts.sb, esc = opts.esc || escDefault;
    if (!host) throw new Error('SupplierQuotes.mount: no host element');
    if (!document.getElementById('sqv-style')) {
      var st = document.createElement('style'); st.id = 'sqv-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    var S = { rows: [], meta: {}, seq: 0, detected: null, staged: [], commission: null, reading: false };
    var $ = function (id) { return host.querySelector('#' + id); };

    var supplierOptions = function (selected) {
      return '<option value=""' + (!selected ? ' selected' : '') + '>Named in the document</option>' +
        SUPPLIERS.map(function (s) { return '<option value="' + esc(s) + '"' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
        (selected && SUPPLIERS.indexOf(selected) < 0 ? '<option value="' + esc(selected) + '" selected>' + esc(selected) + '</option>' : '') +
        '<option value="__other">Other (type it)…</option>';
    };
    var fuelOptions = function (selected) {
      return ['auto', 'electricity', 'gas'].map(function (f) {
        var label = f === 'auto' ? 'Detect from the quote' : f.charAt(0).toUpperCase() + f.slice(1);
        return '<option value="' + f + '"' + (f === selected ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
    };

    host.classList.add('sqv');
    host.innerHTML =
      '<div class="sq-card" id="sqInputCard">' +
        '<div class="sq-grid">' +
          '<div><label class="sq-lab">Business name</label><input id="sqBusiness" class="sq-in" placeholder="from the quote, or type it"></div>' +
          '<div><label class="sq-lab">Site</label><input id="sqSite" class="sq-in" placeholder="supply address"></div>' +
          '<div><label class="sq-lab">MPAN / MPRN</label><input id="sqMpan" class="sq-in" inputmode="numeric"></div>' +
          '<div><label class="sq-lab">Contract start</label><input id="sqCsd" class="sq-in" type="date"></div>' +
          '<div><label class="sq-lab">Fuel</label><select id="sqFuel" class="sq-in">' + fuelOptions('auto') + '</select></div>' +
          '<div><label class="sq-lab">Supplier (default for new files)</label><select id="sqSupplier" class="sq-in">' + supplierOptions('') + '</select></div>' +
          '<div><label class="sq-lab">CES commission (p/kWh, in the rates)</label><input id="sqComm" class="sq-in" inputmode="decimal" placeholder="e.g. 1.00" title="What CES earns inside these rates. It goes in the disclosure under the table; it is never added to a rate, because the supplier\'s prices already include it."></div>' +
        '</div>' +
        '<div id="sqConsumption" class="sq-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"></div>' +
        '<div id="sqHhd" class="sq-hhd"><b>Measure the split from half-hourly data</b>: drop a year of Stark half-hourly data here (CSV or Excel), or click. ' +
          'Night is 00:00 to 07:00 and everything else is day; the boxes above fill with the annualised kWh per register.' +
          '<input id="sqHhdFile" type="file" accept=".csv,.xlsx,.xls,.txt" style="display:none"></div>' +
        '<div id="sqHhdNote" style="display:none"></div>' +
        '<div id="sqDrop" class="sq-drop"><b>Drop the supplier\'s quotes here</b>: a PDF, an Excel or CSV, or a saved email, or click to choose. ' +
          'They are listed below first, so you can pick the supplier for each before anything is read.' +
          '<input id="sqFile" type="file" multiple accept=".pdf,.xlsx,.xlsm,.xls,.csv,.txt,.eml,.msg" style="display:none"></div>' +
        '<div id="sqStagedWrap" style="display:none">' +
          '<table class="sq-staged" id="sqStaged"></table>' +
          '<div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">' +
            '<button class="sq-btn" id="sqReadBtn">Read the quotes</button>' +
            '<button class="sq-btn ghost sm" id="sqClearStaged">Remove all</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:12px"><label class="sq-lab">…or paste the email / quote text</label>' +
          '<textarea id="sqPaste" class="sq-in" rows="4" placeholder="Paste the body of the supplier\'s email here" style="width:100%;font-family:inherit"></textarea></div>' +
        '<div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">' +
          '<button class="sq-btn" id="sqReadPasted">Read the pasted text</button>' +
          '<span id="sqMsg" class="sq-msg"></span>' +
        '</div>' +
      '</div>' +
      '<div class="sq-card sq-result" id="sqResultCard" style="display:none">' +
        '<div class="sq-top"><div><div class="sq-title" id="sqTitle">Electricity Price Analysis</div><div class="sq-sub" id="sqSubtitle"></div></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
            '<label class="sq-cmp" for="sqCompare">Compare against' +
              '<select id="sqCompare"><option value="Current contract">Current contract</option>' +
              '<option value="Renewal offer">Renewal offer</option></select></label>' +
            '<button class="sq-btn ghost sm" id="sqConfirmAll">Confirm all figures</button>' +
            '<button class="sq-btn ghost sm" id="sqAddRow">+ Add a row</button>' +
            '<button class="sq-btn sm" id="sqExport">Download price sheet</button>' +
            '<button class="sq-btn ghost sm" id="sqClear">Start again</button>' +
          '</div></div>' +
        '<div id="sqWarn" style="padding:0 18px"></div>' +
        '<div style="overflow-x:auto;padding:0 18px 14px"><table class="sq-table" id="sqTable"></table></div>' +
        '<div class="sq-disc" id="sqDisclosure"></div>' +
        '<div class="sq-legend"><span class="sq-swatch"></span>A red figure is one the reader was not sure of, or whose unit it could not see. Click it to correct, or use Confirm all once checked. ' +
          'Capacity is shown in p/kVA/month, standing charge in p/day, rates in p/kWh. Approx. annual expenditure is worked out on the consumption above. ' +
          'Gas is always one unit rate. CES\'s commission is already inside the supplier\'s rates and is stated in the disclosure above, never added to a rate.</div>' +
      '</div>';

    // ── the fuel in force, the pickers ──
    var fuelChosen = function () { var v = $('sqFuel').value; return v === 'auto' ? 'auto' : v; };
    var fuel = function () { var v = $('sqFuel').value; return v === 'auto' ? (S.detected || 'electricity') : v; };
    var supplierHint = function () { var v = $('sqSupplier').value; return v === '__other' ? '' : v; };
    var otherSupplier = function (sel) {
      if (sel.value !== '__other') return;
      var typed = (window.prompt('Supplier name as it should appear on the table:', '') || '').trim();
      if (!typed) { sel.value = ''; return; }
      var o = document.createElement('option'); o.value = typed; o.textContent = typed;
      sel.insertBefore(o, sel.querySelector('option[value="__other"]')); sel.value = typed;
    };
    $('sqSupplier').onchange = function () { otherSupplier($('sqSupplier')); };
    $('sqFuel').onchange = function () { paintConsumption(); };
    $('sqComm').oninput = function () {
      var v = String($('sqComm').value).trim();
      S.commission = v === '' ? null : num(v);
      S.commissionTyped = v !== '';
      render();
    };
    ['sqBusiness', 'sqSite', 'sqMpan', 'sqCsd'].forEach(function (id) { $(id).oninput = function () { render(); }; });

    // The consumption boxes. Their values live in S.boxes, not only in the inputs, so a gas
    // figure typed before a switch to electricity and back is still there afterwards.
    S.boxes = {};
    function paintConsumption() {
      var hostC = $('sqConsumption');
      hostC.querySelectorAll('input').forEach(function (i) { S.boxes[i.id] = i.value; });
      var boxes = fuel() === 'gas'
        ? [['sqKwh', 'Annual consumption (kWh)']]
        : [['sqDay', 'Day kWh'], ['sqNight', 'Night kWh (0 if single rate)'], ['sqKva', 'Capacity (kVA, HH only)']];
      hostC.innerHTML = boxes.map(function (b) {
        return '<div><label class="sq-lab">' + b[1] + '</label><input id="' + b[0] + '" class="sq-in" inputmode="numeric" value="' + esc(S.boxes[b[0]] || '') + '"></div>';
      }).join('');
      hostC.querySelectorAll('input').forEach(function (i) { i.oninput = function () { S.boxes[i.id] = i.value; render(); }; });
      render();
    }
    var kwhBoxes = function () {
      var g = function (id) { var e = $(id); return e ? num(e.value) : 0; };
      return { kwh: g('sqKwh'), day: g('sqDay'), night: g('sqNight'), kva: g('sqKva') };
    };
    var totalKwh = function () { var k = kwhBoxes(); return fuel() === 'gas' ? k.kwh : k.day + k.night; };
    var say = function (m, bad) { var e = $('sqMsg'); e.textContent = m; e.className = 'sq-msg' + (bad ? ' bad' : ''); };

    // ── half-hourly data: measure the split instead of guessing it ──
    //
    // A year of Stark half-hourly data gives the day/night split exactly, which is the one
    // input on this screen nobody can eyeball. Nothing is sent anywhere: the file is read in
    // the browser and only the two totals end up in the boxes.
    async function hhdDropped(files) {
      var f = files && files[0];
      if (!f) return;
      var note = $('sqHhdNote');
      var show = function (html, cls) { note.style.display = ''; note.className = 'sq-note ' + (cls || 'grey'); note.innerHTML = html; };
      show('Reading ' + esc(f.name) + '…');
      try {
        var text;
        if (/\.(xlsx|xlsm|xls)$/i.test(f.name)) {
          var XLSX = root.XLSX; if (!XLSX) throw new Error('SheetJS is not loaded on this page');
          var wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
          var sh = visibleSheets(wb);
          text = XLSX.utils.sheet_to_csv(wb.Sheets[sh.visible[0] || wb.SheetNames[0]], { blankrows: false });
        } else {
          text = await f.text();
        }
        var h = readStarkHhd(text, ($('sqMpan').value || '').replace(/\D/g, ''));
        var day = Math.round(h.day), night = Math.round(h.night), total = day + night;
        if (fuel() === 'gas') {
          S.boxes.sqKwh = String(total);
          if ($('sqKwh')) $('sqKwh').value = String(total);
        } else {
          S.boxes.sqDay = String(day); S.boxes.sqNight = String(night);
          if ($('sqDay')) $('sqDay').value = String(day);
          if ($('sqNight')) $('sqNight').value = String(night);
        }
        render();
        var pct = total ? Math.round(night / total * 100) : 0;
        var uk = function (iso) { return iso ? iso.split('-').reverse().join('/') : ''; };
        show('<b>Measured from ' + h.days + ' day' + (h.days === 1 ? '' : 's') + '</b> of half-hourly data'
          + (h.from ? ' (' + uk(h.from) + ' to ' + uk(h.to) + ')' : '') + ': '
          + (fuel() === 'gas'
              ? total.toLocaleString('en-GB') + ' kWh a year.'
              : day.toLocaleString('en-GB') + ' kWh day and ' + night.toLocaleString('en-GB') + ' kWh night a year, a '
                + (100 - pct) + '/' + pct + ' split. Night is 00:00 to 07:00; everything else is day.')
          + (h.days < 28 ? ' <b>Under 28 days of data</b>, scaled to a year: treat the split as indicative.' : '')
          + (h.days < 350 && h.days >= 28 ? ' Scaled from ' + h.days + ' days to 365.' : '')
          + (!h.hasMpans ? ' The file carries no MPAN, so every row in it was read.' : '')
          + (h.others.length ? ' ' + h.others.length + ' other meter' + (h.others.length === 1 ? '' : 's') + ' in the file ' + (h.others.length === 1 ? 'was' : 'were') + ' skipped.' : ''),
          h.days < 28 ? 'amber' : 'grey');
      } catch (e) {
        show('Could not read ' + esc(f.name) + ': ' + esc(e.message || String(e)), 'red');
      }
    }

    // ── staging: see the file, pick its supplier, then read ──
    async function inspect(f) {
      var name = f.name.toLowerCase();
      var info = { kind: 'text', note: '', warn: '' };
      if (/\.pdf$/.test(name)) { info.kind = 'pdf'; info.note = Math.round(f.size / 1024) + ' KB PDF'; }
      else if (/\.(xlsx|xlsm|xls|csv)$/.test(name)) {
        info.kind = 'spreadsheet';
        try {
          var XLSX = root.XLSX; if (!XLSX) throw new Error('SheetJS is not loaded');
          // A full read, not bookSheets: true. The names-only read does not carry the hidden
          // flags (measured on UGP's export: all three sheets came back "visible"), and the
          // hidden flag is the whole point of looking.
          var wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
          var sh = visibleSheets(wb);
          info.sheets = sh;
          info.note = sh.visible.length + ' sheet' + (sh.visible.length === 1 ? '' : 's') + ' to read' + (sh.visible.length ? ': ' + sh.visible.join(', ') : '');
          if (sh.hidden.length) info.warn = sh.hidden.length + ' hidden sheet' + (sh.hidden.length === 1 ? '' : 's') + ' skipped: ' + sh.hidden.join(', ');
        } catch (e) { info.warn = 'could not open: ' + (e.message || e); }
      }
      else if (/\.msg$/.test(name)) { info.kind = 'email (.msg)'; info.note = 'Outlook message: text will be recovered from it'; }
      else if (/\.eml$/.test(name)) { info.kind = 'email'; }
      else { info.note = Math.round(f.size / 1024) + ' KB text'; }
      return info;
    }
    async function stage(files) {
      var list = Array.prototype.slice.call(files || []);
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        var info = await inspect(f);
        S.staged.push({ id: 's' + (++S.seq), file: f, name: f.name, info: info, supplier: supplierHint(), fuel: fuelChosen(), status: '' });
      }
      paintStaged();
    }
    function paintStaged() {
      var wrap = $('sqStagedWrap'), tbl = $('sqStaged');
      if (!S.staged.length) { wrap.style.display = 'none'; tbl.innerHTML = ''; return; }
      wrap.style.display = '';
      tbl.innerHTML = '<tr><th>File</th><th>Supplier</th><th>Fuel</th><th></th></tr>' + S.staged.map(function (s) {
        return '<tr data-id="' + s.id + '">' +
          '<td class="f">' + esc(s.name) +
            (s.info.note ? '<span class="sub">' + esc(s.info.note) + '</span>' : '') +
            (s.info.warn ? '<span class="sub warn">' + esc(s.info.warn) + '</span>' : '') +
            (s.status ? '<span class="sub' + (/^could not|failed/i.test(s.status) ? ' warn' : '') + '">' + esc(s.status) + '</span>' : '') + '</td>' +
          '<td><select class="sq-in st-supplier">' + supplierOptions(s.supplier) + '</select></td>' +
          '<td><select class="sq-in st-fuel">' + fuelOptions(s.fuel) + '</select></td>' +
          '<td><button class="sq-btn ghost xs st-remove" title="Remove this file">×</button></td></tr>';
      }).join('');
      tbl.querySelectorAll('tr[data-id]').forEach(function (tr) {
        var s = S.staged.find(function (x) { return x.id === tr.getAttribute('data-id'); });
        var sup = tr.querySelector('.st-supplier'), fu = tr.querySelector('.st-fuel');
        sup.onchange = function () { otherSupplier(sup); s.supplier = sup.value === '__other' ? '' : sup.value; };
        fu.onchange = function () { s.fuel = fu.value; };
        tr.querySelector('.st-remove').onclick = function () { S.staged = S.staged.filter(function (x) { return x !== s; }); paintStaged(); };
      });
      $('sqReadBtn').textContent = 'Read ' + S.staged.length + ' quote' + (S.staged.length === 1 ? '' : 's');
      $('sqReadBtn').disabled = S.reading;
    }
    async function readStaged() {
      if (S.reading || !S.staged.length) return;
      S.reading = true; paintStaged();
      var queue = S.staged.slice();
      for (var i = 0; i < queue.length; i++) {
        var s = queue[i];
        try {
          s.status = 'reading…'; paintStaged();
          var got = await textOf(s.file);
          var n = await extract(got.text, got.images, got.kind, s.name, { fuel: s.fuel, supplier: s.supplier });
          S.staged = S.staged.filter(function (x) { return x !== s; });          // read: off the list
          say('Read ' + n + ' priced option' + (n === 1 ? '' : 's') + ' from ' + s.name + '.');
        } catch (e) {
          s.status = 'could not read: ' + (e.message || e);
          say('Could not read ' + s.name + ': ' + (e.message || e), true);
        }
        paintStaged();
      }
      S.reading = false; paintStaged();
    }

    // ── text out of whatever was dropped ──
    function loadPdfJs() {
      return new Promise(function (res, rej) {
        if (root.pdfjsLib && root.pdfjsLib.getDocument) return res();
        var src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.min.js';
        var existing = Array.prototype.some.call(document.scripts, function (sc) { return sc.src === src; });
        var done = function () {
          if (!root.pdfjsLib) return rej(new Error('pdf.js did not load'));
          root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.worker.min.js';
          res();
        };
        if (existing) { var t = setInterval(function () { if (root.pdfjsLib) { clearInterval(t); done(); } }, 50); setTimeout(function () { clearInterval(t); if (!root.pdfjsLib) rej(new Error('pdf.js did not load')); }, 15000); return; }
        var sc = document.createElement('script'); sc.src = src; sc.onload = done; sc.onerror = function () { rej(new Error('pdf.js did not load')); };
        document.head.appendChild(sc);
      });
    }
    async function textOf(f) {
      var name = f.name.toLowerCase();
      if (/\.pdf$/.test(name)) {
        await loadPdfJs();
        var doc = await root.pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
        var text = '', images = [];
        for (var n = 1; n <= Math.min(doc.numPages, 12); n++) {
          var page = await doc.getPage(n);
          var tc = await page.getTextContent();
          var lastY = null, line = [];
          tc.items.forEach(function (it) {                 // keep the table shape: new line on a new y
            var y = Math.round(it.transform[5]);
            if (lastY !== null && Math.abs(y - lastY) > 2) { text += line.join(' ') + '\n'; line = []; }
            line.push(it.str); lastY = y;
          });
          text += line.join(' ') + '\n\n';
        }
        if (text.replace(/\s/g, '').length < 80) {          // a scan: send the pages as pictures
          for (var p = 1; p <= Math.min(doc.numPages, 4); p++) {
            var pg = await doc.getPage(p), vp = pg.getViewport({ scale: 1.6 });
            var cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
            await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            images.push(cv.toDataURL('image/jpeg', 0.85));
          }
        }
        return { text: text, images: images, kind: 'pdf' };
      }
      if (/\.(xlsx|xlsm|xls|csv)$/.test(name)) {
        var XLSX = root.XLSX; if (!XLSX) throw new Error('SheetJS is not loaded on this page');
        var wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
        var w = workbookText(XLSX, wb);
        if (!w.visible.length) throw new Error('every sheet in this workbook is hidden');
        return { text: w.text, images: [], kind: 'spreadsheet' + (w.hidden.length ? ' (' + w.hidden.length + ' hidden sheet' + (w.hidden.length === 1 ? '' : 's') + ' not read)' : '') };
      }
      if (/\.msg$/.test(name)) {
        // Outlook's binary format: pull the readable strings out. The body is usually UTF-16.
        var buf = new Uint8Array(await f.arrayBuffer());
        var u16 = '', u8 = '';
        for (var k = 0; k + 1 < buf.length; k += 2) { var c = buf[k] | (buf[k + 1] << 8); u16 += (c >= 32 && c < 0xFFFE) ? String.fromCharCode(c) : '\n'; }
        for (var j = 0; j < buf.length; j++) u8 += (buf[j] >= 32 && buf[j] < 127) ? String.fromCharCode(buf[j]) : '\n';
        var pick = (u16.match(/[A-Za-z0-9£$.,:\/()\-% ]{6,}/g) || []).join('\n') + '\n' + (u8.match(/[A-Za-z0-9£$.,:\/()\-% ]{6,}/g) || []).join('\n');
        return { text: pick.slice(0, 120000), images: [], kind: 'email (.msg, text recovered)' };
      }
      var t = await f.text();
      return { text: t.slice(0, 120000), images: [], kind: /\.eml$/.test(name) ? 'email' : 'text' };
    }

    // ── the reading ──
    /**
     * What actually went wrong, in words.
     *
     * supabase-js does NOT put a non-2xx response in `data`. It wraps it in a FunctionsHttpError
     * whose `.message` is the fixed string "Edge Function returned a non-2xx status code" and
     * hangs the real Response on `.context`. So the function's own `{error, detail}` — the one
     * thing that says WHY — was being thrown away, and every failure looked identical on screen
     * whether the session had expired, the file was too big, or the model had refused. This
     * reads the body and says what the status means.
     */
    async function fnErrorMessage(err) {
      var res = err && err.context, status = (res && res.status) || 0, body = null, raw = '';
      if (res && typeof res.text === 'function') {
        try { raw = await res.text(); } catch (_) { raw = ''; }
        if (raw) { try { body = JSON.parse(raw); } catch (_) { body = null; } }
      }
      var said = body && (body.error || body.message) ? String(body.error || body.message) : '';
      var detail = body && body.detail ? ' (' + String(body.detail).slice(0, 300) + ')' : '';
      // The model's own status comes back as "model 429" etc; turn the ones that matter into
      // something a broker can act on rather than report.
      var m = said.match(/^model (\d+)$/);
      if (m) {
        var ms = Number(m[1]);
        if (ms === 401 || ms === 403) return 'the reader was refused by the AI service: CES\'s API key was rejected' + detail;
        if (ms === 429) return 'the AI service is rate limiting us; wait a moment and read again' + detail;
        if (ms === 400) return 'the AI service rejected the request' + detail;
        if (ms >= 500) return 'the AI service had an error (' + ms + '); try again' + detail;
      }
      if (status === 401) return 'your session has expired: reload the page, sign in again, then read the files again';
      if (status === 413) return 'this file is too big to send to the reader; paste the rates instead, or split it';
      if (status === 504 || status === 546) return 'the reader ran out of time on this file; try it on its own, or paste the rates';
      if (said) return said + detail;
      if (status) return 'the reader returned HTTP ' + status + (raw ? ': ' + raw.slice(0, 200) : '');
      return (err && err.message) || String(err);
    }
    async function extract(text, images, kind, filename, steer) {
      steer = steer || {};
      var fuelWanted = steer.fuel || fuelChosen();
      var hint = steer.supplier != null ? steer.supplier : supplierHint();
      if (!sb || !sb.functions) throw new Error('no Supabase client');
      var r = await sb.functions.invoke('quote-extract', { body: { text: text, images: images, kind: kind, filename: filename, fuel: fuelWanted, supplier_hint: hint } });
      if (r.error) throw new Error('the reader failed: ' + await fnErrorMessage(r.error));
      var d = r.data || {};
      if (!d.ok) throw new Error('the reader failed: ' + (d.error || 'unknown') + (d.detail ? ' (' + d.detail + ')' : ''));
      var fill = function (id, v) { var e = $(id); if (e && !e.value && v) e.value = v; };
      fill('sqBusiness', d.customer); fill('sqSite', d.site); fill('sqMpan', d.mpan_or_mprn); fill('sqCsd', d.contract_start_date);
      // Fuel: what the reader saw, unless the broker had chosen. A document pricing BOTH fuels
      // with nothing chosen shows the majority fuel; the other fuel's rows are kept, hidden
      // and announced.
      var fuels = (d.quotes || []).map(function (q) { return q.fuel; }).filter(function (x) { return x !== 'unknown'; });
      if (fuelWanted === 'auto' && fuelChosen() === 'auto' && fuels.length && !S.rows.length) {
        var nGas = fuels.filter(function (x) { return x === 'gas'; }).length;
        S.detected = d.document_fuel === 'gas' || d.document_fuel === 'electricity' ? d.document_fuel : (nGas > fuels.length / 2 ? 'gas' : 'electricity');
        paintConsumption();
      } else if (fuelWanted !== 'auto' && fuelChosen() === 'auto' && !S.rows.length) {
        S.detected = fuelWanted; paintConsumption();
      }
      if (d.annual_consumption_kwh) {
        if (fuel() === 'gas') fill('sqKwh', String(Math.round(d.annual_consumption_kwh)));
        else fill('sqDay', String(Math.round(d.annual_consumption_kwh)));
      }
      (d.quotes || []).forEach(function (q) {
        var com = q.commission || { value: null, confidence: 'low' };
        S.rows.push({
          id: 'q' + Math.random().toString(36).slice(2, 8), source: filename,
          supplier: q.supplier || '?', supplierFromHint: !!q.supplier_from_hint, product: q.product || '', fuel: q.fuel,
          term: q.term_months, termLow: q.term_confidence === 'low',
          start: q.start_date || null, pay: q.payment_method || 'DD',
          sc: q.standing_charge.value, scLow: q.standing_charge.confidence === 'low',
          unit: q.unit_rate.value, unitLow: q.unit_rate.confidence === 'low' && q.unit_rate.value != null,
          day: q.day_rate.value, dayLow: q.day_rate.confidence === 'low' && q.day_rate.value != null,
          night: q.night_rate.value, nightLow: q.night_rate.confidence === 'low' && q.night_rate.value != null,
          cap: q.capacity_charge.value, capLow: q.capacity_charge.confidence === 'low' && q.capacity_charge.value != null,
          com: com.value, comLow: com.confidence === 'low' && com.value != null, comIncluded: q.commission_included,
          notes: q.notes || '', flags: q.flags || [], current: false,
        });
      });
      // A supplier that states its commission fills the box, so the disclosure is not left
      // empty for the desk to notice. Only when they have not typed one themselves.
      if (!S.commissionTyped) {
        var stated = docCommission();
        if (stated != null) { S.commission = stated; $('sqComm').value = Number(stated).toFixed(2); }
      }
      S.meta.warnings = (S.meta.warnings || []).concat(d.warnings || []);
      S.meta.model = d.model; S.meta.ms = d.ms; S.meta.documentFuel = d.document_fuel;
      $('sqResultCard').style.display = '';
      render();
      return (d.quotes || []).length;
    }
    async function extractPasted() {
      var t = $('sqPaste').value;
      if (!t.trim()) { say('Nothing to read: drop a file or paste the email first.', true); return; }
      say('Reading the pasted text…');
      try {
        var n = await extract(t, [], 'email', 'pasted text');
        say('Read ' + n + ' priced option' + (n === 1 ? '' : 's') + ' from the pasted text.');
      } catch (e) { say(e.message || String(e), true); }
    }

    // ── the table ──
    var visibleRows = function () {
      var f = fuel();
      return S.rows.filter(function (r) { return !r.fuel || r.fuel === 'unknown' || r.fuel === f; });
    };
    /**
     * The commission that goes in the disclosure: what the desk typed, else the figure the
     * supplier's own documents stated, but only when every document that stated one agreed.
     * Two suppliers quoting different commissions cannot be summed up in one sentence, so the
     * desk is asked instead.
     */
    function docCommission() {
      var vals = S.rows.map(function (r) { return r.com; }).filter(function (v) { return v != null; });
      if (!vals.length) return null;
      var first = vals[0];
      return vals.every(function (v) { return Math.abs(v - first) < 0.0001; }) ? first : null;
    }
    function commissionInForce() { return S.commission != null ? S.commission : docCommission(); }

    function render() {
      var tbl = $('sqTable'); if (!tbl || !S.rows.length) return;
      var gas = fuel() === 'gas';
      var shown = visibleRows();
      var hidden = S.rows.length - shown.length;
      var twoRate = !gas && shown.some(function (r) { return r.night != null; });
      var hasCap = !gas && shown.some(function (r) { return r.cap != null; });
      $('sqTitle').textContent = (gas ? 'Gas' : 'Electricity') + ' Price Analysis';
      var b = $('sqBusiness').value, site = $('sqSite').value, mp = $('sqMpan').value, csd = $('sqCsd').value;
      $('sqSubtitle').textContent = [b, site, mp ? (gas ? 'MPRN ' : 'MPAN ') + mp : '', csd ? 'CSD ' + csd.split('-').reverse().join('/') : '',
        'Date ' + new Date().toLocaleDateString('en-GB')].filter(Boolean).join(' · ');
      var K = kwhBoxes();
      var rows = shown.map(function (r) { return { r: r, annual: annualFor(r, fuel(), K) }; });
      var cur = rows.find(function (x) { return x.r.current; });
      rows.sort(function (a, c) { if (a.r.current) return -1; if (c.r.current) return 1; return (a.annual == null ? 1e18 : a.annual) - (c.annual == null ? 1e18 : c.annual); });
      var cell = function (r, key, dp, cls) {
        var v = r[key], low = r[key + 'Low'];
        var txt = v == null ? '' : Number(v).toFixed(dp);
        return '<td class="edit' + (low ? ' low' : '') + (cls ? ' ' + cls : '') + '" data-id="' + r.id + '" data-key="' + key + '" data-dp="' + dp + '" title="' + (low ? 'Not certain: click to check or correct' : 'click to edit') + '">' + txt + '</td>';
      };
      var head = '<tr><th>Supplier</th><th>Standing Charge<br>p/day</th>' +
        (gas ? '<th>Unit Rate<br>p/kWh</th>' : (twoRate ? '<th>Day Units<br>p/kWh</th><th>Night Units<br>p/kWh</th>' : '<th>Unit Rate<br>p/kWh</th>')) +
        (hasCap ? '<th>Capacity charge<br>p/kVA/month</th>' : '') +
        '<th>Contract Period<br>(months)</th><th>Payment<br>Method</th>' +
        '<th>Approx. Annual<br>Expenditure</th><th>Difference</th><th title="Tick the customer\'s existing contract; remove a row with the cross">Current</th></tr>';
      var body = rows.map(function (x) {
        var r = x.r;
        var diff = (cur && !r.current && x.annual != null && cur.annual != null) ? x.annual - cur.annual : null;
        var rate = gas ? cell(r, r.unit != null ? 'unit' : 'day', 3)
          : twoRate ? (cell(r, r.unit != null ? 'unit' : 'day', 3) + cell(r, 'night', 3))
          : cell(r, r.unit != null ? 'unit' : 'day', 3);
        // The supplier cell shows the SUPPLIER. The model's "product" for an export is usually
        // a sheet title or a term ("Term 3", "36 Months"); it goes in the tooltip.
        var tip = [r.product ? 'Product as written: ' + r.product : '', r.source ? 'From: ' + r.source : '',
          r.com != null ? 'This document states ' + Number(r.com).toFixed(2) + ' p/kWh commission included' :
            (r.comIncluded === true ? 'This document says commission is included, without a figure' :
             r.comIncluded === false ? 'This document says the rates EXCLUDE commission' : ''),
          r.supplierFromHint ? 'Supplier picked by you; the document did not name one' : ''].filter(Boolean).join('\n');
        return '<tr class="' + (r.current ? 'cur' : '') + '">' +
          '<td class="sup edit" data-id="' + r.id + '" data-key="supplier" data-dp="" title="' + esc(tip) + '">' + esc(r.supplier) +
            (r.supplierFromHint ? ' <span class="sq-pick">(picked)</span>' : '') + '</td>' +
          cell(r, 'sc', 2) + rate + (hasCap ? cell(r, 'cap', 2) : '') +
          (r.current ? '<td>Current</td>' : '<td class="edit' + (r.termLow ? ' low' : '') + '" data-id="' + r.id + '" data-key="term" data-dp="0">' + (r.term == null ? '' : r.term) + '</td>') +
          '<td class="edit" data-id="' + r.id + '" data-key="pay" data-dp="">' + esc(r.pay || '') + '</td>' +
          '<td style="font-weight:600">' + money(x.annual) + '</td>' +
          (r.current ? '<td class="diff up">n/a</td>' : '<td class="diff ' + (diff != null && diff < 0 ? 'down' : 'up') + '">' + (diff == null ? '' : (diff < 0 ? '-' : '') + '£' + Math.abs(Math.round(diff)).toLocaleString('en-GB')) + '</td>') +
          '<td style="font-size:11px"><input type="checkbox" class="sq-cur" data-id="' + r.id + '" title="Mark this as the customer\'s current contract" ' + (r.current ? 'checked' : '') + '>' +
          ' <button class="sq-btn ghost xs sq-rm" data-id="' + r.id + '" title="Remove this row" style="margin-left:6px">×</button></td></tr>';
      }).join('');
      tbl.innerHTML = head + body;
      tbl.querySelectorAll('td.edit').forEach(function (td) { td.onclick = function () { edit(td, td.getAttribute('data-id'), td.getAttribute('data-key'), td.getAttribute('data-dp')); }; });
      tbl.querySelectorAll('.sq-cur').forEach(function (cb) { cb.onchange = function () { setCurrent(cb.getAttribute('data-id'), cb.checked); }; });
      tbl.querySelectorAll('.sq-rm').forEach(function (bt) { bt.onclick = function () { remove(bt.getAttribute('data-id')); }; });

      // ── The disclosure, under the quote. CES's words; see DISCLOSURE at the top. ──────
      // The commission is stated here and NOWHERE else: there is no commission column, because
      // the figure belongs in the sentence a customer reads, not in a price table. It is never
      // added to a rate: the supplier's quote already includes it.
      var pkwh = commissionInForce();
      var d = $('sqDisclosure');
      d.innerHTML = '<h4>' + (gas ? 'Gas' : 'Electricity') + ' quotation: important information</h4>' +
        (pkwh == null
          ? esc(disclosureText(fuel(), null, 0)).replace('x.x', '<span class="miss">x.x</span>').replace('£x', '<span class="miss">£x</span>')
          : esc(disclosureText(fuel(), pkwh, totalKwh())));

      var w = $('sqWarn');
      var lows = shown.filter(function (r) { return r.scLow || r.unitLow || r.dayLow || r.nightLow || r.capLow || r.termLow || r.comLow; }).length;
      w.innerHTML = (pkwh == null ? '<div class="sq-note red"><b>No commission figure yet.</b> The disclosure under the table needs it: type what CES earns inside these rates in <b>CES commission (p/kWh)</b> above. Nothing on the table changes; the quotes already include it.</div>' : '') +
        (lows ? '<div class="sq-note red"><b>' + lows + ' row' + (lows === 1 ? ' has' : 's have') + ' a figure the reader was not sure of.</b> Check the red cells against the supplier\'s document, click to correct, then Confirm all.</div>' : '') +
        (hidden ? '<div class="sq-note amber"><b>' + hidden + ' ' + (gas ? 'electricity' : 'gas') + ' option' + (hidden === 1 ? '' : 's') + ' in these documents ' + (hidden === 1 ? 'is' : 'are') + ' not shown.</b> This table is ' + (gas ? 'gas' : 'electricity') + '; switch the Fuel box above to see the other.</div>' : '') +
        ((S.meta.warnings || []).length ? '<div class="sq-note grey">Reader notes: ' + esc(S.meta.warnings.slice(0, 4).join(' · ')) + '</div>' : '') +
        (!cur ? '<div class="sq-note grey">Tick <b>current</b> on the row that is the customer\'s existing contract (or add one) and the Difference column fills in.</div>' : '');
    }
    function edit(td, id, key, dp) {
      var r = S.rows.find(function (x) { return x.id === id; }); if (!r || td.querySelector('input')) return;
      var isText = dp === '' || dp == null;
      var inp = document.createElement('input'); inp.className = 'cell';
      var current = r[key];
      inp.value = current == null ? '' : current;
      if (isText) inp.style.width = '160px';
      td.innerHTML = ''; td.appendChild(inp); inp.focus(); inp.select();
      var done = function () {
        var v = inp.value.trim();
        r[key] = isText ? v : (v === '' ? null : Number(v.replace(/[^0-9.\-]/g, '')));
        r[key + 'Low'] = false;                                        // a broker has looked at it
        if (key === 'supplier') r.supplierFromHint = false;
        render();
      };
      inp.onblur = done;
      inp.onkeydown = function (e) { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.onblur = null; render(); } };
    }
    function confirmAll() { S.rows.forEach(function (r) { ['sc', 'unit', 'day', 'night', 'cap', 'term', 'com'].forEach(function (k) { r[k + 'Low'] = false; }); }); render(); }
    function setCurrent(id, on) { S.rows.forEach(function (r) { r.current = on && r.id === id; }); render(); }
    function remove(id) { S.rows = S.rows.filter(function (r) { return r.id !== id; }); if (!S.rows.length) $('sqResultCard').style.display = 'none'; else render(); }
    function addRow() {
      S.rows.push({ id: 'q' + Math.random().toString(36).slice(2, 8), source: 'typed', supplier: supplierHint() || 'Supplier', product: '', fuel: fuel(),
        term: null, pay: 'DD', sc: null, unit: null, day: null, night: null, cap: null, com: null, comIncluded: null, notes: '', flags: [],
        current: !S.rows.some(function (r) { return r.current; }) });
      $('sqResultCard').style.display = ''; render();
    }
    /**
     * The same view of the data render() draws, as one object: the table's rows in the order
     * they are shown, each with the annual and the difference already worked out. Both the
     * screen and the workbook read this, so the export cannot drift from the screen.
     */
    function currentView() {
      var gas = fuel() === 'gas', K = kwhBoxes();
      var shown = visibleRows().map(function (r) { return { r: r, annual: annualFor(r, fuel(), K) }; });
      var cur = shown.find(function (x) { return x.r.current; });
      shown.sort(function (a, c) { if (a.r.current) return -1; if (c.r.current) return 1; return (a.annual == null ? 1e18 : a.annual) - (c.annual == null ? 1e18 : c.annual); });
      shown.forEach(function (x) {
        x.diff = (cur && !x.r.current && x.annual != null && cur.annual != null) ? x.annual - cur.annual : null;
      });
      var pkwh = commissionInForce();
      var cmp = $('sqCompare');
      return {
        fuel: gas ? 'gas' : 'electricity', rows: shown, kwh: K, commission: pkwh, totalKwh: totalKwh(),
        compare: cmp ? cmp.value : 'Current contract',
        business: $('sqBusiness').value, site: $('sqSite').value, mpan: $('sqMpan').value,
        csd: $('sqCsd').value ? $('sqCsd').value.split('-').reverse().join('/') : '',
        dateText: new Date().toLocaleDateString('en-GB'),
        subtitle: $('sqSubtitle').textContent,
        disclosure: disclosureText(fuel(), pkwh, totalKwh()),
      };
    }
    /**
     * Which figures on the sheet about to be sent are still the reader's guess.
     *
     * A red cell means nobody has checked it against the supplier's document. This sheet goes
     * to a customer, so the broker is told exactly which rows and which figures before it is
     * built, and has to say yes.
     */
    function unconfirmed(view) {
      var names = { sc: 'standing charge', unit: 'unit rate', day: 'day rate', night: 'night rate',
                    cap: 'capacity charge', term: 'contract length', com: 'commission' };
      var out = [];
      view.rows.forEach(function (x) {
        var bad = Object.keys(names).filter(function (k) { return x.r[k + 'Low'] && x.r[k] != null; });
        if (bad.length) out.push((x.r.supplier || 'a row') + (x.r.term ? ' ' + x.r.term + 'm' : '') + ': ' +
          bad.map(function (k) { return names[k]; }).join(', '));
      });
      return out;
    }
    /**
     * Fill CES's own price sheet and hand it over.
     *
     * The first row of the view is the comparison row, and it lands on row 15 of the template,
     * which is the row every Difference formula points at. The rest follow cheapest first, and
     * the block is grown or trimmed so the sheet ends on the last quote with nothing blank
     * underneath it.
     */
    function exportExcel() {
      if (!S.rows.length) { say('Nothing to export yet.', true); return; }
      var v = currentView();
      if (!v.rows.length) { say('Nothing to export on this fuel.', true); return; }
      if (!v.rows[0].r.current) {
        say('Tick "current" on the row that is the customer\'s ' + v.compare.toLowerCase() +
            '. That row is what everything else is compared against on the sheet.', true);
        return;
      }
      var red = unconfirmed(v);
      if (red.length && typeof confirm === 'function' &&
          !confirm('These figures have not been checked against the supplier\'s document:\n\n  ' +
                   red.join('\n  ') + '\n\nThe price sheet goes to the customer. Build it anyway?')) {
        say('Price sheet not built. Click the red figures to correct them, or use Confirm all.', true);
        return;
      }
      var T = TEMPLATES[v.fuel === 'gas' ? 'gas' : 'electricity'];
      say('Building the ' + (v.fuel === 'gas' ? 'gas' : 'electricity') + ' price sheet…');
      $('sqExport').disabled = true;
      // The promise is RETURNED, not just started: a caller that wants to know when the file
      // exists can wait for it, and the test does.
      return fetch(TEMPLATE_BASE + T.file)
        .then(function (r) { if (!r.ok) throw new Error('the price sheet template could not be loaded (HTTP ' + r.status + ')'); return r.arrayBuffer(); })
        .then(function (buf) { return fillPriceSheet(new Uint8Array(buf), v); })
        .then(function (bytes) {
          var who = (v.business || 'Quote').replace(/[^\w &'\-]/g, '').slice(0, 50).trim() || 'Quote';
          var name = who + ' - ' + (v.fuel === 'gas' ? 'Gas' : 'Electricity') + ' Price Sheet - '
            + new Date().toISOString().slice(0, 10) + '.xlsx';
          var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a'); a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          say('Built ' + name + ': ' + v.rows.length + ' row' + (v.rows.length === 1 ? '' : 's') +
              ', ' + v.compare.toLowerCase() + ' first, then cheapest to dearest.');
          S.lastExport = { name: name, bytes: bytes };
        })
        .catch(function (e) { say('Could not build the price sheet: ' + (e.message || e), true); })
        .then(function () { $('sqExport').disabled = false; });
    }
    function clear() {
      S.rows = []; S.meta = {}; S.detected = null;
      $('sqResultCard').style.display = 'none'; $('sqPaste').value = ''; say(''); paintConsumption();
    }

    // ── wiring ──
    var drop = $('sqDrop'), fileIn = $('sqFile');
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function () { drop.classList.remove('over'); };
    drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); stage(e.dataTransfer.files); };
    drop.onclick = function (e) { if (e.target !== fileIn) fileIn.click(); };
    fileIn.onchange = function () { stage(fileIn.files); fileIn.value = ''; };
    var hhd = $('sqHhd'), hhdFile = $('sqHhdFile');
    hhd.ondragover = function (e) { e.preventDefault(); hhd.classList.add('over'); };
    hhd.ondragleave = function () { hhd.classList.remove('over'); };
    hhd.ondrop = function (e) { e.preventDefault(); hhd.classList.remove('over'); hhdDropped(e.dataTransfer.files); };
    hhd.onclick = function (e) { if (e.target !== hhdFile) hhdFile.click(); };
    hhdFile.onchange = function () { hhdDropped(hhdFile.files); hhdFile.value = ''; };
    $('sqReadBtn').onclick = function () { readStaged(); };
    $('sqClearStaged').onclick = function () { S.staged = []; paintStaged(); };
    $('sqReadPasted').onclick = function () { extractPasted(); };
    $('sqConfirmAll').onclick = confirmAll;
    $('sqAddRow').onclick = addRow;
    $('sqClear').onclick = clear;
    $('sqExport').onclick = exportExcel;
    paintConsumption();

    return {
      VERSION: VERSION, state: S, host: host,
      fuel: fuel, fuelChosen: fuelChosen, supplierHint: supplierHint, visibleRows: visibleRows, annualFor: annualFor,
      stage: stage, readStaged: readStaged, textOf: textOf, extract: extract, extractPasted: extractPasted,
      hhdDropped: hhdDropped, readStarkHhd: readStarkHhd, commissionInForce: commissionInForce, kwhBoxes: kwhBoxes,
      currentView: currentView, exportExcel: exportExcel, disclosureText: disclosureText,
      fnErrorMessage: fnErrorMessage, unconfirmed: unconfirmed, totalKwh: totalKwh,
      render: render, addRow: addRow, clear: clear, confirmAll: confirmAll, setCurrent: setCurrent, remove: remove,
      fuelChanged: paintConsumption, paintConsumption: paintConsumption,
    };
  }

  root.SupplierQuotes = { VERSION: VERSION, SUPPLIERS: SUPPLIERS, DISCLOSURE: DISCLOSURE, mount: mount,
    visibleSheets: visibleSheets, workbookText: workbookText, annualFor: annualFor,
    csvRows: csvRows, readStarkHhd: readStarkHhd, disclosureText: disclosureText,
    TEMPLATES: TEMPLATES, TEMPLATE_BASE: TEMPLATE_BASE, fillPriceSheet: fillPriceSheet,
    unzip: unzip, readPart: readPart, rezip: rezip, sheetRows: sheetRows, rowShape: rowShape,
    shiftRows: shiftRows, fillDisclosureStrings: fillDisclosureStrings };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SupplierQuotes;
}
