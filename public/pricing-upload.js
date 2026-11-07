/*
 * pricing-upload.js - the desk's Upload contract page (CES, 8 Nov 2026, build 08a).
 *
 * CES, 7 Nov 2026: "drag and drop a contract in. The claude api will smartly scan the contract and
 * pick out the supplier, customer, mpan/mprn, aq, term and everything and add to the correct
 * portfolio and update the website. Then it will ask if its live yet, locked in, or in awaiting
 * lock in/signed." CES chose REVIEW, THEN ADD: nothing is written until a person has looked.
 *
 *   1. Drop a PDF. pdf.js reads each page's text here, in the browser, and sorts the pages:
 *      a Direct Debit mandate is never sent; a DocuSign certificate and terms and conditions are
 *      left out unless ticked; a scanned page (no text) goes as a picture only when ticked. Sort
 *      codes and account numbers are blanked before anything leaves (and again on the server).
 *   2. Read with Claude: the contract-read edge function (Sonnet 5.5) transcribes; the server
 *      converts the units (p/kWh, p/day, capacity p/kVA/month) and checks every figure against
 *      the text that was sent. A group contract comes back in slices of 15 meters and the page
 *      asks for the rest by itself.
 *   3. Review: every figure in a box, amber where the check could not confirm it, with the words
 *      it came from. The customer is matched on the desk (who holds the meters, the company
 *      number, the name) and the portfolio is the account manager. Contracts already on the desk
 *      for the same meters are shown, and the same deal twice is refused.
 *   4. Live, locked in or awaiting lock-in (signed): CES's question, asked every time, never
 *      guessed. Add writes the deal (crm_add_desk_contract) and files the PDF on it as the
 *      signed contract. When UtilityClick's import later brings the same deal, the desk's row
 *      gives way to UC's and the file moves with it (crm_reconcile_desk_contracts).
 *
 * Mounted by pricing.html on the Upload contract page (pricing team only; the database refuses
 * everyone else regardless). Pure helpers are on ContractUpload._test for the Node tests.
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-08.1';
  var FN = 'contract-read';
  var MAX_SLICES = 6;            // 15 meters a read: 90 meters before it stops and says so
  var MAX_PICTURES = 6;
  var MAX_BYTES = 40 * 1024 * 1024;

  // ------------------------------------------------------------------ pure helpers
  var POUND = String.fromCharCode(163);

  /** Bank details never leave CES: the same rules as the server's maskBank, applied first here. */
  function maskBank(s) {
    return String(s || '')
      .replace(/\b\d{2}[- ]\d{2}[- ]\d{2}\b/g, '[sort code removed]')
      .replace(/(\bacc(?:oun)?t?\.?\s*(?:no\.?|number|num)?\s*[:#]?\s*)(\d(?: ?\d){6,9})(?!\d)/gi, '$1[account number removed]')
      .replace(/\bGB\d{2}\s?[A-Z]{4}(?:\s?\d){14}\b/g, '[IBAN removed]');
  }

  /**
   * What a page is, from its text. A page with bank details AND meter details (a one-page
   * contract with the mandate at the bottom) is still a contract page: it is sent with the bank
   * details blanked. A mandate page on its own is never sent.
   */
  function classifyPage(text) {
    var s = String(text || '');
    var low = s.toLowerCase();
    if (s.replace(/\s/g, '').length < 25) return { kind: 'scan', label: 'No text on this page (a scan?)', send: false };
    var bank = /sort\s*code/.test(low) && /(account\s*(number|no)|bank\s*account|building society)/.test(low);
    var meter = /\b\d{13}\b|\b\d{2}\s\d{4}\s\d{4}\s\d{3}\b|\bmpan\b|\bmprn\b|meter point|supply point|\bspid\b/i.test(s);
    if (bank && /(direct debit|instruction to your bank|originator|service user number)/.test(low) && !meter) {
      return { kind: 'dd', label: 'Direct Debit mandate: never sent', send: false };
    }
    if (/certificate of completion/.test(low)
        || (/docusign/.test(low) && /envelope id/.test(low) && /(signer events|record tracking|envelope originator|electronic record and signature disclosure)/.test(low))) {
      return { kind: 'cert', label: 'DocuSign certificate', send: false };
    }
    var clauses = (s.match(/(^|\n)\s*\d{1,2}\.\d{1,2}(\.\d{1,2})?\s/g) || []).length;
    var words = (s.match(/[A-Za-z]{2,}/g) || []).length;
    if (!meter && (clauses >= 8 || (/terms and conditions|general terms|conditions of (supply|contract)/.test(low) && words > 350))) {
      return { kind: 'terms', label: 'Terms and conditions', send: false };
    }
    if (bank) return { kind: 'contract', label: 'Contract page (its bank details are blanked before sending)', send: true, bank: true };
    return { kind: 'contract', label: 'Contract page', send: true };
  }

  /**
   * The desk's name for the supplier the contract names. The desk's names are UtilityClick's
   * ("BG Lite", "TotalEnergies", "SEFE Energy"); a contract prints its legal name. The duplicate
   * check and the UC reconcile compare these names, so a UC name is picked whenever one fits.
   */
  var SUP_WORDS = /\b(ltd|limited|plc|uk|business|solutions|retail|customers|energy|supply|supplies|services|the|co|company|group|gb)\b/g;
  function supKey(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\b\d+\b/g, ' ').replace(SUP_WORDS, ' ').replace(/\s+/g, ' ').trim();
  }
  var SUP_ALIAS = {
    'british gas lite': 'BG Lite', 'bg lite': 'BG Lite', 'british gas': 'British Gas', 'british gas plus': 'BG Plus',
    'totalenergies gas and power': 'TotalEnergies', 'total gas and power': 'TotalEnergies', 'totalenergies': 'TotalEnergies',
    'sefe': 'SEFE Energy', 'gazprom': 'SEFE Energy', 'e on next': 'E.ON Next', 'eon next': 'E.ON Next', 'e on': 'E.ON Energy',
    'scottishpower': 'Scottish Power', 'scottish power': 'Scottish Power', 'pozitive': 'PE Solutions', 'pe solutions': 'PE Solutions',
    'smartestenergy': 'Smartest Energy Business', 'smartest': 'Smartest Energy Business', 'united gas and power': 'United Gas & Power',
    'ugp': 'United Gas & Power', 'crown gas and power': 'Crown Gas & Power', 'npower': 'Npower', 'edf': 'EDF Energy', 'sse': 'SSE',
    'corona': 'Corona Energy', 'yu': 'Yu Energy', 'drax': 'Drax', 'haven power': 'Drax', 'brook green': 'Brook Green Supply',
    'opus': 'Opus Energy', 'engie': 'Engie', 'octopus': 'Octopus Energy', 'ecotricity': 'Ecotricity', 'utilita': 'Utilita Energy',
    'regent gas': 'Regent Gas', 'marble power': 'Marble Power', 'castle water': 'Castle Water', 'water plus': 'Water Plus',
    'wave': 'Wave', 'everflow': 'Everflow Water', 'everflow water': 'Everflow Water', 'ses water': 'SES Water', 'shell': 'Shell Energy',
    'water business': 'Water2Business', 'good': 'Good Energy', 'valda': 'Valda Energy', 'd energi': 'D-ENERGi',
  };
  function supplierMatch(read, names) {
    var list = (names || []).map(function (n) { return typeof n === 'string' ? n : n.supplier; }).filter(Boolean);
    if (!read || !String(read).trim()) return null;
    var exact = list.find(function (n) { return n.toLowerCase() === String(read).trim().toLowerCase(); });
    if (exact) return exact;
    var k = supKey(read);
    if (!k) return null;
    var alias = SUP_ALIAS[k];
    if (alias && list.indexOf(alias) >= 0) return alias;
    var same = list.filter(function (n) { return supKey(n) === k; });
    if (same.length) return same[0];
    // "E.ON Next Energy Limited" keys "e on next": a desk name whose key starts the read's, or
    // the other way round, longest first so "british gas lite" beats "british gas".
    var part = list.map(function (n) { return { n: n, k: supKey(n) }; })
      .filter(function (x) { return x.k.length >= 3 && (k.indexOf(x.k + ' ') === 0 || k === x.k || x.k.indexOf(k + ' ') === 0); })
      .sort(function (a, b) { return b.k.length - a.k.length; });
    if (part.length) return part[0].n;
    for (var a in SUP_ALIAS) { if (k.indexOf(a + ' ') === 0 && list.indexOf(SUP_ALIAS[a]) >= 0) return SUP_ALIAS[a]; }
    return null;
  }

  var MPAN_PRIMES = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];
  function mpanOk(core) {
    var s = String(core || '');
    if (!/^\d{13}$/.test(s)) return false;
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += Number(s[i]) * MPAN_PRIMES[i];
    return (sum % 11) % 10 === Number(s[12]);
  }
  function keyOk(fuel, key) {
    var k = String(key || '').replace(/\s/g, '');
    if (fuel === 'electricity') return mpanOk(k);
    if (fuel === 'gas') return /^\d{6,10}$/.test(k);
    if (fuel === 'water') return k.length >= 5;
    return false;
  }
  var REG_LABEL = { single: 'Single rate', day_night: 'Day / night', eve_weekend: 'Day / evening-weekend',
                    day_night_ew: 'Day / night / evening-weekend', off_peak: 'Off-peak only' };
  var STATUS = [['live', 'Live', 'supplying now'], ['locked_in', 'Locked in', 'price fixed, not live yet'],
                ['awaiting', 'Awaiting lock-in', 'signed, the supplier has not confirmed the price']];

  function num(v) { if (v == null || String(v).trim() === '') return null; var n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
  function val(f) { return f && f.value != null ? f.value : ''; }

  /** One meter of the read, as the boxes on the page. */
  function meterForm(m) {
    var F = m.fields || {};
    var top = [m.profile_class != null ? String(m.profile_class).padStart(2, '0') : '', m.ssc || m.mtc || '', m.llfc || ''];
    return {
      include: true, fuel: m.fuel, mpan: val(F.meter_number), printed: (F.meter_number && F.meter_number.printed) || '',
      site_name: val(F.site_name), site_address: val(F.site_address), postcode: val(F.site_postcode),
      start: val(F.start_date), end: val(F.end_date), term: val(F.term_months),
      aq: val(F.annual_consumption), unit: val(F.unit_rate), day: val(F.day_rate), night: val(F.night_rate),
      ew: val(F.evening_weekend_rate), sc: val(F.standing_charge), capacity: val(F.capacity_charge), kva: val(F.capacity_kva),
      pc: top[0], ssc: top[1], llfc: top[2], hh: !!m.hh, registers: m.registers || '',
      checks: {
        mpan: F.meter_number, site_name: F.site_name, site_address: F.site_address, postcode: F.site_postcode, start: F.start_date,
        end: F.end_date, term: F.term_months, aq: F.annual_consumption, unit: F.unit_rate, day: F.day_rate, night: F.night_rate,
        ew: F.evening_weekend_rate, sc: F.standing_charge, capacity: F.capacity_charge, kva: F.capacity_kva,
      },
      touched: {}, problems: (m.problems || []).slice(), existing: [],
    };
  }

  /** Slices of one contract into one: the first read's document fields, every slice's meters once. */
  function mergeReads(reads) {
    var out = null, seen = {};
    (reads || []).forEach(function (c) {
      if (!c) return;
      if (!out) { out = JSON.parse(JSON.stringify(c)); out.meters = []; out.problems = (c.problems || []).filter(function (p) { return !/no (more )?meters found/.test(p); }); }
      (c.meters || []).forEach(function (m) {
        var k = m.fuel + '|' + (m.fields && m.fields.meter_number && m.fields.meter_number.value);
        if (seen[k]) return;
        seen[k] = 1; out.meters.push(m);
      });
      out.meter_count = Math.max(out.meter_count || 0, c.meter_count || 0);
      out.more_meters = c.more_meters || 0;
    });
    if (out && !out.meters.length) out.problems.push('no meters found');
    return out;
  }

  /** Which existing desk contracts are this deal already (same meter, same supplier, start within 7 days). */
  function sameDeal(existing, supplier, start, names) {
    if (!existing || !start) return false;
    var a = supplierMatch(existing.supplier, names) || existing.supplier, b = supplierMatch(supplier, names) || supplier;
    if (String(a || '').toLowerCase() !== String(b || '').toLowerCase()) return false;
    var d = Math.abs(Date.parse(existing.meter_start) - Date.parse(start)) / 864e5;
    return d <= 7;
  }

  /** Every reason Add cannot go yet, in the page's words. Empty means it can. */
  function blockers(F) {
    var out = [];
    if (!F.status) out.push('Say whether it is live, locked in or awaiting lock-in.');
    var sup = F.supplier === '__other' ? String(F.supplierOther || '').trim() : F.supplier;
    if (!sup) out.push('Pick the supplier.');
    if (F.customer === 'new') {
      if (String(F.newCust.name || '').trim().length < 2) out.push('The new customer needs a name.');
      if (!F.am) out.push('Pick the portfolio (account manager) for the new customer.');
    } else if (!F.customer) out.push('Pick the customer, or add a new one.');
    var inc = F.meters.filter(function (m) { return m.include; });
    if (!inc.length) out.push('Include at least one meter.');
    inc.forEach(function (m, i) {
      var id = m.mpan || ('meter ' + (i + 1));
      if (!keyOk(m.fuel, m.mpan)) out.push(id + ': ' + (m.fuel === 'electricity' ? 'not a valid MPAN (13 digits, check digit)' : m.fuel === 'gas' ? 'an MPRN is 6 to 10 digits' : m.fuel === 'water' ? 'the supply point id is needed' : 'pick electricity, gas or water') + '.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.start || ''))) out.push(id + ': the start date is needed.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.end || '')) && !(num(m.term) > 0)) out.push(id + ': the end date or the term is needed.');
      if (m.end && m.start && m.end <= m.start) out.push(id + ': the end date is before the start.');
    });
    var seen = {};
    inc.forEach(function (m) { var k = String(m.mpan || '').replace(/\s/g, ''); if (k && seen[k]) out.push(k + ' is listed twice.'); seen[k] = 1; });
    var c = num(F.commission);
    if (String(F.commission || '').trim() !== '' && (c == null || c < 0 || c > 10)) out.push('The commission is p/kWh, between 0 and 10.');
    if (amberLeft(F) && !F.confirmed) out.push('Tick that the amber boxes have been checked against the contract.');
    return out;
  }
  /** Amber boxes on included meters nobody has touched. */
  function amberLeft(F) {
    var n = 0;
    F.meters.forEach(function (m) {
      if (!m.include) return;
      Object.keys(m.checks).forEach(function (k) { var c = m.checks[k]; if (c && c.status === 'check' && !m.touched[k]) n++; });
    });
    ['supplier', 'customer_name', 'signed_date'].forEach(function (k) { var c = F.docChecks[k]; if (c && c.status === 'check' && !F.docTouched[k]) n++; });
    return n;
  }

  /** What crm_add_desk_contract is sent. */
  function payloadOf(F, readId, by) {
    var sup = F.supplier === '__other' ? String(F.supplierOther || '').trim() : F.supplier;
    return {
      status: F.status, supplier: sup, product: String(F.product || '').trim() || null, signed_date: F.signed_date || null,
      commission_p_kwh: num(F.commission), payment_terms: String(F.payment_terms || '').trim() || null,
      account_manager: F.am || null, read_id: readId || null, by: by || null,
      customer: F.customer === 'new'
        ? { new: { name: String(F.newCust.name || '').trim(), company_reg_number: String(F.newCust.company_reg_number || '').trim() || null,
                   registered_address: String(F.newCust.registered_address || '').trim() || null,
                   registered_postcode: String(F.newCust.registered_postcode || '').trim() || null,
                   allow_duplicate: !!F.newCust.allow_duplicate } }
        : { uc_customer_id: F.customer },
      meters: F.meters.filter(function (m) { return m.include; }).map(function (m) {
        var t = num(m.term);
        return { mpan: String(m.mpan || '').replace(/\s/g, ''), fuel: m.fuel, start: m.start, end: m.end || null,
                 term_months: t != null ? Math.round(t) : null, aq: num(m.aq), unit: num(m.unit), day: num(m.day), night: num(m.night),
                 ew: num(m.ew), sc: num(m.sc), capacity: num(m.capacity), kva: num(m.kva),
                 site_name: String(m.site_name || '').trim() || null, site_address: String(m.site_address || '').trim() || null,
                 postcode: String(m.postcode || '').trim() || null,
                 profile_class: m.fuel === 'electricity' && String(m.pc || '').trim() !== '' ? Number(m.pc) : null,
                 hh: !!m.hh, registers: m.fuel === 'electricity' ? (m.registers || null) : 'single',
                 ssc: m.fuel === 'electricity' ? (String(m.ssc || '').trim() || null) : null,
                 llfc: m.fuel === 'electricity' ? (String(m.llfc || '').trim() || null) : null };
      }),
    };
  }

  /** supabase-js hides a function's own error in error.context: read it and say what it means. */
  function fnErrorWords(status, body, raw) {
    var said = body && (body.error || body.message) ? String(body.error || body.message) : '';
    var detail = body && body.detail ? String(body.detail) : '';
    var m = detail.match(/^model (\d+)/);
    if (m) {
      var s = Number(m[1]);
      if (s === 401 || s === 403) return 'The AI service refused CES\'s API key. Ask whoever looks after the Supabase secrets to check ANTHROPIC_API_KEY.';
      if (s === 429) return 'The AI service is rate limiting us. Wait a minute and read again.';
      if (s === 408) return 'The read ran out of time. Untick the terms pages, or tick fewer scanned pages, and read again.';
      if (s >= 500) return 'The AI service had an error (' + s + '). Read again in a moment.';
      return 'The AI service said no (' + s + '): ' + detail.slice(0, 200);
    }
    if (status === 401) return 'Your session has expired: reload the page and sign in again.';
    if (status === 403) return said || 'Reading contracts is for the pricing team.';
    if (status === 413) return 'That is too much to send in one read: untick some pages.';
    if (status === 429) return said || 'That is the day\'s limit of reads for this login.';
    if (status === 503) return said || 'The reader is not set up yet.';
    if (status === 504 || status === 546) return 'The read ran out of time. Untick the terms pages and read again.';
    if (said) return said + (detail ? ' (' + detail.slice(0, 200) + ')' : '');
    if (status) return 'The reader answered HTTP ' + status + (raw ? ': ' + String(raw).slice(0, 160) : '');
    return 'The reader could not be reached.';
  }

  // ------------------------------------------------------------------ styles
  var STYLES = [
    '.cu-drop{border:2px dashed var(--line-2,#c9d3e6);border-radius:12px;padding:34px 18px;text-align:center;cursor:pointer;background:var(--panel,#fff)}',
    '.cu-drop.over{border-color:var(--cyan-dim,#2f6fd6);background:var(--cyan-glow,#eef4ff)}',
    '.cu-drop b{font-size:15px}',
    '.cu-pages{width:100%;border-collapse:collapse;font-size:12.5px}',
    '.cu-pages td,.cu-pages th{padding:6px 8px;border-bottom:1px solid var(--line,#e3e8f2);text-align:left;vertical-align:top}',
    '.cu-prev{color:var(--muted,#6b7894);max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cu-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 12px}',
    '@media (max-width:900px){.cu-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.cu-f label{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2,#4a5672);margin-bottom:3px}',
    '.cu-f input,.cu-f select{width:100%;box-sizing:border-box}',
    '.cu-f.check input,.cu-f.check select{border-color:var(--warn,#b26a00);background:var(--warn-bg,#fff7e6)}',
    '.cu-f.missing input{background:var(--panel-2,#f6f8fc)}',
    '.cu-flag{font-size:11px;color:var(--warn,#8a5300);margin-top:3px;line-height:1.3}',
    '.cu-src{font-size:10.5px;color:var(--muted,#6b7894);margin-top:2px;overflow-wrap:anywhere}',
    '.cu-card{border:1px solid var(--line,#e3e8f2);border-radius:12px;padding:14px 16px;margin:0 0 12px;background:var(--panel,#fff)}',
    '.cu-card.off{opacity:.55}',
    '.cu-card h3{margin:0 0 10px;font-size:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.cu-exist{font-size:12px;margin:0 0 10px}',
    '.cu-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    // The desk styles every label as a small uppercase caption and every input as a full-width box:
    // undone here for the page's own choice rows, radios and ticks.
    '.cu-root .cu-opt,.cu-root .cu-check{display:flex;gap:10px;align-items:flex-start;text-transform:none;letter-spacing:0;font-size:13px;font-weight:400;color:var(--text,#1d2a4d);margin:0}',
    '.cu-root input[type=radio],.cu-root input[type=checkbox]{width:16px;height:16px;flex:none;margin:2px 0 0;padding:0;box-shadow:none}',
    '.cu-root .cu-cust .cu-opt{padding:8px 10px;border:1px solid var(--line,#e3e8f2);border-radius:10px;margin:0 0 6px;cursor:pointer}',
    '.cu-root .cu-cust .cu-opt.on{border-color:var(--cyan-dim,#2f6fd6);background:var(--cyan-glow,#eef4ff)}',
    '.cu-root .cu-card h3 .cu-check{font-weight:700}',
    '.cu-status{display:flex;gap:10px;flex-wrap:wrap}',
    '.cu-root .cu-status label{display:block;flex:1;min-width:180px;border:1px solid var(--line,#e3e8f2);border-radius:10px;padding:10px 12px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:13px;font-weight:400;color:var(--text,#1d2a4d);margin:0}',
    '.cu-status label.on{border-color:var(--cyan-dim,#2f6fd6);background:var(--cyan-glow,#eef4ff)}',
    '.cu-status b{display:block;font-size:13.5px}',
    '.cu-status span{font-size:11.5px;color:var(--text-2,#4a5672)}',
    '.cu-sticky{border-top:1px solid var(--line,#e3e8f2);padding:12px 0 4px;margin-top:8px}',
    '.cu-block{font-size:12.5px;color:var(--fail,#b42318);margin:6px 0 0;padding-left:18px}',
  ].join('\n');
  function injectStyles(doc) {
    if (!doc || doc.getElementById('cuStyles')) return;
    var s = doc.createElement('style'); s.id = 'cuStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }

  // ------------------------------------------------------------------ the page
  function mount(host, opts) {
    var sb = opts.sb, esc = opts.esc, doc = host.ownerDocument || root.document;
    var who = opts.who || function () { return ''; };
    injectStyles(doc);
    var S = { step: 'drop', file: null, sha: '', pages: [], pdf: null, reads: [], readIds: [], contract: null, model: '',
              ms: 0, earlier: null, match: null, names: [], ams: [], F: null, msg: '', err: '', busy: false, left: null, done: null };

    function q(builder, what) {
      return Promise.resolve(builder).then(function (r) {
        if (r && r.error) throw new Error(what + ': ' + r.error.message);
        return r ? r.data : null;
      });
    }
    function uk(d) { if (!d) return ''; var p = String(d).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(d); }
    function $(id) { return doc.getElementById(id); }

    function paint() {
      var h = '';
      h += '<div class="card cu-root" style="max-width:1180px">';
      if (S.err) h += '<div class="note bad" style="margin:0 0 12px">' + esc(S.err) + '</div>';
      if (S.msg && S.step !== 'reading') h += '<div class="note" style="margin:0 0 12px">' + esc(S.msg) + '</div>';
      if (S.step === 'drop') h += paintDrop();
      else if (S.step === 'pages') h += paintPages();
      else if (S.step === 'reading') h += '<div class="note">' + esc(S.msg || 'Reading the contract...') + '</div>';
      else if (S.step === 'review' || S.step === 'adding') h += paintReview();
      else if (S.step === 'done') h += paintDone();
      h += '</div>';
      host.innerHTML = h;
      wire();
    }

    function paintDrop() {
      return '<p style="margin:0 0 12px;font-size:13px;color:var(--text-2)">Drop a signed supply contract (PDF). Claude reads it, '
        + 'you check what it read, say whether it is live, locked in or awaiting lock-in, and it goes on the customer\'s page. '
        + 'Nothing is added until you press Add.</p>'
        + '<div class="cu-drop" id="cuDrop" tabindex="0" role="button" aria-label="Choose a contract PDF">'
        + '<b>Drop a contract here</b><div style="font-size:12.5px;color:var(--muted);margin-top:6px">or click to choose a PDF</div></div>'
        + '<input type="file" id="cuFile" accept="application/pdf,.pdf" class="hide" style="display:none">'
        + '<p style="font-size:11.5px;color:var(--muted);margin:10px 0 0">A Direct Debit mandate page is never sent, and sort codes and account numbers are blanked before anything leaves the desk.</p>';
    }

    function paintPages() {
      var sendN = S.pages.filter(function (p) { return p.send && p.kind !== 'scan'; }).length;
      var picN = S.pages.filter(function (p) { return p.send && p.kind === 'scan'; }).length;
      var allScan = S.pages.length && S.pages.every(function (p) { return p.kind === 'scan'; });
      var h = '<div class="cu-row" style="justify-content:space-between;margin:0 0 10px"><div><b>' + esc(S.file.name) + '</b> '
        + '<span style="color:var(--muted);font-size:12px">' + S.pages.length + ' page' + (S.pages.length === 1 ? '' : 's') + '</span></div>'
        + '<button class="act ghost sm" data-cu="restart">Choose another file</button></div>';
      if (S.earlier) {
        var e = S.earlier;
        h += '<div class="note' + (e.added_at ? ' warn' : '') + '" style="margin:0 0 12px">'
          + (e.added_at ? '<b>This file was added on ' + esc(uk(e.added_at)) + ' by ' + esc(e.added_by_name || 'someone') + '.</b> Adding it again is refused if it is the same deal. '
                        : 'This file was read on ' + esc(uk(e.created_at)) + ' by ' + esc(e.by_name || 'someone') + '. ')
          + '<button class="act sm" data-cu="earlier">Use that read</button> <span style="font-size:12px;color:var(--muted)">(no new read, no cost)</span></div>';
      }
      if (allScan) h += '<div class="note warn" style="margin:0 0 12px">This PDF is scanned: there is no text in it. Tick the pages with the customer and meter details (up to ' + MAX_PICTURES + ') to send them as pictures.</div>';
      h += '<table class="cu-pages"><thead><tr><th style="width:60px">Send</th><th style="width:60px">Page</th><th style="width:260px">What it is</th><th>Starts with</th></tr></thead><tbody>';
      S.pages.forEach(function (p, i) {
        var never = p.kind === 'dd';
        h += '<tr><td><input type="checkbox" data-page="' + i + '"' + (p.send ? ' checked' : '') + (never ? ' disabled' : '') + ' aria-label="Send page ' + p.n + '"></td>'
          + '<td>' + p.n + '</td><td>' + esc(p.label) + (p.kind === 'scan' ? ' <span class="pill p-mute">as a picture</span>' : '') + '</td>'
          + '<td class="cu-prev">' + esc(p.preview) + '</td></tr>';
      });
      h += '</tbody></table>';
      h += '<div class="cu-row" style="margin-top:14px"><button class="act" data-cu="read"' + (sendN + picN ? '' : ' disabled') + '>Read with Claude</button>'
        + '<span style="font-size:12px;color:var(--muted)">' + sendN + ' page' + (sendN === 1 ? '' : 's') + ' of text'
        + (picN ? ', ' + picN + ' picture' + (picN === 1 ? '' : 's') : '') + '. About 5p a read.'
        + (S.left != null ? ' ' + S.left + ' reads left today.' : '') + '</span></div>';
      return h;
    }

    function fieldBox(label, key, value, check, touched, extra) {
      var st = check && !touched ? check.status : (String(value || '') === '' ? 'missing' : 'ok');
      var flags = check && !touched && check.status === 'check' ? (check.flags || []).join('; ') : '';
      var src = check && check.source ? check.source : '';
      return '<div class="cu-f ' + (st === 'check' ? 'check' : st === 'missing' ? 'missing' : '') + '">'
        + '<label>' + esc(label) + '</label>'
        + '<input data-k="' + key + '" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + (src ? ' title="From: ' + esc(src) + '"' : '') + '>'
        + (flags ? '<div class="cu-flag">' + esc(flags) + '</div>' : '')
        + (src && st === 'check' ? '<div class="cu-src">From: &ldquo;' + esc(src) + '&rdquo;</div>' : '')
        + '</div>';
    }

    function paintReview() {
      var F = S.F, c = S.contract;
      var h = '';
      h += '<div class="cu-row" style="justify-content:space-between;margin:0 0 10px"><div><b>' + esc(S.file ? S.file.name : 'Contract') + '</b> '
        + '<span style="color:var(--muted);font-size:12px">read by ' + esc(S.model || 'Claude') + (S.ms ? ' in ' + Math.round(S.ms / 1000) + ' s' : '') + '</span></div>'
        + '<button class="act ghost sm" data-cu="restart">Start again</button></div>';
      if (c && c.problems && c.problems.length) {
        h += '<div class="note warn" style="margin:0 0 12px"><b>The reader says:</b> ' + esc(c.problems.join('; ')) + '</div>';
      }
      if (c && c.more_meters) {
        h += '<div class="note warn" style="margin:0 0 12px">This contract lists ' + c.meter_count + ' meters and ' + F.meters.length
          + ' were read. <button class="act sm" data-cu="more">Read the next ' + Math.min(15, c.more_meters) + '</button></div>';
      }
      if (c && c.notes) h += '<div class="note" style="margin:0 0 12px"><b>Reader\'s note:</b> ' + esc(c.notes) + '</div>';

      // -- the contract
      var dc = F.docChecks;
      h += '<div class="cu-card"><h3>The contract</h3><div class="cu-grid">';
      h += '<div class="cu-f' + (dc.supplier && dc.supplier.status === 'check' && !F.docTouched.supplier ? ' check' : '') + '"><label>Supplier</label><select data-d="supplier">'
        + '<option value="">Pick the supplier</option>'
        + S.names.map(function (n) { return '<option' + (n.supplier === F.supplier ? ' selected' : '') + '>' + esc(n.supplier) + '</option>'; }).join('')
        + '<option value="__other"' + (F.supplier === '__other' ? ' selected' : '') + '>Another supplier (as written)</option></select>'
        + (F.supplier === '__other' ? '<input data-d="supplierOther" style="margin-top:6px" value="' + esc(F.supplierOther) + '">' : '')
        + '<div class="cu-src">On the contract: &ldquo;' + esc(val(dc.supplier)) + '&rdquo;</div></div>';
      h += '<div class="cu-f"><label>Product</label><input data-d="product" value="' + esc(F.product) + '"></div>';
      h += '<div class="cu-f' + (dc.signed_date && dc.signed_date.status === 'check' && !F.docTouched.signed_date ? ' check' : '') + '"><label>Signed</label><input type="date" data-d="signed_date" value="' + esc(F.signed_date) + '"></div>';
      h += '<div class="cu-f"><label>Commission (p/kWh)</label><input data-d="commission" inputmode="decimal" value="' + esc(F.commission) + '" placeholder="CES uplift, if known"></div>';
      h += '<div class="cu-f"><label>Payment</label><input data-d="payment_terms" value="' + esc(F.payment_terms) + '"></div>';
      h += '</div></div>';

      // -- the customer
      var M = S.match || { customers: [] };
      h += '<div class="cu-card cu-cust"><h3>The customer <span style="font-weight:400;font-size:12px;color:var(--muted)">on the contract: &ldquo;' + esc(val(dc.customer_name)) + '&rdquo;'
        + (val(c && c.fields && c.fields.company_number) ? ', company ' + esc(val(c.fields.company_number)) : '') + '</span></h3>';
      (M.customers || []).forEach(function (x) {
        var why = [];
        if ((x.mpans || []).length) why.push('holds ' + x.mpans.join(', '));
        if (x.same_company) why.push('same company number');
        if (x.same_name) why.push('same name'); else if (x.like_name) why.push('a similar name');
        h += '<label class="cu-opt' + (F.customer === x.uc_customer_id ? ' on' : '') + '"><input type="radio" name="cuCust" value="' + esc(x.uc_customer_id) + '"' + (F.customer === x.uc_customer_id ? ' checked' : '') + '>'
          + '<span><b>' + esc(x.name) + '</b> <span style="font-size:12px;color:var(--text-2)">' + esc(x.account_manager || 'Unassigned') + (x.postcode ? ' &middot; ' + esc(x.postcode) : '') + '</span>'
          + '<br><span style="font-size:11.5px;color:var(--muted)">' + esc(why.join('; ')) + '</span></span></label>';
      });
      h += '<label class="cu-opt' + (F.customer === 'new' ? ' on' : '') + '"><input type="radio" name="cuCust" value="new"' + (F.customer === 'new' ? ' checked' : '') + '>'
        + '<span style="flex:1"><b>A new customer</b>' + (F.customer === 'new' ? '<div class="cu-grid" style="margin-top:8px">'
          + '<div class="cu-f"><label>Name</label><input data-n="name" value="' + esc(F.newCust.name) + '"></div>'
          + '<div class="cu-f"><label>Company number</label><input data-n="company_reg_number" value="' + esc(F.newCust.company_reg_number) + '"></div>'
          + '<div class="cu-f"><label>Registered address</label><input data-n="registered_address" value="' + esc(F.newCust.registered_address) + '"></div>'
          + '<div class="cu-f"><label>Postcode</label><input data-n="registered_postcode" value="' + esc(F.newCust.registered_postcode) + '"></div></div>' : '')
        + '</span></label>';
      var cur = (M.customers || []).find(function (x) { return x.uc_customer_id === F.customer; });
      h += '<div class="cu-row" style="margin-top:8px"><div class="cu-f" style="min-width:260px"><label>Portfolio (account manager)</label><select data-d="am"><option value="">'
        + (F.customer === 'new' ? 'Pick the portfolio' : 'The customer\'s own (' + esc((cur && cur.account_manager) || 'Unassigned') + ')') + '</option>'
        + S.ams.map(function (a) { return '<option' + (a === F.am ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select></div>'
        + (cur && F.am && F.am !== cur.account_manager ? '<span style="font-size:12px;color:var(--text-2)">This deal goes to ' + esc(F.am) + '; the customer stays in ' + esc(cur.account_manager || 'Unassigned') + '\'s portfolio.</span>' : '')
        + '</div></div>';

      // -- the meters
      F.meters.forEach(function (m, i) {
        var ex = m.existing || [];
        h += '<div class="cu-card' + (m.include ? '' : ' off') + '" data-m="' + i + '"><h3><label class="cu-check" style="align-items:center">'
          + '<input type="checkbox" data-inc="' + i + '"' + (m.include ? ' checked' : '') + '> Meter ' + (i + 1) + '</label>'
          + '<span class="mono" style="font-size:13px">' + esc(m.mpan || '') + '</span>'
          + '<span class="pill p-mute">' + esc(m.fuel) + '</span>'
          + (m.duplicate ? '<span class="pill p-fail">already on the desk</span>' : '') + '</h3>';
        if (ex.length) {
          h += '<div class="cu-exist">' + ex.map(function (k) {
            return (k.dup ? '<b style="color:var(--fail)">Already on the desk:</b> ' : 'On the desk: ')
              + esc(k.supplier || '') + ' ' + esc(uk(k.meter_start)) + ' to ' + esc(uk(k.meter_end)) + ' (' + esc(k.status || 'no status') + ', ' + esc(k.customer_name || '') + ')';
          }).join('<br>') + '</div>';
        }
        if ((m.problems || []).length) h += '<div class="cu-flag" style="margin:0 0 8px">' + esc(m.problems.join('; ')) + '</div>';
        var C = m.checks, T = m.touched;
        h += '<div class="cu-grid">';
        h += fieldBox(m.fuel === 'gas' ? 'MPRN' : m.fuel === 'water' ? 'Supply point id' : 'MPAN (13-digit core)', 'mpan', m.mpan, C.mpan, T.mpan, ' class="mono"');
        h += '<div class="cu-f"><label>Fuel</label><select data-k="fuel">' + ['electricity', 'gas', 'water'].map(function (f) { return '<option' + (f === m.fuel ? ' selected' : '') + '>' + f + '</option>'; }).join('')
          + (['electricity', 'gas', 'water'].indexOf(m.fuel) < 0 ? '<option value="" selected>Pick one</option>' : '') + '</select></div>';
        h += fieldBox('Site name', 'site_name', m.site_name, C.site_name, T.site_name);
        h += fieldBox('Postcode', 'postcode', m.postcode, C.postcode, T.postcode);
        h += fieldBox('Start', 'start', m.start, C.start, T.start, ' type="date"');
        h += fieldBox('End', 'end', m.end, C.end, T.end, ' type="date"');
        h += fieldBox('Term (months)', 'term', m.term, C.term, T.term, ' inputmode="numeric"');
        h += fieldBox(m.fuel === 'water' ? 'Annual use (m3)' : 'Annual use (kWh)', 'aq', m.aq, C.aq, T.aq, ' inputmode="decimal"');
        var regs = m.fuel === 'electricity' ? (m.registers || '') : 'single';
        var show = { unit: regs === 'single' || regs === '' || m.unit !== '', day: /day/.test(regs) || m.day !== '', night: /night|off_peak/.test(regs) || m.night !== '', ew: /ew|eve/.test(regs) || m.ew !== '' };
        if (show.unit) h += fieldBox('Unit rate (p/kWh)', 'unit', m.unit, C.unit, T.unit, ' inputmode="decimal"');
        if (show.day) h += fieldBox('Day (p/kWh)', 'day', m.day, C.day, T.day, ' inputmode="decimal"');
        if (show.night) h += fieldBox('Night (p/kWh)', 'night', m.night, C.night, T.night, ' inputmode="decimal"');
        if (show.ew) h += fieldBox('Evening / weekend (p/kWh)', 'ew', m.ew, C.ew, T.ew, ' inputmode="decimal"');
        h += fieldBox('Standing charge (p/day)', 'sc', m.sc, C.sc, T.sc, ' inputmode="decimal"');
        if (m.fuel === 'electricity') {
          h += fieldBox('Capacity (p/kVA/month)', 'capacity', m.capacity, C.capacity, T.capacity, ' inputmode="decimal"');
          h += fieldBox('Capacity (kVA)', 'kva', m.kva, C.kva, T.kva, ' inputmode="decimal"');
          h += '<div class="cu-f"><label>Meter type</label><select data-k="registers"><option value="">Not known</option>'
            + Object.keys(REG_LABEL).map(function (r) { return '<option value="' + r + '"' + (r === m.registers ? ' selected' : '') + '>' + esc(REG_LABEL[r]) + '</option>'; }).join('') + '</select></div>';
          h += '<div class="cu-f"><label>Profile class</label><input data-k="pc" value="' + esc(m.pc) + '" inputmode="numeric" maxlength="2"></div>';
          h += '<div class="cu-f"><label>MTC / SSC</label><input data-k="ssc" value="' + esc(m.ssc) + '" class="mono" maxlength="4"></div>';
          h += '<div class="cu-f"><label>LLFC</label><input data-k="llfc" value="' + esc(m.llfc) + '" class="mono" maxlength="3"></div>';
          h += '<div class="cu-f"><label>Half-hourly</label><label class="cu-check" style="align-items:center"><input type="checkbox" data-k="hh"' + (m.hh ? ' checked' : '') + '> HH meter</label></div>';
        }
        h += '</div>';
        if (m.printed && m.printed.replace(/\s/g, '') !== String(m.mpan || '')) h += '<div class="cu-src" style="margin-top:6px">Printed as: ' + esc(m.printed) + '</div>';
        h += '</div>';
      });

      // -- the question, and Add
      h += '<div class="cu-card"><h3>Is it live yet?</h3><div class="cu-status">' + STATUS.map(function (s) {
        return '<label class="' + (F.status === s[0] ? 'on' : '') + '"><input type="radio" name="cuStatus" value="' + s[0] + '"' + (F.status === s[0] ? ' checked' : '') + ' style="margin-right:6px">'
          + '<b style="display:inline">' + esc(s[1]) + '</b><span style="display:block">' + esc(s[2]) + '</span></label>';
      }).join('') + '</div></div>';
      var amber = amberLeft(F);
      var bl = blockers(F);
      h += '<div class="cu-sticky">';
      if (amber) h += '<label class="cu-check" style="align-items:center;margin:0 0 8px"><input type="checkbox" data-d="confirmed"' + (F.confirmed ? ' checked' : '') + '> '
        + amber + ' amber box' + (amber === 1 ? '' : 'es') + ' not changed: I have checked ' + (amber === 1 ? 'it' : 'them') + ' against the contract.</label>';
      h += '<div class="cu-row"><button class="act" data-cu="add"' + (bl.length || S.busy ? ' disabled' : '') + '>' + (S.step === 'adding' ? 'Adding...' : 'Add to the desk') + '</button>'
        + '<span style="font-size:12px;color:var(--muted)">' + F.meters.filter(function (m) { return m.include; }).length + ' meter(s), the PDF filed as the signed contract.</span></div>';
      if (bl.length && S.step !== 'adding') h += '<ul class="cu-block">' + bl.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>';
      h += '</div>';
      return h;
    }

    function paintDone() {
      var d = S.done || {};
      return '<div class="note good" style="margin:0 0 12px"><b>Added.</b> ' + esc(String(d.contracts || 0)) + ' meter' + (d.contracts === 1 ? '' : 's') + ' for '
        + esc(d.customer_name || '') + (d.new_customer ? ' (a new customer)' : '') + ', ' + esc(d.status || '') + ', in '
        + esc(d.account_manager || 'no one') + '\'s portfolio.'
        + (d.fileNote ? '<br>' + esc(d.fileNote) : '') + '</div>'
        + '<div class="cu-row"><button class="act" data-cu="open">Open ' + esc(d.customer_name || 'the company') + '</button>'
        + (d.fileFailed ? '<button class="act ghost" data-cu="refile">File the PDF again</button>' : '')
        + '<button class="act ghost" data-cu="restart">Upload another</button></div>';
    }

    // -------------------------------------------------------------- events
    function wire() {
      var drop = $('cuDrop'), inp = $('cuFile');
      if (drop && inp) {
        drop.onclick = function () { inp.click(); };
        drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
        drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
        drop.ondragleave = function () { drop.classList.remove('over'); };
        drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); };
        inp.onchange = function () { if (inp.files && inp.files[0]) loadFile(inp.files[0]); };
      }
      host.querySelectorAll('[data-cu]').forEach(function (b) {
        b.onclick = function () {
          var a = b.getAttribute('data-cu');
          if (a === 'restart') reset();
          else if (a === 'read') read(0);
          else if (a === 'more') read(S.nextOffset || S.F.meters.length);
          else if (a === 'earlier') useEarlier();
          else if (a === 'add') add();
          else if (a === 'open') { if (opts.openCompany && S.done) opts.openCompany(S.done.uc_customer_id, S.done.customer_name); }
          else if (a === 'refile') fileIt(S.done).then(paint);
        };
      });
      host.querySelectorAll('[data-page]').forEach(function (c) {
        c.onchange = function () {
          var p = S.pages[Number(c.getAttribute('data-page'))];
          var pics = S.pages.filter(function (x) { return x.send && x.kind === 'scan'; }).length;
          if (c.checked && p.kind === 'scan' && pics >= MAX_PICTURES) { c.checked = false; S.msg = 'At most ' + MAX_PICTURES + ' scanned pages in one read.'; paint(); return; }
          p.send = c.checked; S.msg = ''; paint();
        };
      });
      if (!S.F) return;
      var F = S.F;
      host.querySelectorAll('[data-d]').forEach(function (el) {
        var k = el.getAttribute('data-d');
        var ev = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'date' ? 'onchange' : 'oninput';
        el[ev] = function () {
          F[k] = el.type === 'checkbox' ? el.checked : el.value;
          if (k === 'supplier' || k === 'signed_date') F.docTouched[k] = true;
          if (k === 'supplier') markDuplicates();
          if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'date' || k === 'supplier') paint(); else paintBlockers();
        };
      });
      host.querySelectorAll('[data-n]').forEach(function (el) {
        el.oninput = function () { F.newCust[el.getAttribute('data-n')] = el.value; F.docTouched.customer_name = true; paintBlockers(); };
      });
      host.querySelectorAll('input[name="cuCust"]').forEach(function (el) {
        el.onchange = function () { F.customer = el.value; F.docTouched.customer_name = true; if (F.customer !== 'new') F.am = ''; paint(); };
      });
      host.querySelectorAll('input[name="cuStatus"]').forEach(function (el) { el.onchange = function () { F.status = el.value; paint(); }; });
      host.querySelectorAll('[data-inc]').forEach(function (el) {
        el.onchange = function () { var m = F.meters[Number(el.getAttribute('data-inc'))]; m.include = el.checked; m.touched.include = true; paint(); };
      });
      host.querySelectorAll('[data-m]').forEach(function (card) {
        var m = F.meters[Number(card.getAttribute('data-m'))];
        card.querySelectorAll('[data-k]').forEach(function (el) {
          var k = el.getAttribute('data-k');
          var structural = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'date';
          el[structural ? 'onchange' : 'oninput'] = function () {
            m[k] = el.type === 'checkbox' ? el.checked : el.value;
            m.touched[k] = true;
            if (k === 'mpan' || k === 'start') markDuplicates();
            if (structural) paint(); else paintBlockers(el);
          };
        });
      });
    }
    /** Typing does not redraw the page (the caret would jump): the box loses its amber, the Add list updates. */
    function paintBlockers(el) {
      if (el) { var f = el.closest('.cu-f'); if (f) { f.classList.remove('check', 'missing'); var fl = f.querySelector('.cu-flag'); if (fl) fl.remove(); var sr = f.querySelector('.cu-src'); if (sr) sr.remove(); } }
      var sticky = host.querySelector('.cu-sticky');
      if (!sticky) return;
      var F = S.F, bl = blockers(F), btn = sticky.querySelector('[data-cu="add"]');
      if (btn) btn.disabled = !!(bl.length || S.busy);
      var ul = sticky.querySelector('.cu-block');
      if (ul) ul.remove();
      if (bl.length) sticky.insertAdjacentHTML('beforeend', '<ul class="cu-block">' + bl.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>');
      var amber = amberLeft(F), conf = sticky.querySelector('[data-d="confirmed"]');
      if (!amber && conf) conf.closest('label').remove();
    }

    // -------------------------------------------------------------- reading the PDF here
    function reset() { S.step = 'drop'; S.file = null; S.sha = ''; S.pages = []; S.pdf = null; S.reads = []; S.readIds = []; S.contract = null; S.F = null;
                       S.match = null; S.err = ''; S.msg = ''; S.earlier = null; S.done = null; S.busy = false; paint(); }

    function sha256Hex(buf) {
      var c = root.crypto && root.crypto.subtle;
      if (!c) return Promise.resolve('');
      return c.digest('SHA-256', buf).then(function (d) { return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); });
    }

    /** One page's text, a line per printed line, the words of a line in reading order. */
    function pageText(page) {
      return page.getTextContent().then(function (tc) {
        var rows = [];
        tc.items.forEach(function (it) {
          if (!it.str || !it.str.trim()) return;
          var y = it.transform[5], x = it.transform[4];
          var row = null;
          for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].y - y) <= 2.5) { row = rows[i]; break; }
          if (!row) { row = { y: y, items: [] }; rows.push(row); }
          row.items.push({ x: x, w: it.width || 0, s: it.str });
        });
        rows.sort(function (a, b) { return b.y - a.y; });
        return rows.map(function (r) {
          r.items.sort(function (a, b) { return a.x - b.x; });
          var out = '', prev = null;
          r.items.forEach(function (it) {
            // Glyphs set one at a time (a common PDF habit) join up again; a real gap is a space.
            if (prev && it.x - (prev.x + prev.w) > 1) out += ' ';
            out += it.s; prev = it;
          });
          return out.replace(/\s+/g, ' ').trim();
        }).join('\n');
      });
    }

    function loadFile(f) {
      S.err = ''; S.msg = '';
      if (!/\.pdf$/i.test(f.name || '') && f.type !== 'application/pdf') { S.err = f.name + ' is not a PDF. Save the contract as a PDF and drop that.'; paint(); return Promise.resolve(); }
      if (f.size > MAX_BYTES) { S.err = f.name + ' is over 40 MB.'; paint(); return Promise.resolve(); }
      S.file = f; S.step = 'reading'; S.msg = 'Opening ' + f.name + '...'; paint();
      var buf;
      return f.arrayBuffer().then(function (b) { buf = b; return sha256Hex(b.slice(0)); }).then(function (sha) {
        S.sha = sha;
        return Promise.resolve(opts.loadPdfJs ? opts.loadPdfJs() : null).then(function (lib) {
          var pdfjs = lib || root.pdfjsLib;
          if (!pdfjs || !pdfjs.getDocument) throw new Error('pdf.js did not load');
          return pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        });
      }).then(function (pdf) {
        S.pdf = pdf;
        var n = pdf.numPages, chain = Promise.resolve(), pages = [];
        for (var i = 1; i <= Math.min(n, 60); i++) (function (k) {
          chain = chain.then(function () { return pdf.getPage(k); }).then(pageText).then(function (t) {
            var c = classifyPage(t);
            pages.push({ n: k, text: t, kind: c.kind, label: c.label, send: c.send, preview: maskBank(t.split('\n').slice(0, 2).join(' / ')).slice(0, 160) });
          });
        })(i);
        return chain.then(function () {
          S.pages = pages;
          if (n > 60) S.msg = 'Only the first 60 of ' + n + ' pages are listed.';
          else S.msg = '';
          return earlierRead();
        });
      }).then(function () { S.step = 'pages'; paint(); })
        .catch(function (e) { S.step = 'drop'; S.err = 'Could not open ' + f.name + ': ' + ((e && e.message) || e); paint(); });
    }

    function earlierRead() {
      if (!S.sha) return Promise.resolve();
      return q(sb.from('contract_reads').select('id,created_at,by_name,model,result,added_at,added_by_name,added_status')
        .eq('file_sha256', S.sha).eq('ok', true).order('created_at', { ascending: false }).limit(5), 'earlier reads')
        .then(function (rows) {
          // Only a read that holds the whole contract (no meters left) is reused.
          S.earlier = (rows || []).find(function (r) { return r.result && !r.result.more_meters && (r.result.meter_offset || 0) === 0; }) || null;
        }).catch(function () { S.earlier = null; });
    }

    function picture(n) {
      return S.pdf.getPage(n).then(function (page) {
        var vp1 = page.getViewport({ scale: 1 });
        var scale = Math.min(2, 1600 / Math.max(vp1.width, vp1.height));
        var vp = page.getViewport({ scale: scale });
        var cv = doc.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        return page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise.then(function () {
          var q1 = cv.toDataURL('image/jpeg', 0.8);
          return q1.length > 1700000 ? cv.toDataURL('image/jpeg', 0.6) : q1;
        });
      });
    }

    // -------------------------------------------------------------- the read
    function invoke(body) {
      return Promise.resolve(sb.functions.invoke(FN, { body: body })).then(function (r) {
        if (!r.error) return r.data;
        var res = r.error.context, status = (res && res.status) || 0;
        var p = res && typeof res.text === 'function' ? res.text().catch(function () { return ''; }) : Promise.resolve('');
        return p.then(function (raw) {
          var b = null; try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = null; }
          var e = new Error(fnErrorWords(status, b, raw)); e.status = status; e.body = b; throw e;
        });
      });
    }

    function read(offset) {
      S.err = ''; S.busy = true;
      var sendText = S.pages.filter(function (p) { return p.send && p.kind !== 'scan' && p.kind !== 'dd'; });
      var sendPics = S.pages.filter(function (p) { return p.send && p.kind === 'scan'; }).slice(0, MAX_PICTURES);
      var t0 = Date.now(), timer = null;
      S.step = 'reading';
      var tick = function () { S.msg = 'Claude is reading ' + S.file.name + (offset ? ' (meters ' + (offset + 1) + ' onward)' : '') + '... ' + Math.round((Date.now() - t0) / 1000) + ' s'; var n = host.querySelector('.note'); if (n && S.step === 'reading') n.textContent = S.msg; };
      tick(); paint(); timer = setInterval(tick, 1000);
      var pics = sendPics.reduce(function (ch, p) {
        return ch.then(function (arr) { return picture(p.n).then(function (d) { arr.push({ n: p.n, data: d }); return arr; }); });
      }, Promise.resolve([]));
      return pics.then(function (images) {
        return invoke({ file_name: S.file.name, file_sha256: S.sha, pages_total: S.pages.length, meter_offset: offset || 0,
                        pages: sendText.map(function (p) { return { n: p.n, text: maskBank(p.text) }; }), images: images });
      }).then(function (d) {
        clearInterval(timer);
        if (!d || !d.ok) throw new Error((d && d.error) || 'The reader did not answer.');
        S.reads.push(d.contract); S.readIds.push(d.read_id); S.model = d.model; S.ms = (S.ms || 0) + (d.ms || 0);
        S.left = d.remaining_today;
        S.contract = mergeReads(S.reads);
        S.nextOffset = (d.contract.meter_offset || 0) + (d.contract.meters || []).length;
        // A group contract: keep reading until every meter is in, up to MAX_SLICES reads.
        if (d.contract && d.contract.more_meters > 0 && S.reads.length < MAX_SLICES && (d.contract.meters || []).length) {
          return read(S.nextOffset);
        }
        return review();
      }).catch(function (e) {
        clearInterval(timer);
        S.busy = false;
        S.err = (e && e.message) || String(e);
        S.step = S.F ? 'review' : 'pages';
        paint();
      });
    }

    function useEarlier() {
      var e = S.earlier;
      if (!e) return;
      S.reads = [e.result]; S.readIds = [e.id]; S.model = e.model || ''; S.ms = 0;
      S.contract = mergeReads(S.reads);
      review();
    }

    /** From the read to the boxes, and who it belongs to. */
    function review() {
      S.busy = false;
      var c = S.contract, Fd = c.fields || {};
      var prev = S.F;
      var meters = (c.meters || []).map(meterForm);
      if (prev) {
        // A later slice: keep what has already been typed on the meters read before.
        var byKey = {}; prev.meters.forEach(function (m) { byKey[m.fuel + '|' + (m.printed || m.mpan)] = m; });
        meters = meters.map(function (m) { return byKey[m.fuel + '|' + (m.printed || m.mpan)] || m; });
      }
      var cs = Fd.commission_stated;
      S.F = prev || {
        supplier: '', supplierOther: val(Fd.supplier), product: val(Fd.product), signed_date: val(Fd.signed_date),
        payment_terms: val(Fd.payment_terms), commission: cs && cs.value != null ? String(cs.value) : '',
        customer: '', am: '', status: '', confirmed: false,
        newCust: { name: val(Fd.customer_name), company_reg_number: val(Fd.company_number), registered_address: val(Fd.registered_address),
                   registered_postcode: val(Fd.registered_postcode), allow_duplicate: false },
        docChecks: { supplier: Fd.supplier, customer_name: Fd.customer_name, signed_date: Fd.signed_date }, docTouched: {}, meters: [],
      };
      S.F.meters = meters;
      S.step = 'review'; S.msg = 'Matching the customer...'; paint();
      var mp = meters.map(function (m) { return String(m.mpan || '').replace(/\s/g, ''); }).filter(Boolean);
      return Promise.all([
        S.names.length ? Promise.resolve(S.names) : q(sb.rpc('crm_supplier_names'), 'supplier names').catch(function () { return []; }),
        S.ams.length ? Promise.resolve(S.ams) : q(sb.from('crm_account_managers_v').select('account_manager').order('account_manager'), 'portfolios')
          .then(function (r) { return (r || []).map(function (x) { return x.account_manager; }).filter(Boolean); }).catch(function () { return []; }),
        q(sb.rpc('crm_contract_upload_match', { p_mpans: mp, p_company: val(Fd.company_number) || null, p_name: val(Fd.customer_name) || null }), 'customer match')
          .catch(function (e) { S.err = e.message; return { customers: [], contracts: [], meters: [] }; }),
      ]).then(function (r) {
        S.names = r[0] || []; S.ams = r[1] || []; S.match = r[2] || { customers: [], contracts: [] };
        var F = S.F;
        if (!prev) {
          F.supplier = supplierMatch(val(Fd.supplier), S.names) || (val(Fd.supplier) ? '__other' : '');
          var top = (S.match.customers || [])[0];
          F.customer = top && (top.score >= 100 || top.same_company || top.same_name) ? top.uc_customer_id : 'new';
        }
        markDuplicates();
        S.msg = '';
        paint();
      });
    }

    /** Each meter's contracts already on the desk, and whether one IS this deal (refused by Add anyway). */
    function markDuplicates() {
      var F = S.F, M = S.match || { contracts: [] };
      if (!F) return;
      var sup = F.supplier === '__other' ? F.supplierOther : F.supplier;
      F.meters.forEach(function (m) {
        var k = String(m.mpan || '').replace(/\s/g, '');
        m.existing = (M.contracts || []).filter(function (x) { return x.mpan === k; }).map(function (x) {
          return Object.assign({}, x, { dup: sameDeal(x, sup, m.start, S.names) });
        });
        var dup = m.existing.some(function (x) { return x.dup; });
        if (dup && !m.duplicate && !m.touched.include) m.include = false;
        m.duplicate = dup;
      });
    }

    // -------------------------------------------------------------- the add
    function add() {
      var F = S.F;
      if (blockers(F).length || S.busy) return;
      S.busy = true; S.step = 'adding'; S.err = ''; paint();
      var p = payloadOf(F, S.readIds[0], who());
      return q(sb.rpc('crm_add_desk_contract', { p: p }), 'add the contract').then(function (res) {
        S.done = Object.assign({}, res, { mpans: p.meters.map(function (m) { return m.mpan; }) });
        return fileIt(S.done);
      }).then(function () {
        S.step = 'done'; S.busy = false; paint();
        if (opts.onAdded) { try { opts.onAdded(S.done); } catch (_) { /* the page's business */ } }
      }).catch(function (e) {
        S.busy = false; S.step = 'review';
        S.err = (e && e.message ? e.message : String(e)).replace(/^add the contract: /, '');
        paint();
      });
    }

    /** The PDF, filed on the new deal as its signed contract. A failure here never undoes the add. */
    function fileIt(d) {
      var docs = opts.docs ? opts.docs() : null;
      if (!docs || !S.file) { d.fileNote = 'The PDF was not filed: the documents module did not load. Upload it on the company page.'; d.fileFailed = true; return Promise.resolve(); }
      return docs.store(S.file, { uc_customer_id: d.uc_customer_id, uc_tender_ids: [d.uc_tender_id], mpans: d.mpans || [], kind: 'signed_contract' },
                        { matchedBy: 'contract upload' })
        .then(function (r) { d.fileNote = r && r.widened ? 'The PDF was already on the desk (' + r.file_name + '); it now covers this deal too.' : 'The PDF is filed on the deal as its signed contract.'; d.fileFailed = false; })
        .catch(function (e) {
          if (e && e.duplicate) { d.fileNote = e.message; d.fileFailed = false; return; }
          d.fileNote = 'The contract was added, but the PDF did not file: ' + ((e && e.message) || e); d.fileFailed = true;
        });
    }

    paint();
    return { VERSION: VERSION, state: S, reset: reset, loadFile: loadFile, read: read, add: add, paint: paint };
  }

  root.ContractUpload = {
    VERSION: VERSION, mount: mount,
    _test: { maskBank: maskBank, classifyPage: classifyPage, supplierMatch: supplierMatch, supKey: supKey, mpanOk: mpanOk, keyOk: keyOk,
             meterForm: meterForm, mergeReads: mergeReads, sameDeal: sameDeal, blockers: blockers, amberLeft: amberLeft,
             payloadOf: payloadOf, fnErrorWords: fnErrorWords },
  };
})(typeof window !== 'undefined' ? window : globalThis);
