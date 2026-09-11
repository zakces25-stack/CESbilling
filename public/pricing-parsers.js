/* ═══════════════════════════════════════════════════════════════════════════════════════
   CES pricing engine — supplier pricebook parsers, browser side.
   ═══════════════════════════════════════════════════════════════════════════════════════

   A port of pricing-engine/parsers.py, which has parsed every one of these files for real.
   Keep the two in step: the Python harness is where a new supplier gets proven, this is
   where the desk actually uses it.

   WHY THIS RUNS IN THE BROWSER, not in an edge function.

   The file is already here. SheetJS is already loaded to read the header. A BG Lite
   electricity book is 162,433 rows and took about 100 seconds of pure parsing in Python;
   an edge function's wall clock would not survive it, and streaming a 10MB xlsx out of
   storage and back only to hand the rows straight back to the same browser is work for its
   own sake. So: parse here, insert the canonical rows in batches, promote in one RPC.

   TWO RULES, both from measured failures.

   UNITS ARE FIXED. standing charge p/day, unit rates p/kWh, capacity p/kVA/month.
   SmartestEnergy publishes in POUNDS — 0.2995 means 29.95 p/kWh — and the database CHECK
   constraints are shaped to catch exactly that: a rate may be null or an explicit 0, but a
   unit rate strictly between 0 and 1 is pounds nobody converted.

   REFUSE, NEVER GUESS. Every normaliser throws on a value it does not recognise, and the
   row is recorded with its reason. None of them fall through to a default, because a wrong
   default here is a wrong price on a three-year contract.
   ═══════════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const P_KVA_DAY_TO_MONTH = 365 / 12;      // 30.4166..., the house conversion

  const CANON_FIELDS = [
    'supplier_key', 'fuel', 'sale_type', 'term_months', 'product_name', 'product_code',
    'dno_id', 'gsp_group', 'ldz', 'exit_zone', 'profile_class', 'rate_structure',
    'tcr_band', 'voltage_level', 'aq_min', 'aq_max',
    'start_date_min', 'start_date_max', 'sell_days_min', 'sell_days_max',
    'quote_valid_from', 'quote_valid_to',
    'payment_method', 'green', 'amr', 'sc_type',
    'standing_charge_p_day', 'unit_rate_p_kwh', 'day_rate_p_kwh', 'night_rate_p_kwh',
    'eve_weekend_p_kwh', 'offpeak_p_kwh', 'capacity_p_kva_month', 'set_uplift_p_kwh',
  ];

  /** A row-level refusal. Never thrown past the row it belongs to. */
  class Refuse extends Error {}

  // ── Normalisers ──────────────────────────────────────────────────────────────────────

  const key = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

  function normHeader(cols) {
    const parts = cols.map((c) => String(c == null ? '' : c).trim().toLowerCase().replace(/\s+/g, ' '));
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts.join(' | ');
  }

  const SALE = {
    acquisition: 'acquisition', acq: 'acquisition', new: 'acquisition',
    'new business': 'acquisition', '1': 'acquisition',
    renewal: 'renewal', ren: 'renewal', retention: 'renewal',
    '': 'any', none: 'any', any: 'any', both: 'any',
    // BG Lite puts the GRID NAME in the Sales Type column. VB carries real Acquisition /
    // Renewal values; BrUPG and BrDUPG are upgrade grids with a broker uplift already baked
    // in (EA1 G1 12m gas is 12.33 p/kWh against about 7 on VB). CES does not upgrade with
    // BG Lite, so those files are not loaded — and if one ever is, 'upgrade' is a sale type
    // the matcher never asks for, so it cannot reach a normal quote.
    vb: 'any', brupg: 'upgrade', brdupg: 'upgrade',
  };
  function saleType(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase();
    if (k in SALE) return SALE[k];
    throw new Refuse(`unmapped sale type "${v}"`);
  }

  const STRUCT = {
    standard: 'single', 'single rate': 'single', single: 'single',
    unrestricted: 'single', day: 'single', all: 'single',
    economy7: 'day_night', 'economy 7': 'day_night', e7: 'day_night',
    daynight: 'day_night', 'day/night': 'day_night', 'day night': 'day_night',
    eveningandweekend: 'eve_weekend', 'evening & weekend': 'eve_weekend',
    eveningweekend: 'eve_weekend', 'eve/weekend': 'eve_weekend',
    offpeak: 'off_peak', 'off peak': 'off_peak', off_peak: 'off_peak',
    // Three registers: day + night + evening/weekend. One product, three supplier names.
    'eve/weekend & night': 'day_night_ew',
    eveningweekendandnight: 'day_night_ew',
    'evening weekend and night': 'day_night_ew',
    three_rate: 'day_night_ew', 'three rate': 'day_night_ew',
    nhh_ewn_wd: 'eve_weekend', 'nhh off-peak': 'off_peak',
  };
  function rateStructure(v, allowBlank) {
    let k = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    if ((k === '' || k === 'none') && allowBlank) return null;
    k = k.replace(/\s*band\s*\d\s*$/, '');           // Yu writes "DayNight Band 1"
    if (k in STRUCT) return STRUCT[k];
    throw new Refuse(`unmapped rate structure "${v}"`);
  }

  const BAND = {
    'band 1': 'band_1', band1: 'band_1', '1': 'band_1', nhhband1: 'band_1',
    'band 2': 'band_2', band2: 'band_2', '2': 'band_2', nhhband2: 'band_2',
    'band 3': 'band_3', band3: 'band_3', '3': 'band_3', nhhband3: 'band_3',
    'band 4': 'band_4', band4: 'band_4', '4': 'band_4', nhhband4: 'band_4',
    'domestic aggregated': 'domestic', domestic: 'domestic', d: 'domestic',
    'no residual': 'no_residual', no_residual: 'no_residual',
  };
  function tcrBand(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    if (k === '' || k === 'none') return null;
    if (k in BAND) return BAND[k];
    const m = k.match(/(\d)\s*$/);                   // "LV No MIC 2", "Whole Current Band 1"
    if (m && '1234'.includes(m[1])) return 'band_' + m[1];
    throw new Refuse(`unmapped TCR band "${v}"`);
  }

  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim().replace(/,/g, '').replace(/£/g, '');
    if (s === '' || s === '-' || /^n\/a$/i.test(s) || s === 'None') return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  /**
   * Dates.
   *
   * SheetJS hands back a Date when cellDates is on, and British Gas writes its window dates
   * as dd/mm/yyyy STRINGS in the same file, so both have to work. dd/mm before mm/dd
   * deliberately: these are UK supplier files, and 07/03/2027 is 7 March.
   */
  function toDate(v) {
    if (v == null || String(v).trim() === '') return null;
    if (v instanceof Date && !isNaN(v)) {
      // LOCAL getters, not UTC. SheetJS builds the Date in local time, so a cell meaning
      // 1 Sep 2026 arrives as 2026-08-31T23:00:00Z under BST and getUTCDate() returns 31.
      // That is a supply-start window boundary a day early, on every date in every file.
      // Same family of bug as the ExcelJS local-date trap that shifted a flex template a
      // month early. Verified: getUTCDate()=31, getDate()=1 for that cell.
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    const s = String(v).trim().slice(0, 19);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return null;
  }

  /**
   * Standing charge type. THREE values, not two.
   *
   * E.ON Next ships SC and LSC, and LSC is a LOW standing charge, not none — those rows
   * carry 30p and 48p a day. Folding it into 'no_sc' put a real standing charge on screen
   * labelled "no SC". Yu writes NSC, BG Lite writes 0SC, Scottish Power writes "With S/C".
   */
  function scType(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (k === '') return null;
    if (k === 'lsc' || k.includes('lowsc')) return 'low_sc';
    if (k === 'nsc' || k === '0sc' || k === 'zerosc' || k.startsWith('nosc')) return 'no_sc';
    if (k === 'sc' || k.startsWith('withsc')) return 'with_sc';
    return null;      // unknown is unknown; do not guess which way it goes
  }

  function toBool(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (['y', 'yes', 'true', '1'].includes(s)) return true;
    if (['n', 'no', 'false', '0'].includes(s)) return false;
    return null;
  }

  /** Distributor id as two characters. Ids outside 10-23 are independent networks. */
  function dnoId(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '' || s === 'None') return null;
    const m = s.match(/^(\d{1,2})/);
    return m ? m[1].padStart(2, '0') : null;
  }

  /**
   * Unit guard. 0 and null pass — SSE uses 0 as a not-applicable sentinel — but a value
   * strictly inside (0, lo) is refused, because that is pounds nobody converted.
   */
  function bounded(v, lo, hi, what) {
    if (v == null || v === 0) return v;
    if (v >= lo && v <= hi) return v;
    throw new Refuse(`${what} out of range: ${v} (expected ${lo}..${hi}, or 0/blank)`);
  }

  /**
   * A per-kWh rate of exactly zero is an EMPTY REGISTER, not free energy, so it is stored
   * as null.
   *
   * This is not a nicety. EDF's rate card puts a single rate in DayRate and writes
   * `UnitRate,0.0` and `NightRate,0` beside it. Stored as 0 those columns look like real
   * prices: all 8,916 live EDF rows had unit_rate_p_kwh = 0, and the quote maths then read
   * day 24.6 against night 0 as a two-rate tariff, blended them, and made EDF the cheapest
   * supplier on every meter by a mile. Nobody sells electricity at nothing.
   *
   * A standing charge of zero is the opposite: BG Lite's VB grid and EDF's Zero Standing
   * Charge products really do charge 0 p/day, so sc() keeps it. Same for capacity.
   */
  const rate = (v) => { const n = bounded(toNum(v), 1, 200, 'unit rate p/kWh'); return n === 0 ? null : n; };
  const sc   = (v) => bounded(toNum(v), 1, 5000, 'standing charge p/day');

  /** Capacity arrives p/kVA/day and is stored p/kVA/month. Never stored or shown per day. */
  function capFromDay(v) {
    const n = toNum(v);
    if (n == null || n === 0) return n;
    return bounded(Math.round(n * P_KVA_DAY_TO_MONTH * 1e6) / 1e6, 1, 20000, 'capacity p/kVA/month');
  }

  function blankRow(supplierKey, fuel) {
    const r = {};
    for (const k of CANON_FIELDS) r[k] = null;
    r.supplier_key = supplierKey;
    r.fuel = fuel;
    return r;
  }

  /** Column accessor built once per file, matched on a squashed header name. */
  function accessor(header) {
    const ix = {};
    header.forEach((h, i) => { const k = key(h); if (!(k in ix)) ix[k] = i; });
    const get = (row, ...names) => {
      for (const n of names) { const i = ix[n]; if (i !== undefined && i < row.length) return row[i]; }
      return null;
    };
    return { ix, get, has: (n) => n in ix };
  }

  // ── Adapter 1: BKF / "UD Partner" ────────────────────────────────────────────────────
  //
  // One ~33-column schema shared by EDF (csv), E.ON Next (csv), Yu Energy (sheet
  // "UD Partner", lowercase headers) and Scottish Power (sheet "BKF", extra Key column).
  // Four suppliers, one parser. Columns are matched on a squashed name so Yu's lowercasing
  // and SP's extra column are not layout changes.


  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Legacy ZipCrypto, so the E.ON Next archive opens in the browser
  // ═══════════════════════════════════════════════════════════════════════════════════════
  //
  // E.ON Next ship their SME pricebook as a password-protected zip. JSZip has no decryption
  // at all, so until now the answer was "unzip it yourself". Measured on their 8 Sep file:
  // every member is general-purpose bit 0 set, NO 0x9901 extra field, method 8. That is the
  // old PKWARE stream cipher, not WinZip AES — which is forty lines of arithmetic rather
  // than a crypto dependency.
  //
  // Bit 3 is also set, so the sizes live in a data descriptor and the encryption header's
  // check byte is the high byte of the DOS time, not of the CRC. Getting that wrong rejects
  // a correct password.

  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc1 = (crc, b) => (CRC_T[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;

  function zipCryptoKeys(password) {
    let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
    const upd = (b) => {
      k0 = crc1(k0, b);
      k1 = (k1 + (k0 & 0xff)) >>> 0;
      k1 = (Math.imul(k1, 134775813) + 1) >>> 0;
      k2 = crc1(k2, (k1 >>> 24) & 0xff);
    };
    for (let i = 0; i < password.length; i++) upd(password.charCodeAt(i) & 0xff);
    return { upd, stream: () => { const t = (k2 | 2) & 0xffff;
                                  return (Math.imul(t, t ^ 1) >>> 8) & 0xff; } };
  }

  /** Decrypt one member and strip the 12-byte header. Throws on a wrong password. */
  function zipCryptoDecrypt(bytes, password, checkByte) {
    const k = zipCryptoKeys(password);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const p = (bytes[i] ^ k.stream()) & 0xff;
      k.upd(p);
      out[i] = p;
    }
    if (checkByte != null && out[11] !== checkByte) {
      throw new Error('that password did not open the archive');
    }
    return out.subarray(12);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('this browser cannot inflate the archive; extract it and drop the files in');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * Read a zip by walking its local file headers, decrypting where necessary.
   *
   * Returns [{ name, bytes }]. `skip` is asked about every member BEFORE it is decrypted or
   * inflated, so the E.ON new-connection files cost nothing at all: three of their nine
   * members are NC, about 3 MB of CSV CES never quotes, against a 500 MB storage plan.
   */
  async function readZip(buffer, { password = null, skip = null } = {}) {
    const d = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const out = [];
    const skipped = [];
    let off = 0;
    while (off + 30 <= u8.length && d.getUint32(off, true) === 0x04034b50) {
      const flag = d.getUint16(off + 6, true);
      const method = d.getUint16(off + 8, true);
      const mtime = d.getUint16(off + 10, true);
      const crc = d.getUint32(off + 14, true);
      let csz = d.getUint32(off + 18, true);
      const nl = d.getUint16(off + 26, true);
      const el = d.getUint16(off + 28, true);
      const name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nl));
      const start = off + 30 + nl + el;
      if (!csz) throw new Error(`cannot read "${name}" from this zip: its size is not in the header`);
      off = start + csz;

      const encrypted = !!(flag & 1);
      if (name.endsWith('/')) continue;
      if (/(^|\/)(__MACOSX\/|\._)/.test(name)) continue;
      if (skip && skip(name)) { skipped.push(name); continue; }
      if (encrypted && !password) throw new Error('this zip needs a password');
      if (flag & 0x40) throw new Error('this zip uses strong encryption, which cannot be opened here');

      let body = u8.subarray(start, start + csz);
      if (encrypted) {
        // Bit 3 set => sizes are in a data descriptor and the check byte is the DOS time's
        // high byte. Using the CRC's there rejects the right password.
        const check = (flag & 8) ? ((mtime >>> 8) & 0xff) : ((crc >>> 24) & 0xff);
        body = zipCryptoDecrypt(body, password, check);
      }
      if (method === 8) body = await inflateRaw(body);
      else if (method !== 0) throw new Error(`"${name}" uses compression method ${method}, which is not supported`);
      out.push({ name, bytes: body });
    }
    if (!out.length && !skipped.length) throw new Error('nothing readable in that zip');
    return { files: out, skipped };
  }


  /**
   * Turn an E.ON Next tariff code into the product name a broker would recognise.
   *
   *   E-2R-NEXT_1YR_FIXED_BUSINESS_RENEWABLE_LSC_TPI_v1
   *     -> "Fixed Business 1 Year Renewable, Low Standing Charge"
   *
   * The register prefix (E-1R / E-2R / E-3R / G-1R) is the rate shape, which is already in
   * RateStructure, and the term is already in ContractDuration, so neither goes in the name.
   * What is NOT anywhere else is whether the row is the renewable grid and whether it is the
   * low standing charge grid — and those are two genuinely different products.
   */
  function eonProductName(code) {
    if (!code || !/NEXT_\d?YR|FIXED_BUSINESS/i.test(code)) return null;
    const m = code.match(/(\d)YR/i);
    const years = m ? Number(m[1]) : null;
    const green = /RENEWABLE/i.test(code);
    const lsc = /_LSC(_|$)/i.test(code);
    const nc = /_NC(_|$)/i.test(code);
    const bits = ['Fixed Business'];
    if (years) bits.push(`${years} Year`);
    if (green) bits.push('Renewable');
    let name = bits.join(' ');
    if (lsc) name += ', Low Standing Charge';
    if (nc) name += ' (new connection)';
    return name;
  }

  const BKF_REQUIRED = ['utility', 'saletype', 'contractduration',
    'minimumannualconsumption', 'maximumannualconsumption', 'standingcharge'];

  function parseBkf(rows, supplierKey, onRow, onRefuse) {
    const header = rows[0];
    const A = accessor(header);
    const missing = BKF_REQUIRED.filter((k) => !A.has(k));
    if (missing.length) throw new Error(`not a BKF layout, missing ${missing.join(', ')}`);

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const fuelTxt = String(g('utility') || '').trim().toLowerCase();
        const fuel = fuelTxt.startsWith('elec') ? 'electricity'
                   : fuelTxt.startsWith('gas') ? 'gas' : null;
        if (!fuel) throw new Refuse(`unknown utility "${fuelTxt}"`);

        const r = blankRow(supplierKey, fuel);
        r.sale_type = saleType(g('saletype'));
        const term = toNum(g('contractduration'));
        if (term == null) throw new Refuse('no contract duration');
        r.term_months = Math.round(term);
        // The real product name is in TariffInformation2. EDF's ProductName column only ever
        // says "Online Only" (and once, bafflingly, "Online Only|[12Month]"), while
        // TariffInformation2 carries "Fixed Online 3 Year" and
        // "Fixed Online 3 Year Zero Standing Charge" — twelve genuine products. E.ON puts
        // the rate structure there instead, so fall back when it is not a product name.
        const ti2 = String(g('tariffinformation2') || '').trim();
        const pn  = String(g('productname') || '').trim();
        // FLAT_ prefixes any of them (FLAT_ECONOMY7, FLAT_THREE_RATE), so match the prefix
        // rather than listing every combination and missing one.
        const ti2IsStructure = /^(flat_)?(standard|economy7|three_rate|off_peak|nhh_|eveningandweekend|eveningweekendandnight)/i.test(ti2);
        r.product_code = String(g('tariffinformation1') || '').trim() || null;
        r.product_name = (ti2 && !ti2IsStructure ? ti2 : pn) || null;
        // E.ON Next leave ProductName blank (or say "SingleRate", which is a rate shape and
        // not a product) and put the real identity in the tariff code. Four electricity
        // products and one gas product hide in there, and without this every row would come
        // through nameless and fold into one.
        if (!r.product_name || /^singlerate$/i.test(r.product_name)) {
          const fromCode = eonProductName(r.product_code);
          if (fromCode) r.product_name = fromCode;
        }
        r.dno_id = dnoId(g('dnoid'));
        r.gsp_group = String(g('region') || '').trim() || null;
        r.ldz = String(g('ldz') || '').trim().toUpperCase() || null;
        r.exit_zone = String(g('exitzone') || '').trim().toUpperCase() || null;
        const pc = toNum(g('profileclass'));
        r.profile_class = pc == null ? null : Math.round(pc);
        r.rate_structure = rateStructure(g('ratestructure'), true);
        // Yu carries the band inside ratestructure ("DayNight Band 1"); nobody else does.
        const rsRaw = String(g('ratestructure') || '');
        const mb = rsRaw.match(/band\s*(\d)/i);
        r.tcr_band = mb ? 'band_' + mb[1] : null;
        r.aq_min = toNum(g('minimumannualconsumption'));
        r.aq_max = toNum(g('maximumannualconsumption'));
        r.start_date_min = toDate(g('minimumcontractstartdate'));
        r.start_date_max = toDate(g('maximumcontractstartdate'));
        r.quote_valid_from = toDate(g('minimumvalidquotedate'));
        r.quote_valid_to = toDate(g('maximumvalidquotedate'));
        r.payment_method = String(g('paymentmethod', 'paymentmethod2') || '').trim() || null;
        r.green = toBool(g('greenenergy'));
        r.amr = toBool(g('amr'));
        r.sc_type = scType(g('standingchargetype'));
        r.standing_charge_p_day = sc(g('standingcharge'));
        r.unit_rate_p_kwh = rate(g('unitrate'));
        r.day_rate_p_kwh = rate(g('dayrate'));
        r.night_rate_p_kwh = rate(g('nightrate'));
        r.eve_weekend_p_kwh = rate(g('eveningweekendrate'));
        r.set_uplift_p_kwh = toNum(g('setuplift'));

        // ── EDF price by HOW FAR AHEAD THE SUPPLY STARTS, in days, not dates. ──────────
        // Their rate card leaves MinimumContractStartDate, MaximumContractStartDate and
        // both valid-quote-date columns BLANK on all 7,488 electricity rows, and puts the
        // window in "Min Selling Days" / "Max Selling Days" instead: 1-185 or 186-365.
        //
        // 1,440 of 6,048 EDF keys carry both bands and the 186-365 one is always cheaper,
        // being further out on the forward curve. Ignored, both rows matched, the results
        // ranked cheapest first, and the far-forward row won every time — 25.0 p/kWh shown
        // where 26.7 was the only rate EDF would honour for a start 82 days out. GBP 869 a
        // year understated on one 55,008 kWh meter.
        //
        // Stored as a DAY RANGE, not converted to dates here. Selling days are counted
        // from the day the quote is issued, so anchoring them to the book's issue date
        // drifts as the book ages — and it drifts precisely at the 185/186 boundary, which
        // is the only place the wrong row can be picked. The comparison belongs at quote
        // time, against (start date - today).
        const sdMin = toNum(g('minsellingdays'));
        const sdMax = toNum(g('maxsellingdays'));
        r.sell_days_min = sdMin == null ? null : Math.round(sdMin);
        r.sell_days_max = sdMax == null ? null : Math.round(sdMax);
        if (r.sell_days_min != null && r.sell_days_max != null
            && r.sell_days_max < r.sell_days_min) {
          throw new Refuse(`selling days run backwards: ${r.sell_days_min} to ${r.sell_days_max}`);
        }
        // Gas puts the price in dayrate on some suppliers and unitrate on others, so check
        // every column before deciding the row prices nothing.
        if (['unit_rate_p_kwh', 'day_rate_p_kwh', 'night_rate_p_kwh', 'eve_weekend_p_kwh']
              .every((k) => r[k] == null || r[k] === 0)) {
          throw new Refuse('no unit rate on the row');
        }
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 2: British Gas / BG Lite long format ─────────────────────────────────────
  //
  // One row PER CHARGE COMPONENT, so the file has to be pivoted back into rate rows. Four
  // traps, all confirmed against the real files:
  //
  //   * The column named "Standing Charge" is a PRODUCT FLAG ('SC'), not a value. The
  //     actual standing charge is the row whose Price Line Description says so.
  //   * "Consumption Range" is an UPPER bound only. The lower bound is the previous band's
  //     upper plus one, within the same key group.
  //   * "Window Open" / "Window Close" is the SUPPLY START window, not quote validity, and
  //     it is the discriminator that makes the file parseable at all. Every BG and BGL file
  //     ships exactly two windows with different prices: Eastern PC1 Day&Night 12m 0-3499 is
  //     32.03 / 24.25 p/kWh starting on or before 06/03/2027 and 29.68 / 21.90 after. Leave
  //     it out of the key and half the rows collide; average them and every British Gas
  //     price is wrong for half the year, plausibly.
  //   * "Dummy MPAN Description" is a pipe-joined composite, not a description. Ignored.

  const BG_METER_TYPE = {
    'single rate': 'single',
    'day & night': 'day_night',
    'eve/weekend': 'eve_weekend',
    'eve/weekend & night': 'day_night_ew',
    'off peak': 'off_peak',
    // 4/5/6 Rate STOD need winter and summer peak registers the canonical row does not
    // carry, and nothing in the portfolio is on one. Refused loudly, not flattened wrongly.
  };

  const BG_LINE = {
    'standing charge': 'standing_charge_p_day',
    'unit charge': 'unit_rate_p_kwh',
    'gas unit charge': 'unit_rate_p_kwh',
    'day unit charge': 'day_rate_p_kwh',
    'weekday day unit charge': 'day_rate_p_kwh',
    'night unit charge': 'night_rate_p_kwh',
    'evening & weekend unit charge': 'eve_weekend_p_kwh',
    'off peak unit charge': 'offpeak_p_kwh',
  };

  function parseBgLong(rows, supplierKey, fuel, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    if (!A.has('pricelinedescription') || !A.has('unitcharge')) {
      throw new Error('not a British Gas long-format layout');
    }
    const groups = new Map();

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        if (!meta.version) meta.version = String(g('pricebookversion') || '').trim() || null;
        const st = saleType(g('salestype'));
        const term = toNum(g('contractduration'));
        if (term == null) throw new Refuse('no contract duration');
        const bandTop = toNum(g('consumptionrange'));
        if (bandTop == null) throw new Refuse('no consumption range');
        let struct;
        if (fuel === 'electricity') {
          const mt = String(g('metertype') || '').trim().toLowerCase();
          if (!(mt in BG_METER_TYPE)) throw new Refuse(`unsupported meter type "${mt}"`);
          struct = BG_METER_TYPE[mt];
        } else {
          struct = 'single';
        }
        const pc = toNum(g('profileclass'));
        const winFrom = toDate(g('windowopen'));
        const winTo = toDate(g('windowclose'));
        if (winFrom && (!meta.window_open || winFrom < meta.window_open)) meta.window_open = winFrom;
        if (winTo && (!meta.window_close || winTo > meta.window_close)) meta.window_close = winTo;

        const gk = JSON.stringify([
          st, Math.round(term), bandTop, struct,
          fuel === 'electricity' ? dnoId(g('regionpes')) : null,
          pc == null ? null : Math.round(pc),
          String(g('exitzone') || '').trim().toUpperCase() || null,
          String(g('ldzpesregion') || '').trim().toUpperCase() || null,
          String(g('paymentmethod') || '').trim() || null,
          String(g('standingcharge') || '').trim().toUpperCase(),   // the SC/0SC product flag
          String(g('duosband') || '').trim() || null,
          winFrom, winTo,
        ]);

        const line = String(g('pricelinedescription') || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!(line in BG_LINE)) throw new Refuse(`unmapped price line "${line}"`);
        const col = BG_LINE[line];
        const unit = String(g('unittype') || '').trim().toLowerCase();
        let val = toNum(g('unitcharge'));
        // Trust the stated unit; never infer it from the column name.
        if (col === 'standing_charge_p_day') {
          if (unit !== 'p/day') throw new Refuse(`standing charge in unexpected unit "${unit}"`);
          val = sc(val);
        } else {
          if (unit !== 'p/kwh') throw new Refuse(`unit charge in unexpected unit "${unit}"`);
          val = rate(val);
        }

        let r = groups.get(gk);
        if (!r) {
          const k = JSON.parse(gk);
          r = blankRow(supplierKey, fuel);
          r.sale_type = k[0]; r.term_months = k[1];
          r.rate_structure = struct;
          r.dno_id = k[4]; r.profile_class = k[5];
          r.exit_zone = k[6]; r.ldz = k[7];
          r.payment_method = k[8];
          r.sc_type = scType(k[9]);
          r.tcr_band = k[10] ? tcrBand(k[10]) : null;
          r.start_date_min = k[11]; r.start_date_max = k[12];
          r.aq_max = bandTop;
          // Pricebook Version carries the grid ("Standard V305 EA", "V206VB 0SC"), which is
          // how the BG Lite VB / BrUPG / BrDUPG grids stay distinguishable.
          r.product_name = String(g('pricebookversion') || '').trim() || null;
          r.__ladder = JSON.parse(gk).filter((_, i) => i !== 2).join('');
          groups.set(gk, r);
        }
        if (r[col] != null && r[col] !== val) {
          throw new Refuse(`conflicting ${col}: ${r[col]} then ${val}`);
        }
        r[col] = val;
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }

    // Derive each band's lower bound from the band below it: "Consumption Range" is an
    // upper bound only. The ladder is every other key field held constant.
    const ladders = new Map();
    for (const r of groups.values()) {
      if (!ladders.has(r.__ladder)) ladders.set(r.__ladder, []);
      ladders.get(r.__ladder).push(r.aq_max);
    }
    for (const [k, v] of ladders) ladders.set(k, [...new Set(v)].sort((a, b) => a - b));

    for (const r of groups.values()) {
      const ladder = ladders.get(r.__ladder);
      const i = ladder.indexOf(r.aq_max);
      r.aq_min = i === 0 ? 0 : ladder[i - 1] + 1;
      delete r.__ladder;
      // A group with a standing charge and no unit rate at all is half a product.
      if (['unit_rate_p_kwh', 'day_rate_p_kwh', 'night_rate_p_kwh', 'eve_weekend_p_kwh', 'offpeak_p_kwh']
            .every((k) => r[k] == null || r[k] === 0)) {
        onRefuse(null, 'group has a standing charge but no unit rate');
      } else {
        onRow(r);
      }
    }
  }

  // ── Adapter 3: UGP "Spark Output" ────────────────────────────────────────────────────
  //
  // The visible "UGP Matrix Pricing" sheet is a formula front end; the rates are in
  // Spark Output Elec / Spark Output Gas. ContractDuration is in YEARS here, not months,
  // which is the sort of thing that silently prices a 3-year deal as 3 months.

  function parseUgp(rows, fuel, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    for (const need of ['utility', 'contractduration', 'standingcharge']) {
      if (!A.has(need)) throw new Error(`not a UGP Spark layout, missing ${need}`);
    }
    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const r = blankRow('ugp', fuel);
        const yrs = toNum(g('contractduration'));
        if (yrs == null) throw new Refuse('no contract duration');
        if (yrs < 1 || yrs > 6) throw new Refuse(`contract duration ${yrs} is not a plausible number of YEARS`);
        r.term_months = Math.round(yrs * 12);
        // Squashed key: 'renewal_contract' in the file becomes 'renewalcontract' here.
        // Asking for the underscored name returned null on every row and marked the whole
        // UGP book as acquisition.
        r.sale_type = toBool(g('renewalcontract')) ? 'renewal' : 'acquisition';
        r.product_code = String(g('ugptariffcode') || '').trim() || null;
        r.ldz = String(g('ldz') || '').trim().toUpperCase() || null;
        const gsp = String(g('gsp') || '').trim();
        r.dno_id = /^\d+$/.test(gsp) ? dnoId(gsp) : null;
        r.gsp_group = gsp || null;
        const pc = toNum(g('profileclass'));
        r.profile_class = pc == null ? null : Math.round(pc);
        r.rate_structure = fuel === 'electricity' ? rateStructure(g('ratestructure'), true) : 'single';
        r.tcr_band = tcrBand(g('tcrband'));
        r.aq_min = toNum(g('volumelower'));
        r.aq_max = toNum(g('volumeupper'));
        r.start_date_min = toDate(g('startdate'));
        if (r.start_date_min && (!meta.window_open || r.start_date_min < meta.window_open)) meta.window_open = r.start_date_min;
        r.green = toBool(g('renewablecontract'));
        r.standing_charge_p_day = sc(g('standingcharge'));
        if (fuel === 'gas') {
          r.unit_rate_p_kwh = rate(g('gasrate'));
        } else {
          r.unit_rate_p_kwh = rate(g('anytime'));
          r.day_rate_p_kwh = rate(g('day'));
          r.night_rate_p_kwh = rate(g('night'));
        }
        if (['unit_rate_p_kwh', 'day_rate_p_kwh', 'night_rate_p_kwh'].every((k) => r[k] == null || r[k] === 0)) {
          throw new Refuse('no unit rate on the row');
        }
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 4: SmartestEnergy ────────────────────────────────────────────────────────
  //
  // PUBLISHES IN POUNDS. 0.2995 is 29.95 p/kWh and 0.3385 is 33.85 p/day. Every rate is
  // multiplied by 100 on the way in. The database CHECK constraints exist because of this
  // supplier: a unit rate between 0 and 1 p/kWh is not a cheap deal.

  function parseSmartest(rows, fuel, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    if (!A.has('producttype')) throw new Error('not a SmartestEnergy layout');
    const isElec = A.has('distid');            // the electricity sheet has Dist ID
    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const ptype = String(g('producttype') || '').trim().toLowerCase();
        const rowFuel = ptype.startsWith('elec') ? 'electricity' : ptype.startsWith('gas') ? 'gas' : null;
        if (!rowFuel) throw new Refuse(`unknown product type "${ptype}"`);
        const r = blankRow('smartest', rowFuel);

        const product = String(g('product') || '').trim();
        const pname = String(g('productname') || '').trim();
        r.product_name = product || pname || null;
        // Term is in the product name, e.g. "SmartFix - 1 Year Level" / "1 Year Fixed".
        const mterm = (product + ' ' + pname).match(/(\d+)\s*year/i);
        if (!mterm) throw new Refuse(`cannot read a term from "${product}" / "${pname}"`);
        r.term_months = parseInt(mterm[1], 10) * 12;

        // The gas sheet has a Tariff column carrying Acquisition / Renewal. The electricity
        // sheet does not name a sale type anywhere, and the file is titled "Acquisition &
        // Renewal", so it applies to both rather than to a guess.
        r.sale_type = A.has('tariff') ? saleType(g('tariff')) : 'any';

        if (rowFuel === 'electricity') {
          r.dno_id = dnoId(g('distid'));
          const mt = String(g('metertype') || '').trim().toUpperCase();
          // Half-hourly is out of v1 scope: it prices on capacity bands this row shape does
          // not carry, and the portfolio's HH meters are excluded anyway. Refused by name so
          // the count is explainable rather than mysterious.
          if (mt.startsWith('HH')) throw new Refuse(`half-hourly meter type "${mt}" is out of scope`);
          const SM_MT = { DAY: 'single', E7: 'day_night', EW: 'eve_weekend',
                          EWN: 'day_night_ew', OP: 'off_peak' };
          if (!(mt in SM_MT)) throw new Refuse(`unmapped SmartestEnergy meter type "${mt}"`);
          r.rate_structure = SM_MT[mt];
          const pc = toNum(g('profile'));
          r.profile_class = pc == null ? null : Math.round(pc);
          r.tcr_band = tcrBand(g('voltagetcrband'));
        } else {
          r.ldz = String(g('region') || '').trim().toUpperCase() || null;
          r.rate_structure = 'single';
        }

        r.aq_min = toNum(g('minaq'));
        r.aq_max = toNum(g('maxaq'));
        r.start_date_min = toDate(g('effectivefromdate', 'effectivefrom'));
        r.start_date_max = toDate(g('effectivetodate', 'effectiveto'));
        if (r.start_date_min && (!meta.window_open || r.start_date_min < meta.window_open)) meta.window_open = r.start_date_min;
        if (r.start_date_max && (!meta.window_close || r.start_date_max > meta.window_close)) meta.window_close = r.start_date_max;
        r.green = toBool(g('renewableenergy'));

        // ×100: pounds to pence. This is the whole reason this adapter exists separately.
        const x100 = (v) => { const n = toNum(v); return n == null ? null : n * 100; };
        r.standing_charge_p_day = sc(x100(g('standingcharge')));
        const dayAll = x100(g('dayall'));
        const night = x100(g('night'));
        const ew = x100(g('evewkend'));
        if (rowFuel === 'gas') {
          r.unit_rate_p_kwh = rate(x100(g('unitrate')));
        } else if (r.rate_structure === 'single') {
          r.unit_rate_p_kwh = rate(dayAll);
        } else if (r.rate_structure === 'off_peak') {
          // OP populates Night only; Day/All is blank. Putting a blank in the day column and
          // calling it an off-peak product would price the whole meter at nothing.
          r.offpeak_p_kwh = rate(night);
          if (r.offpeak_p_kwh == null || r.offpeak_p_kwh === 0) {
            throw new Refuse('off-peak row has no off-peak rate');
          }
        } else {
          r.day_rate_p_kwh = rate(dayAll);
          r.night_rate_p_kwh = rate(night);
          r.eve_weekend_p_kwh = rate(ew);
        }
        r.capacity_p_kva_month = capFromDay(x100(g('capacitycharge')));

        if (['unit_rate_p_kwh', 'day_rate_p_kwh', 'night_rate_p_kwh', 'eve_weekend_p_kwh', 'offpeak_p_kwh']
              .every((k) => r[k] == null || r[k] === 0)) {
          throw new Refuse('no unit rate on the row');
        }
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 5: Utilita (Europa) ──────────────────────────────────────────────────────
  //
  // Small and flat. Region NAMES as well as a DNO area, and its own UPLIFT column, which is
  // the supplier's embedded uplift and is recorded rather than added to the rate — CES's own
  // uplift is applied at quote time, and adding both would double-count.

  function parseUtilita(rows, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    if (!A.has('fuel') || !A.has('standingcharge')) throw new Error('not a Utilita Europa layout');
    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const fuelTxt = String(g('fuel') || '').trim().toLowerCase();
        const fuel = fuelTxt.startsWith('elec') ? 'electricity' : fuelTxt.startsWith('gas') ? 'gas' : null;
        if (!fuel) throw new Refuse(`unknown fuel "${fuelTxt}"`);
        const r = blankRow('utilita', fuel);

        const tariff = String(g('tariffname') || '').trim();
        r.product_name = tariff || null;
        const mterm = tariff.match(/(\d+)\s*(?:year|yr|month)/i);
        if (mterm) {
          r.term_months = /month/i.test(mterm[0]) ? parseInt(mterm[1], 10) : parseInt(mterm[1], 10) * 12;
        } else {
          throw new Refuse(`cannot read a term from tariff name "${tariff}"`);
        }
        r.sale_type = 'any';
        r.dno_id = dnoId(g('dnoarea'));
        r.gsp_group = String(g('gsparea') || '').trim() || null;
        const pc = toNum(g('profileclass'));
        r.profile_class = pc == null ? null : Math.round(pc);
        r.rate_structure = null;      // the file does not state one; leave it open
        r.standing_charge_p_day = sc(g('standingcharge'));
        const u = rate(g('unitrate'));
        const nite = rate(g('nightrate'));
        const ew = rate(g('eveningweekendrate'));
        if (nite != null && nite !== 0) {
          r.day_rate_p_kwh = u; r.night_rate_p_kwh = nite;
          r.rate_structure = (ew != null && ew !== 0) ? 'day_night_ew' : 'day_night';
          r.eve_weekend_p_kwh = ew;
        } else if (ew != null && ew !== 0) {
          r.unit_rate_p_kwh = u; r.eve_weekend_p_kwh = ew; r.rate_structure = 'eve_weekend';
        } else {
          r.unit_rate_p_kwh = u; r.rate_structure = 'single';
        }
        r.set_uplift_p_kwh = toNum(g('uplift'));
        if (['unit_rate_p_kwh', 'day_rate_p_kwh'].every((k) => r[k] == null || r[k] === 0)) {
          throw new Refuse('no unit rate on the row');
        }
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Shared: supply-start windows, and terms given as a date pair ─────────────────────
  //
  // Four of the five suppliers below price by WHEN THE SUPPLY STARTS and give only the
  // first day of each window. TotalEnergies gas ships 13 monthly windows, and the price
  // falls 7.46 -> 5.47 p/kWh across them for the same meter, so a window boundary a month
  // out is a 2p error. SSE power ships two windows six months apart. Ecotricity ships eight.
  //
  // The honest derivation is the LADDER: a window runs until the day before the next one
  // starts. Same technique as British Gas's consumption bands, which publish only an upper
  // bound. The last window has no successor, so it gets one month, which is the spacing
  // every one of these files actually uses.

  const DAY = 86400000;
  const isoOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const utcOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

  const dayBefore = (iso) => isoOf(new Date(utcOf(iso).getTime() - DAY));

  /** Same day n months on, minus a day. Clamps, so 31 Jan + 1 month is 28/29 Feb. */
  function plusMonthsMinusDay(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + n, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, lastDay));
    return isoOf(new Date(target.getTime() - DAY));
  }

  /**
   * iso start date -> last day of its window, from the set of start dates in the file.
   *
   * The last window has no successor, so it gets the same length as the gap before it.
   * A fixed one month was wrong for SSE power, whose two windows are SIX months apart:
   * the April book would have closed on 30 April and every May-to-September start would
   * have found no price at all.
   */
  function startWindowLadder(dates) {
    const uniq = [...new Set(dates.filter(Boolean))].sort();
    const out = new Map();
    let lastGap = 1;
    for (let i = 0; i < uniq.length; i++) {
      if (i + 1 < uniq.length) {
        out.set(uniq[i], dayBefore(uniq[i + 1]));
        lastGap = monthsBetween(uniq[i], uniq[i + 1]) || 1;
      } else {
        out.set(uniq[i], plusMonthsMinusDay(uniq[i], lastGap));
      }
    }
    return out;
  }

  const monthsBetween = (a, b) => {
    const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
    return (yb - ya) * 12 + (mb - ma);
  };

  /**
   * Term in months from a start and an INCLUSIVE end date.
   *
   * Ecotricity publishes no term column at all: 2026-10-01 to 2027-09-30 is a 12 month
   * deal, to 2028-03-31 an 18 month one. 18 and 30 month terms are real here and the portal
   * has to offer them, or a third of Ecotricity's book is invisible.
   */
  function termFromDates(startIso, endIso) {
    if (!startIso || !endIso) throw new Refuse('cannot work out the term without both dates');
    const [ys, ms, ds] = startIso.split('-').map(Number);
    const [ye, me, de] = endIso.split('-').map(Number);
    let m = (ye - ys) * 12 + (me - ms);
    if (de >= ds) m += 1;              // ends on/after the anniversary day, so a whole month
    if (m < 1 || m > 72) throw new Refuse(`derived term ${m} months is outside 1..72`);
    return m;
  }

  /**
   * GSP group letter -> distributor id.
   *
   * MEASURED, not assumed. Ecotricity's own pricebook carries the letter, the two-digit id
   * and the DNO name on every row, and the mapping is NOT sequential past _G: _H is 20
   * (Southern), _J is 19 (South East), _N is 18 and _P is 17. Counting A=10, B=11... through
   * the alphabet gets five of the fourteen wrong, which would price a Southern meter off
   * South East Scotland's grid and look entirely plausible.
   */
  const GSP_TO_DNO = {
    _a: '10', _b: '11', _c: '12', _d: '13', _e: '14', _f: '15', _g: '16',
    _h: '20', _j: '19', _k: '21', _l: '22', _m: '23', _n: '18', _p: '17',
  };
  function gspToDno(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase();
    if (!k) return null;
    const m = k.match(/^_?([a-p])$/);
    if (m && ('_' + m[1]) in GSP_TO_DNO) return GSP_TO_DNO['_' + m[1]];
    throw new Refuse(`unmapped GSP group "${v}"`);
  }

  /**
   * Exit zone -> LDZ, as a table rather than a rule.
   *
   * The obvious rule is "take the first two letters", and it is right for 36 of the 38 zones
   * and wrong for Wales: WA1 is in Wales NORTH (WN) and WA2 in Wales SOUTH (WS), neither of
   * which is "WA". Guessing cost 12,480 refused TotalEnergies rows before this table existed
   * — better than a wrong LDZ, since the LDZ changes both the unit rate and the standing
   * charge, but still a tenth of their book missing.
   *
   * Measured from SSE's gas matrix, which is the one file carrying both columns on every
   * row: 38 zones, 18 LDZs, and no zone maps to two LDZs.
   */
  const ZONE_LDZ = {
    EA1: 'EA', EA2: 'EA', EA3: 'EA', EA4: 'EA',
    EM1: 'EM', EM2: 'EM', EM3: 'EM', EM4: 'EM',
    LC: 'LC', LO: 'LO', LS: 'LS', LT: 'LT', LW: 'LW',
    NE1: 'NE', NE2: 'NE', NE3: 'NE', NO1: 'NO', NO2: 'NO',
    NT1: 'NT', NT2: 'NT', NT3: 'NT', NW1: 'NW', NW2: 'NW',
    SC1: 'SC', SC2: 'SC', SC4: 'SC', SE1: 'SE', SE2: 'SE',
    SO1: 'SO', SO2: 'SO', SW1: 'SW', SW2: 'SW', SW3: 'SW',
    WA1: 'WN', WA2: 'WS',                       // the two the prefix rule gets wrong
    WM1: 'WM', WM2: 'WM', WM3: 'WM',
  };
  function ldzOfZone(v) {
    const z = String(v == null ? '' : v).trim().toUpperCase();
    if (!z) return null;
    if (z in ZONE_LDZ) return ZONE_LDZ[z];
    // An unknown zone falls back to the prefix rather than refusing the row: a new zone is
    // far more likely than a new LDZ, and the prefix is right 36 times out of 38.
    const m = z.match(/^([A-Z]{2})/);
    return m ? m[1] : null;
  }

  // ── Adapter 6: TotalEnergies gas ─────────────────────────────────────────────────────
  //
  // Nine columns and no surprises, which after British Gas is a relief.
  //
  //   PRODUCT_NAME  9_NE_NE1_B_20347   band index _ LDZ _ exit zone _ B _ price id
  //   REGION        the exit zone, same as field 3 of PRODUCT_NAME
  //   AQ_MIN/MAX    exact, non-overlapping, 0 to 292,999
  //   CONTRACT_LENGTH  months: 12, 24, 36, 48, 60
  //   VALID_FROM    the first day this price can start. 13 monthly windows on acquisition,
  //                 55 on renewal, and every grid cell carries all of them.
  //   VALID_TO      the LAST possible contract end, capped at 2032-03-08 where the curve
  //                 runs out. NOT the end of the start window, which is why it is ignored:
  //                 3,192 of 29,640 acquisition rows would give a nonsense window if it were.
  //   STANDING_CHARGE  p/day, banded by AQ: 50 / 150 / 200 / 250. Zero in the _UR files.
  //   FINAL_PRICE   p/kWh
  //
  // The _UR files are the same grid with the standing charge rolled into the unit rate:
  // STANDING_CHARGE is 0 on all 29,640 rows and FINAL_PRICE runs up to 12.80 against 9.18.
  // So sc_type comes from the figure, never from the filename.
  //
  // One real gap in their grid: the bands stop at 73,199 and restart at 73,201, so a meter
  // at exactly 73,200 kWh matches nothing. That is TotalEnergies' own boundary (the small/
  // large supply point threshold) and the honest answer is no price, not a guessed one.

  function parseTotalGas(rows, supplierKey, saleScope, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    for (const need of ['productname', 'region', 'aqmin', 'aqmax', 'contractlength',
                        'validfrom', 'standingcharge', 'finalprice']) {
      if (!A.has(need)) throw new Error(`not a TotalEnergies gas layout, missing ${need}`);
    }

    // One pass for the windows, because a ladder cannot be built a row at a time.
    const starts = [];
    for (let n = 1; n < rows.length; n++) {
      if (rows[n] && rows[n].length) starts.push(toDate(A.get(rows[n], 'validfrom')));
    }
    const ladder = startWindowLadder(starts);
    const sorted = [...new Set(starts.filter(Boolean))].sort();
    meta.window_open = sorted[0] || null;
    meta.window_close = sorted.length ? ladder.get(sorted[sorted.length - 1]) : null;

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const r = blankRow(supplierKey, 'gas');
        r.sale_type = saleScope || 'any';
        r.rate_structure = 'single';

        const term = toNum(g('contractlength'));
        if (term == null) throw new Refuse('no contract length');
        r.term_months = Math.round(term);

        const zone = String(g('region') || '').trim().toUpperCase();
        if (!zone) throw new Refuse('no region');
        r.exit_zone = zone;

        // The LDZ is field 2 of PRODUCT_NAME. Cross-check it against the zone rather than
        // trusting either alone: a mismatch means the composite name has been re-cut.
        const pn = String(g('productname') || '').trim();
        r.product_code = pn || null;
        const parts = pn.split('_');
        const ldzFromName = parts.length >= 3 ? parts[1].toUpperCase() : null;
        const ldzFromZone = ldzOfZone(zone);
        if (ldzFromName && ldzFromZone && ldzFromName !== ldzFromZone) {
          throw new Refuse(`LDZ disagrees: "${ldzFromName}" in the product name, `
                         + `"${ldzFromZone}" from region ${zone}`);
        }
        r.ldz = ldzFromName || ldzFromZone;

        r.aq_min = toNum(g('aqmin'));
        r.aq_max = toNum(g('aqmax'));

        const from = toDate(g('validfrom'));
        if (!from) throw new Refuse('no valid-from date');
        r.start_date_min = from;
        r.start_date_max = ladder.get(from) || plusMonthsMinusDay(from, 1);

        r.standing_charge_p_day = sc(g('standingcharge'));
        r.unit_rate_p_kwh = rate(g('finalprice'));
        if (r.unit_rate_p_kwh == null) throw new Refuse('no unit rate on the row');
        // The figure decides, not the filename. A _UR file is the zero standing charge
        // product and says so by carrying 0.
        r.sc_type = (r.standing_charge_p_day === 0 || r.standing_charge_p_day == null)
          ? 'no_sc' : 'with_sc';
        r.payment_method = 'DD';
        r.product_name = r.sc_type === 'no_sc' ? 'Fixed (zero standing charge)' : 'Fixed';
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 7: Corona gas ────────────────────────────────────────────────────────────
  //
  // 109 columns, of which 108 are a template nobody filled in.
  //
  // The scary part is the rate LADDER: Rate1_A through R9_D, sixty-four columns, a block
  // pricing model where one meter's consumption is split into bands each with its own
  // p/kWh. The canonical row holds ONE unit rate and cannot express that. Measured on the
  // real file: all 29,792 rows populate Rate1_A_PER_kWh and nothing else. So the row
  // collapses to a single rate — and any row that ever uses a second block is refused by
  // name rather than quietly losing the blocks past the first.
  //
  // THE STANDING CHARGE IS IN POUNDS PER DAY, not pence, despite the column being called
  // DYLY_STDG_CHRG and every other supplier publishing pence. Confirmed by CES and by the
  // arithmetic: at a 55,000 kWh EA1 site the raw figure is 5.46, and 546 p/day alongside
  // Corona's 5.02 p/kWh unit rate gives GBP 4,754 a year, against SSE at GBP 5,087 and
  // Ecotricity at GBP 3,720. Read as pence it would be GBP 2,781 and Corona would win every
  // gas quote in the portfolio by a quarter.
  //
  // Ignored on purpose: DELPHISTART / DELPHIEND are a credit-score gate and CES never
  // credit checks. Recorded here as an explicit decision, not dropped silently.

  const CORONA_GAS_PRODUCT = { f: 'Fixed', ff: 'Fixed FF', standard: 'Standard (deemed)' };

  function parseCoronaGas(rows, supplierKey, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    for (const need of ['dnoexitzone', 'fixedrateperiod', 'minconsumption', 'maxconsumption',
                        'rate1aperkwh', 'dylystdgchrg']) {
      if (!A.has(need)) throw new Error(`not a Corona gas layout, missing ${need}`);
    }
    // Every rate-block column past the first, matched on the raw header text, so a file
    // that starts using block pricing is caught rather than losing the later blocks.
    const blockCols = header
      .map((h, i) => [String(h == null ? '' : h), i])
      .filter(([h]) => /^(Rate[1-9]|R9)_[B-D]_PER_kWh$/i.test(h.trim()))
      .map(([, i]) => i);

    // The ledger shows the supply-start window this book covers, so record the span across
    // all three of Corona's windows rather than leaving it blank.
    const ssd = [], lsd = [];
    for (let n = 1; n < rows.length; n++) {
      if (!rows[n] || !rows[n].length) continue;
      const a = toDate(A.get(rows[n], 'firstssd')), b = toDate(A.get(rows[n], 'lastssd'));
      if (a) ssd.push(a); if (b) lsd.push(b);
    }
    meta.window_open = ssd.length ? ssd.sort()[0] : null;
    meta.window_close = lsd.length ? lsd.sort()[lsd.length - 1] : null;

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const extra = blockCols.filter((i) => { const v = toNum(row[i]); return v != null && v !== 0; });
        if (extra.length) {
          throw new Refuse(`row uses ${extra.length} rate block(s) past the first — `
                         + 'block pricing cannot be expressed as one unit rate');
        }

        const r = blankRow(supplierKey, 'gas');
        r.sale_type = 'any';                 // no acquisition/renewal split in this file
        r.rate_structure = 'single';

        const term = toNum(g('fixedrateperiod'));
        if (term == null) throw new Refuse('no fixed rate period');
        r.term_months = Math.round(term);

        const zone = String(g('dnoexitzone') || '').trim().toUpperCase();
        if (!zone) throw new Refuse('no exit zone');
        r.exit_zone = zone;
        r.ldz = ldzOfZone(zone);           // LLFC and MTC are 'None' on every row

        r.aq_min = toNum(g('minconsumption'));
        r.aq_max = toNum(g('maxconsumption'));
        r.start_date_min = toDate(g('firstssd'));
        r.start_date_max = toDate(g('lastssd'));
        r.quote_valid_from = toDate(g('onsalefrom'));
        r.quote_valid_to = toDate(g('onsaleto'));

        r.unit_rate_p_kwh = rate(g('rate1aperkwh'));
        if (r.unit_rate_p_kwh == null) throw new Refuse('no unit rate on the row');

        // POUNDS per day -> pence per day. See the note above; this x100 is the whole
        // difference between Corona being competitive and Corona winning everything.
        const scRaw = toNum(g('dylystdgchrg'));
        r.standing_charge_p_day = scRaw == null ? null : sc(Math.round(scRaw * 100 * 1e4) / 1e4);
        r.sc_type = (r.standing_charge_p_day === 0) ? 'no_sc' : 'with_sc';

        const pt = key(g('producttype'));
        r.product_name = CORONA_GAS_PRODUCT[pt] || String(g('producttype') || '').trim() || null;
        r.product_code = String(g('suppliertariffcode') || '').trim() || null;
        r.green = toBool(g('renewableenergy'));
        r.amr = toBool(g('amr'));
        r.payment_method = 'DD';
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 8: Corona power ──────────────────────────────────────────────────────────
  //
  // Twenty-four honest columns. Two things need care.
  //
  // The distributor is given ONLY as a GSP group letter (_A to _P), so it goes through
  // GSP_TO_DNO above, which is measured rather than counted.
  //
  // The rate structure is prose with the band glued on the end: "Small Non Domestic
  // Evening Weekend - Band 1". The band is also in its own column, and the two agree on
  // every row, so the column is used and the suffix stripped.
  //
  // Band N is NOT a TCR band. It is the non-domestic aggregated / related-MPAN case (616
  // rows). Those are refused: a null band would match every meter in the portfolio.
  //
  // Rate 1/2/3 map differently per structure, and the structure is taken from WHICH RATES
  // ARE PRESENT, not from the label. 224 of the 1,904 rows labelled three-rate carry only
  // two rates, and calling those a three-rate tariff would put a night rate in an
  // evening/weekend box.

  const CORONA_PWR_STRUCT = {
    'small non domestic unrestricted':                   'single',
    'standard small non domestic two rate':              'day_night',
    'small non domestic evening weekend':                'eve_weekend',
    'small non domestic three rate evening weekend':     'day_night_ew',
    'non domestic off peak':                             'off_peak',
  };

  function parseCoronaPower(rows, supplierKey, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    for (const need of ['supplyzone', 'profile', 'tarifflengthmonths', 'ratestructure',
                        'rate1pkwh', 'dailychargepday']) {
      if (!A.has(need)) throw new Error(`not a Corona power layout, missing ${need}`);
    }
    const ssd = [], lsd = [];
    for (let n = 1; n < rows.length; n++) {
      if (!rows[n] || !rows[n].length) continue;
      const a = toDate(A.get(rows[n], 'firstsupplystartdate'));
      const b = toDate(A.get(rows[n], 'lastsupplystartdate'));
      if (a) ssd.push(a); if (b) lsd.push(b);
    }
    meta.window_open = ssd.length ? ssd.sort()[0] : null;
    meta.window_close = lsd.length ? lsd.sort()[lsd.length - 1] : null;

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const r = blankRow(supplierKey, 'electricity');
        r.sale_type = 'any';

        const term = toNum(g('tarifflengthmonths'));
        if (term == null) throw new Refuse('no tariff length');
        r.term_months = Math.round(term);

        r.dno_id = gspToDno(g('supplyzone'));
        r.gsp_group = String(g('supplyzone') || '').trim().replace(/^_/, '') || null;
        const pc = toNum(g('profile'));
        r.profile_class = pc == null ? null : Math.round(pc);

        const bandTxt = String(g('band') || '').trim();
        if (/^band\s*n$/i.test(bandTxt)) {
          throw new Refuse('Band N is the aggregated related-MPAN tariff, not a TCR band');
        }
        r.tcr_band = tcrBand(bandTxt);

        r.aq_min = toNum(g('minimumconsumptionkwh'));
        r.aq_max = toNum(g('maximumconsumptionkwh'));
        r.start_date_min = toDate(g('firstsupplystartdate'));
        r.start_date_max = toDate(g('lastsupplystartdate'));
        r.quote_valid_from = toDate(g('onsalefrom'));
        r.quote_valid_to = toDate(g('onsaleto'));

        const label = String(g('ratestructure') || '').trim()
          .replace(/\s*-\s*(band\s*\d|band\s*n|non-domestic aggregated.*)$/i, '')
          .toLowerCase().replace(/\s+/g, ' ');
        const declared = CORONA_PWR_STRUCT[label];
        if (!declared) throw new Refuse(`unmapped Corona rate structure "${g('ratestructure')}"`);

        const r1 = rate(g('rate1pkwh')), r2 = rate(g('rate2pkwh')), r3 = rate(g('rate3pkwh'));
        if (r1 == null) throw new Refuse('no unit rate on the row');
        if (declared === 'single') { r.unit_rate_p_kwh = r1; r.rate_structure = 'single'; }
        else if (declared === 'off_peak') {
          // One rate covering the whole supply. It goes in the unit rate so it can actually
          // be priced; rate_structure still says off_peak so the matcher knows what it is.
          r.unit_rate_p_kwh = r1; r.rate_structure = 'off_peak';
        } else if (declared === 'eve_weekend') {
          r.unit_rate_p_kwh = r1; r.eve_weekend_p_kwh = r2;
          r.rate_structure = r2 == null ? 'single' : 'eve_weekend';
        } else if (declared === 'day_night') {
          r.day_rate_p_kwh = r1; r.night_rate_p_kwh = r2;
          if (r2 == null) { r.unit_rate_p_kwh = r1; r.day_rate_p_kwh = null; r.rate_structure = 'single'; }
          else r.rate_structure = 'day_night';
        } else {
          // Three-rate. Downgrade to two if the third rate is not there, because 224 rows
          // labelled three-rate carry only two.
          r.day_rate_p_kwh = r1; r.night_rate_p_kwh = r2; r.eve_weekend_p_kwh = r3;
          r.rate_structure = r3 == null ? (r2 == null ? 'single' : 'day_night') : 'day_night_ew';
          if (r2 == null) { r.unit_rate_p_kwh = r1; r.day_rate_p_kwh = null; }
        }

        r.standing_charge_p_day = sc(g('dailychargepday'));
        r.sc_type = (r.standing_charge_p_day === 0) ? 'no_sc' : 'with_sc';
        r.green = toBool(g('greentariff'));
        r.product_name = String(g('producttype') || '').trim() || null;   // Fixed / Standard
        r.product_code = String(g('tariffcode') || '').trim() || null;
        r.payment_method = String(g('payment') || '').trim() || null;
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 9: Ecotricity ────────────────────────────────────────────────────────────
  //
  // Small, clean, and the only supplier here with NO TERM COLUMN. The term is the gap
  // between Start Date and End Date, which gives 12/18/24 on power and 12/18/24/30/36 on
  // gas. Those 18 and 30 month terms are real products and the portal has to offer them.
  //
  // Power carries the distributor id outright (the "Digit code" column), which is where
  // GSP_TO_DNO above was measured from. It also carries an "Other LLFs" column listing
  // every LLFC that shares the price — 1,824 of 2,688 rows have a list. That is ignored on
  // purpose: Ecotricity states the TCR band directly, the band is what the matcher uses,
  // and exploding one row into six LLFC rows would multiply the book for nothing.
  //
  // Gas is keyed on LDZ and EUC only, with no exit zone at all, so exit_zone stays null and
  // matches any zone within the LDZ. That is Ecotricity's own granularity, not a gap.

  function parseEcotricity(rows, supplierKey, fuel, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    const isGas = A.has('euc') || fuel === 'gas';
    if (isGas) {
      for (const need of ['startdate', 'enddate', 'ldz', 'unitrate', 'standingcharge']) {
        if (!A.has(need)) throw new Error(`not an Ecotricity gas layout, missing ${need}`);
      }
    } else {
      for (const need of ['pc', 'digitcode', 'banding', 'scpday']) {
        if (!A.has(need)) throw new Error(`not an Ecotricity power layout, missing ${need}`);
      }
    }

    const startKey = isGas ? 'startdate' : 'startdate';
    const starts = [];
    for (let n = 1; n < rows.length; n++) {
      if (rows[n] && rows[n].length) starts.push(toDate(A.get(rows[n], startKey)));
    }
    const ladder = startWindowLadder(starts);
    const sorted = [...new Set(starts.filter(Boolean))].sort();
    meta.window_open = sorted[0] || null;
    meta.window_close = sorted.length ? ladder.get(sorted[sorted.length - 1]) : null;

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const r = blankRow(supplierKey, isGas ? 'gas' : 'electricity');
        r.sale_type = 'any';
        // Ecotricity is a 100% renewable supplier; every row is green whether it says so
        // or not, and the file does not say so.
        r.green = true;

        const from = toDate(g(startKey));
        const to = toDate(g('enddate'));
        if (!from) throw new Refuse('no start date');
        r.term_months = termFromDates(from, to);
        r.start_date_min = from;
        r.start_date_max = ladder.get(from) || plusMonthsMinusDay(from, 1);

        if (isGas) {
          r.rate_structure = 'single';
          r.ldz = String(g('ldz') || '').trim().toUpperCase() || null;
          if (!r.ldz) throw new Refuse('no LDZ');
          r.product_code = String(g('euc') || '').trim() || null;
          r.aq_min = toNum(g('lowerband'));
          r.aq_max = toNum(g('upperband'));
          r.unit_rate_p_kwh = rate(g('unitrate'));
          r.standing_charge_p_day = sc(g('standingcharge'));
          if (r.unit_rate_p_kwh == null) throw new Refuse('no unit rate on the row');
        } else {
          const pc = toNum(g('pc'));
          r.profile_class = pc == null ? null : Math.round(pc);
          r.dno_id = dnoId(g('digitcode'));
          r.gsp_group = String(g('region') || '').trim().replace(/^_/, '') || null;
          r.tcr_band = tcrBand(g('banding'));
          r.product_code = String(g('llfc') || '').trim() || null;
          r.standing_charge_p_day = sc(g('scpday'));

          const single = rate(g('singleur'));
          const day = rate(g('dayur'));
          const night = rate(g('nightur'));
          if (day != null && night != null) {
            r.day_rate_p_kwh = day; r.night_rate_p_kwh = night; r.rate_structure = 'day_night';
          } else if (single != null) {
            r.unit_rate_p_kwh = single; r.rate_structure = 'single';
          } else {
            throw new Refuse('no unit rate on the row');
          }
        }
        r.sc_type = (r.standing_charge_p_day === 0) ? 'no_sc' : 'with_sc';
        r.product_name = 'Ecotricity Fixed';
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 10: SSE ──────────────────────────────────────────────────────────────────
  //
  // Power on sheet OutputFile, gas on sheet SSE Choice. Both carry an explicit Term, so no
  // date arithmetic, and both give only the first day of the start window, so the ladder
  // applies: power ships two windows six months apart, gas eight monthly ones.
  //
  // The five tariff structure codes are mapped from SSE's OWN descriptions and from which
  // rate columns each one actually fills, checked on the real file:
  //
  //   NHH_UNREST  "NHH unrestricted"                        Unrestricted            -> single
  //   NHH_DN      "NHH day/night"                           Day + Night             -> day_night
  //   NHH_DN_EW   "NHH weekday/night/evening & weekend"     Weekday + Night + E&W   -> day_night_ew
  //   NHH_EWN_WD  "NHH evening, weekend & night / weekday"  Weekday + Non Weekday   -> day_night
  //   OFF_PEAK    "NHH off-peak"                            Off Peak                -> off_peak
  //
  // NHH_EWN_WD deserves its note. It is a TWO register tariff where register two is
  // everything that is not a weekday, so it is a day/night shape with an unusual split, not
  // an evening-and-weekend tariff. Mapped here rather than in the shared STRUCT table
  // precisely because the shared table is used by the BKF parser for four other suppliers
  // and this column semantics is SSE's alone. Anyone quoting one should know the 70/30 day
  // split assumption is doing more work than usual.
  //
  // TCR Band arrives as "LV No MIC 1", so the band number is taken and the voltage recorded
  // separately: these are all LV supplies with no maximum import capacity.

  const SSE_STRUCT = {
    nhh_unrest: 'single',
    nhh_dn:     'day_night',
    nhh_dn_ew:  'day_night_ew',
    nhh_ewn_wd: 'day_night',
    off_peak:   'off_peak',
  };

  function parseSse(rows, supplierKey, fuel, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    const isGas = A.has('exitzone') || (!A.has('gspregion') && fuel === 'gas');
    if (isGas) {
      for (const need of ['term', 'exitzone', 'ldz', 'unitratepkwh']) {
        if (!A.has(need)) throw new Error(`not an SSE gas layout, missing ${need}`);
      }
    } else {
      for (const need of ['gspregion', 'profileclass', 'tariffstructure', 'term']) {
        if (!A.has(need)) throw new Error(`not an SSE power layout, missing ${need}`);
      }
    }

    const dateKey = isGas ? 'startdate' : 'startdate';
    const starts = [];
    for (let n = 1; n < rows.length; n++) {
      if (rows[n] && rows[n].length) starts.push(toDate(A.get(rows[n], dateKey)));
    }
    const ladder = startWindowLadder(starts);
    const sorted = [...new Set(starts.filter(Boolean))].sort();
    meta.window_open = sorted[0] || null;
    meta.window_close = sorted.length ? ladder.get(sorted[sorted.length - 1]) : null;

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const r = blankRow(supplierKey, isGas ? 'gas' : 'electricity');
        r.sale_type = 'any';                 // SSE's matrix does not split acq from renewal

        const term = toNum(g('term'));
        if (term == null) throw new Refuse('no term');
        r.term_months = Math.round(term);

        const from = toDate(g(dateKey));
        if (from) {
          r.start_date_min = from;
          r.start_date_max = ladder.get(from) || plusMonthsMinusDay(from, 1);
        }
        // Quotation and Matrix are SSE's own reference ids, and a broker being able to quote
        // the matrix number back to them is worth keeping.
        r.product_code = [String(g('matrix') || '').trim(), String(g('reference') || '').trim()]
          .filter(Boolean).join('/') || null;
        r.product_name = 'SSE Choice';

        if (isGas) {
          r.rate_structure = 'single';
          r.exit_zone = String(g('exitzone') || '').trim().toUpperCase() || null;
          r.ldz = String(g('ldz') || '').trim().toUpperCase() || null;
          r.aq_min = toNum(g('consumptionlowerband'));
          r.aq_max = toNum(g('consumptionupperband'));
          r.unit_rate_p_kwh = rate(g('unitratepkwh'));
          r.standing_charge_p_day = sc(g('standardchargeratepenceperday', 'standardchargerate'));
          if (r.unit_rate_p_kwh == null) throw new Refuse('no unit rate on the row');
        } else {
          r.dno_id = dnoId(g('gspregion'));
          const pcTxt = String(g('profileclass') || '');
          const pcm = pcTxt.match(/(\d)/);
          if (!pcm) throw new Refuse(`cannot read a profile class from "${pcTxt}"`);
          r.profile_class = Number(pcm[1]);

          const bandTxt = String(g('tcrband') || '').trim();
          r.tcr_band = tcrBand(bandTxt);
          if (/no\s*mic/i.test(bandTxt)) r.voltage_level = 'LV_noMIC';
          else if (/^lv[\s-]*sub/i.test(bandTxt)) r.voltage_level = 'LV-SUB';
          else if (/^lv/i.test(bandTxt)) r.voltage_level = 'LV';

          r.aq_min = toNum(g('minconsumption'));
          r.aq_max = toNum(g('maxconsumption'));
          r.standing_charge_p_day = sc(g('standingchargeratepenceperday', 'standingchargerate'));

          const raw = String(g('tariffstructure') || '').trim().toUpperCase();
          if (!(raw.toLowerCase() in SSE_STRUCT)) {
            throw new Refuse(`unmapped SSE tariff structure "${raw}"`);
          }

          const unrest  = rate(g('unrestrictedunitratepkwh', 'unrestrictedunitrate'));
          const day     = rate(g('dayunitratepkwh'));
          const night   = rate(g('nightunitratepkwh'));
          const weekday = rate(g('weekdayunitratepkwh'));
          const nonwd   = rate(g('nonweekdayunitratepkwh'));
          const ew      = rate(g('eveningweekendunitratepkwh'));
          const offpk   = rate(g('offpeakunitratepkwh'));

          if (raw === 'NHH_UNREST')      { r.unit_rate_p_kwh = unrest; r.rate_structure = 'single'; }
          else if (raw === 'OFF_PEAK')   { r.unit_rate_p_kwh = offpk;  r.rate_structure = 'off_peak'; }
          else if (raw === 'NHH_DN')     { r.day_rate_p_kwh = day; r.night_rate_p_kwh = night;
                                           r.rate_structure = 'day_night'; }
          else if (raw === 'NHH_DN_EW')  { r.day_rate_p_kwh = weekday; r.night_rate_p_kwh = night;
                                           r.eve_weekend_p_kwh = ew; r.rate_structure = 'day_night_ew'; }
          else if (raw === 'NHH_EWN_WD') { r.day_rate_p_kwh = weekday; r.night_rate_p_kwh = nonwd;
                                           r.rate_structure = 'day_night'; }
          else throw new Refuse(`unmapped SSE tariff structure "${raw}"`);

          if (['unit_rate_p_kwh', 'day_rate_p_kwh'].every((k) => r[k] == null)) {
            throw new Refuse(`no unit rate on the row for structure ${raw}`);
          }
        }
        r.sc_type = (r.standing_charge_p_day === 0) ? 'no_sc' : 'with_sc';
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Adapter 11: TotalEnergies power ──────────────────────────────────────────────────
  //
  // The most detailed pricebook of the thirteen, and the biggest by an order of magnitude:
  // eight CSVs inside two .7z archives, 459 MB uncompressed, 4,212,736 rows.
  //
  //   PRODUCT_NAME  "YELG 2R B3 04_0153_2C"
  //                 DNO abbreviation, register count, TCR BAND, then PC_SSC_DUoS.
  //                 The band is ONLY here — there is no band column — so it is read out of
  //                 the name, and a name that does not carry one is refused rather than
  //                 quoted at a guessed band.
  //   DIST_ID       10-23, given outright
  //   PC            03 or 04
  //   SSC           215 distinct Standard Settlement Configurations
  //   DUOS_TARIFF_ID_CODES  131 distinct, sometimes several codes in one cell ("13 37 N10")
  //   MIN_CONS / MAX_CONS   11 consumption bands
  //   CONTRACT_LENGTH       12 / 24 / 36 / 48 / 60 months
  //   VALID_FROM    5 quarterly supply-start windows
  //   STANDING_CHARGE  p/day, 347 distinct values up to 1,078 — the TCR residual is in
  //                    here, which is why it is ten times a gas standing charge
  //   UNITS, DAY_UNITS, NIGHT_UNITS, EVE_WE_UNITS, WEEKDAY_UNITS, WINTER_EVE
  //
  // THE REGISTER COUNT IN THE NAME IS NOT RELIABLE, so it is not used. Measured on the
  // acquisition file: "2R" rows appear as day+night (245,300), as weekday+eve/weekend
  // (14,300) and as day+eve/weekend (6,600); "3R" rows appear with three registers (19,800)
  // and with only two (7,700); and 5,225 "1R" rows carry their single rate in NIGHT_UNITS
  // with everything else blank. So the structure is taken from WHICH COLUMNS ARE FILLED,
  // the same rule that stopped EDF pricing at nothing.
  //
  // WINTER_EVE is a sixth register (3,300 rows, 1%) and the canonical row has no column for
  // it. Those rows are refused BY NAME rather than loaded with the winter rate silently
  // dropped, which is how British Gas's 4/5/6-rate STOD rows are handled too.
  //
  // The eight files are one product each: acquisition or renewal, standard or _UR (zero
  // standing charge, rolled into the unit rate), plain or _ECO (green). Sale type and green
  // both come from the PRODUCT, because nothing in the rows says either.

  /**
   * How far ahead a TotalEnergies power supply-start window is worth keeping, in months.
   * CES quotes renewals up to two years out; TotalEnergies publishes four and a half.
   */
  const TE_HORIZON_MONTHS = 24;

  /** DNO abbreviation as TotalEnergies writes it, cross-checked against DIST_ID. */
  const TE_DNO_ABBR = {
    EELC: '10', EMEB: '11', LOND: '12', MANW: '13', MIDE: '14', NEEB: '15', NORW: '16',
    HYDE: '17', SPOW: '18', SEEB: '19', SOUT: '20', SWAE: '21', SWEB: '22', YELG: '23',
  };

  function parseTotalPower(rows, supplierKey, saleScope, green, onRow, onRefuse, meta) {
    const header = rows[0];
    const A = accessor(header);
    for (const need of ['productname', 'distid', 'pc', 'mincons', 'maxcons',
                        'contractlength', 'validfrom', 'standingcharge']) {
      if (!A.has(need)) throw new Error(`not a TotalEnergies power layout, missing ${need}`);
    }

    const starts = [];
    for (let n = 1; n < rows.length; n++) {
      if (rows[n] && rows[n].length) starts.push(toDate(A.get(rows[n], 'validfrom')));
    }
    const ladder = startWindowLadder(starts);
    const sorted = [...new Set(starts.filter(Boolean))].sort();
    meta.window_open = sorted[0] || null;

    // THE 24 MONTH HORIZON. TotalEnergies ships 5 quarterly start windows on acquisition
    // and NINETEEN on renewal, running to March 2031 — 300,564 rows per renewal file are
    // for supply starting more than two years out, and that far end of the curve is where
    // the nonsense lives: night rates of -1.0000, 0.6 and 0.8 p/kWh sitting beside day
    // rates of 22 to 24p on the 2031-03 rows.
    //
    // CES quotes renewals up to two years ahead, so anything past that is refused BY NAME.
    // It is 25% of the whole book and it is not a silent drop: the ledger shows the count
    // and the reason.
    const horizonEnd = sorted.length ? plusMonthsMinusDay(sorted[0], TE_HORIZON_MONTHS + 1) : null;
    const kept = sorted.filter((d) => !horizonEnd || d <= horizonEnd);
    meta.window_close = kept.length ? ladder.get(kept[kept.length - 1]) : null;

    for (let n = 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const r = blankRow(supplierKey, 'electricity');
        r.sale_type = saleScope || 'any';
        r.green = !!green;
        r.payment_method = 'DD';
        r.product_name = green ? 'Fixed ECO' : 'Fixed';

        const term = toNum(g('contractlength'));
        if (term == null) throw new Refuse('no contract length');
        r.term_months = Math.round(term);

        r.dno_id = dnoId(g('distid'));
        if (!r.dno_id) throw new Refuse('no distributor id');
        const pc = toNum(g('pc'));
        r.profile_class = pc == null ? null : Math.round(pc);

        // The band lives inside the product name and nowhere else. "YELG 2R B3 04_0153_2C".
        const pn = String(g('productname') || '').trim();
        // SSC and the DUoS tariff codes are the finest key any of these books uses, and
        // meters carries neither, so they go in the code where a broker can at least see
        // which configuration a price came from.
        r.product_code = [pn, String(g('ssc') || '').trim(),
                          String(g('duostariffidcodes') || '').trim()]
                         .filter(Boolean).join(' | ') || null;
        const parts = pn.split(/\s+/);
        const bm = pn.match(/\bB([1-4])\b/);
        if (!bm) throw new Refuse(`no TCR band in the product name "${pn}"`);
        r.tcr_band = 'band_' + bm[1];

        // Cross-check the DNO abbreviation against DIST_ID. They agree on every row today,
        // and if they ever stop the composite name has been re-cut and nothing else here
        // can be trusted either.
        const abbr = (parts[0] || '').toUpperCase();
        if (abbr in TE_DNO_ABBR && TE_DNO_ABBR[abbr] !== r.dno_id) {
          throw new Refuse(`distributor disagrees: "${abbr}" is ${TE_DNO_ABBR[abbr]}, `
                         + `DIST_ID says ${r.dno_id}`);
        }

        r.aq_min = toNum(g('mincons'));
        r.aq_max = toNum(g('maxcons'));

        const from = toDate(g('validfrom'));
        if (!from) throw new Refuse('no valid-from date');
        if (horizonEnd && from > horizonEnd) {
          throw new Refuse(`supply starts ${from}, past the ${TE_HORIZON_MONTHS} month `
                         + `horizon (${horizonEnd}) — that end of the curve carries `
                         + 'extrapolated rates');
        }
        r.start_date_min = from;
        r.start_date_max = ladder.get(from) || plusMonthsMinusDay(from, 3);

        r.standing_charge_p_day = sc(g('standingcharge'));
        r.sc_type = (r.standing_charge_p_day === 0) ? 'no_sc' : 'with_sc';

        // A winter evening register the canonical row cannot hold. Refuse rather than load
        // the row with that rate quietly missing.
        const winter = rate(g('wintereve', 'winterevunits'));
        if (winter != null) {
          throw new Refuse('has a WINTER_EVE register, which this engine does not price');
        }

        const single  = rate(g('units'));
        const day     = rate(g('dayunits'));
        const night   = rate(g('nightunits'));
        const ew      = rate(g('eveweunits'));
        const weekday = rate(g('weekdayunits'));

        // Structure from what is FILLED, never from the "1R"/"2R"/"3R" token, which
        // disagrees with the columns on 28,600 rows of the acquisition file alone.
        const filled = [
          ['unit', single], ['day', day], ['night', night], ['ew', ew], ['weekday', weekday],
        ].filter(([, v]) => v != null);
        if (!filled.length) throw new Refuse('no unit rate on the row');

        const has = (k) => filled.some(([n2]) => n2 === k);
        if (filled.length === 1) {
          // One register is a single rate whichever column it sits in: 5,225 rows put it in
          // NIGHT_UNITS with everything else blank.
          r.unit_rate_p_kwh = filled[0][1];
          r.rate_structure = 'single';
        } else if (has('day') && has('night') && has('ew')) {
          r.day_rate_p_kwh = day; r.night_rate_p_kwh = night; r.eve_weekend_p_kwh = ew;
          r.rate_structure = 'day_night_ew';
        } else if (has('night') && has('ew') && has('weekday')) {
          // Weekday plus night plus evening/weekend: the weekday register is the day one.
          r.day_rate_p_kwh = weekday; r.night_rate_p_kwh = night; r.eve_weekend_p_kwh = ew;
          r.rate_structure = 'day_night_ew';
        } else if (has('day') && has('night')) {
          r.day_rate_p_kwh = day; r.night_rate_p_kwh = night; r.rate_structure = 'day_night';
        } else if (has('weekday') && has('night')) {
          r.day_rate_p_kwh = weekday; r.night_rate_p_kwh = night; r.rate_structure = 'day_night';
        } else if (has('weekday') && has('ew')) {
          r.unit_rate_p_kwh = weekday; r.eve_weekend_p_kwh = ew; r.rate_structure = 'eve_weekend';
        } else if (has('day') && has('ew')) {
          r.unit_rate_p_kwh = day; r.eve_weekend_p_kwh = ew; r.rate_structure = 'eve_weekend';
        } else {
          throw new Refuse('unmapped register combination: '
                         + filled.map(([k]) => k).join('+'));
        }
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
  }

  // ── Where the header row actually is ─────────────────────────────────────────────────
  //
  // Every supplier up to now put its column names on row 1. SEFE does not: the flat file
  // has a blank first row and a blank first column, and the matrix file has the issue date,
  // a group banner and a units row above its header. So the LAYOUT GATE was hashing a row
  // of empty cells, which would have registered "blank" as SEFE's fingerprint and then
  // matched any other file that also happened to start blank.
  //
  // The parser knows where its own header lives, so it says. Anything not listed keeps the
  // old behaviour of row 0.
  /**
   * Which row holds the column names.
   *
   * FOUND BY CONTENT, never by a row number. The first version of this used fixed indices
   * (5 for the matrix, 1 for the flat file) taken from reading the files in a spreadsheet,
   * and it broke instantly: the portal reads sheets with `blankrows: false`, which drops
   * SEFE's empty preamble rows and shifts everything up. A row number is a fact about how
   * the file was READ, not about the file.
   *
   * So: the header is the first row that names the columns this parser needs. Anything
   * above it is preamble and anything below is data.
   */
  function headerRowIndex(parserKey, rows, sheetName) {
    if (parserKey === 'sefe') return sefeHeaderRow(rows);
    return 0;
  }

  /** The row that carries 'band' and 'ldz'. -1 if this is not a SEFE price sheet. */
  function sefeHeaderRow(rows) {
    for (let i = 0; i < Math.min(30, rows.length); i++) {
      const cells = (rows[i] || []).map(c => key(c));
      if (cells.includes('band') && cells.includes('ldz')) return i;
    }
    return -1;
  }

  /**
   * matrix or flat, decided on the HEADER'S OWN COLUMNS.
   *
   * Not on the sheet name and not on the filename: the flat file's sheet is called
   * "3. Flatfile excl. zero SC" and that leading number is exactly the sort of thing a
   * supplier renumbers between releases.
   */
  function sefeShape(rows, sheetName) {
    const h = sefeHeaderRow(rows);
    if (h >= 0) {
      const cells = (rows[h] || []).map(c => key(c));
      if (cells.includes('contractstartmonths')) return 'matrix';
      if (cells.includes('contractstartdatefrom')) return 'flat';
    }
    // Fall back to the names only if the header is unreadable.
    if (/matrix\s*prices/i.test(String(sheetName || ''))) return 'matrix';
    return 'flat';
  }

  // ── Adapter 12: SEFE Energy, gas only ────────────────────────────────────────────────
  //
  // SEFE send the same prices twice, in two shapes, and the pair cross-validate perfectly:
  // all 9,880 rows of the flat file are identical to the matrix file's Standard rates, to
  // the last decimal. The matrix file carries 494 rows the flat file does not (one extra
  // supply-start window), so it is the better upload, but both are accepted and both route
  // to the same product — whichever arrives replaces the other.
  //
  //   MATRIX  sheet "Matrix prices", header on row 5.
  //     band | LDZ | Contract term (Months) | Contract start (months) | Demand | UR cost |
  //     SC cost | Total cost | then THREE pairs of UR/SC: Standard, low SC, zero SC.
  //     Only Standard carries numbers today — low SC is blank on every priced row and zero
  //     SC is "N/A" on all 46,620 — so the other two are read but expected to be absent.
  //     36,246 of the rows are "N/A" throughout: combinations SEFE does not price.
  //     Demand / UR cost / SC cost / Total cost are a worked example on a nominal demand,
  //     NOT rates, and are ignored.
  //
  //   FLAT    sheet "3. Flatfile excl. zero SC", header on row 1, blank column A.
  //     Matrix | Band | Min | Max | Contract Duration | LDZ | Contract startdatefrom |
  //     Contract startdateto | Standing Charge (£/day) | Unit Rate (p/kWh)
  //
  // THE STANDING CHARGE IS POUNDS PER DAY. Both files label it so, which is a mercy after
  // Corona. 0.634 to 19.806 £/day becomes 63 to 1,981 p/day, which lines up with the other
  // gas suppliers across the same consumption bands.
  //
  // THE CONTRACT START IS AN OFFSET IN THE MATRIX FILE, in whole months from
  // matrix_issue_date in cell D3. Offset 0 against the 3 Sep 2026 issue gives a window of
  // 03/09/2026 to 02/10/2026, which is exactly what the flat file states for the same rows.
  //
  // SEFE price on the LDZ ALONE — there is no exit zone anywhere in either file — so
  // exit_zone stays null and matches any zone inside the LDZ. That is their granularity,
  // not a gap. Band 1 (1 to 2,000 kWh) is priced in neither file, so the smallest sites get
  // no SEFE price rather than a borrowed one.
  //
  // The rates are COMMISSION-FREE. The workbook's own "Single site pricing" sheet has
  // inputs for commission type, commission p/kWh and commission £/day, and shows the
  // Standard product rates separately — so these are the raw supplier prices and CES's
  // uplift goes on top, which is what the uplift box on the quote already does.

  function parseSefe(rows, supplierKey, onRow, onRefuse, meta, sheetName, aqBands, latestStart) {
    const shape = sefeShape(rows, sheetName);
    const hRow = sefeHeaderRow(rows);
    if (hRow < 0) throw new Error('no SEFE header row on sheet "' + sheetName + '": no row '
      + 'names both band and LDZ');
    const header = rows[hRow] || [];
    const A = accessor(header);

    if (shape === 'matrix') {
      for (const need of ['band', 'ldz', 'contracttermmonths', 'contractstartmonths']) {
        if (!A.has(need)) throw new Error(`not a SEFE matrix layout, missing ${need}`);
      }
    } else {
      for (const need of ['band', 'min', 'max', 'contractduration', 'ldz',
                          'contractstartdatefrom']) {
        if (!A.has(need)) throw new Error(`not a SEFE flat-file layout, missing ${need}`);
      }
    }

    // The matrix file dates everything off one cell. Without it the offsets are meaningless,
    // so a missing issue date is a hard stop rather than a row-level refusal.
    //
    // It also needs the LATEST START DATE, because the final window is short. Deriving it
    // as a calendar month from the start day put the last window at 2027-10-02 when SEFE's
    // own flat file says 2027-09-30 — 741 rows two days too generous, and a quote for a
    // 1 October start that SEFE would not honour. Their "Single site pricing" sheet states
    // the cap, so it is read rather than guessed.
    let issue = null;
    if (shape === 'matrix') {
      // Anywhere above the header. Its row number moves when blank rows are dropped, so it
      // is found by its own label rather than by position.
      for (let i = 0; i < hRow && !issue; i++) {
        const row = rows[i] || [];
        for (let j = 0; j < row.length - 1; j++) {
          if (key(row[j]) === 'matrixissuedate') { issue = toDate(row[j + 1]); break; }
        }
      }
      if (!issue) throw new Error('no matrix_issue_date in the SEFE matrix file, so the '
        + 'contract-start offsets cannot be turned into dates');
      meta.version = issue;
    }

    // UR and SC repeat three times across the matrix header (Standard, low SC, zero SC), so
    // the accessor's first-wins lookup cannot separate them. Positions instead, taken from
    // the banner row above the header rather than assumed.
    let stdUr = -1, stdSc = -1;
    if (shape === 'matrix') {
      // The "Standard | low SC | zero SC" banner sits above the header, but how far above
      // depends on whether the blank rows survived the read, so it is searched for.
      let at = -1;
      for (let i = hRow - 1; i >= 0 && at < 0; i--) {
        const cells = (rows[i] || []).map(c => key(c));
        const j = cells.indexOf('standard');
        if (j >= 0) at = j;
      }
      const names = header.map(c => key(c));
      for (let j = (at >= 0 ? at : 9); j < names.length; j++) {
        if (stdUr < 0 && names[j] === 'ur') { stdUr = j; continue; }
        if (stdUr >= 0 && names[j] === 'sc') { stdSc = j; break; }
      }
      if (stdUr < 0 || stdSc < 0) {
        throw new Error('cannot find the Standard UR and SC columns in the SEFE matrix');
      }
    }

    const starts = [];
    if (shape === 'flat') {
      for (let n = hRow + 1; n < rows.length; n++) {
        if (rows[n] && rows[n].length) starts.push(toDate(A.get(rows[n], 'contractstartdatefrom')));
      }
    }
    const ladder = shape === 'flat' ? startWindowLadder(starts) : null;
    const sorted = [...new Set(starts.filter(Boolean))].sort();
    if (shape === 'flat') {
      meta.window_open = sorted[0] || null;
      meta.window_close = sorted.length ? ladder.get(sorted[sorted.length - 1]) : null;
    }

    let openest = null, closest = null;
    for (let n = hRow + 1; n < rows.length; n++) {
      const row = rows[n];
      if (!row || !row.some((c) => c !== null && c !== undefined && c !== '')) continue;
      const g = (...names) => A.get(row, ...names);
      try {
        const bandTxt = String(g('band') || '').trim();
        if (!bandTxt) continue;                  // trailing formatting rows

        const r = blankRow(supplierKey, 'gas');
        r.sale_type = 'any';                     // SEFE's matrix does not split acq from renewal
        r.rate_structure = 'single';
        r.payment_method = 'DD';
        r.product_name = 'Matrix (Standard SC)';

        r.ldz = String(g('ldz') || '').trim().toUpperCase() || null;
        if (!r.ldz) throw new Refuse('no LDZ');
        // No exit zone in either file. SEFE price per LDZ, so this stays null and matches
        // any zone inside it.

        let ur, scRaw, from, to, term;
        if (shape === 'matrix') {
          ur = row[stdUr]; scRaw = row[stdSc];
          if (String(ur).trim() === 'N/A' || String(scRaw).trim() === 'N/A') {
            throw new Refuse('SEFE do not price this band, LDZ, term and start together');
          }
          term = toNum(g('contracttermmonths'));
          const off = toNum(g('contractstartmonths'));
          if (off == null) throw new Refuse('no contract-start offset');
          from = addMonths(issue, Math.round(off));
          to = plusMonthsMinusDay(from, 1);
          // SEFE's last window is short. Their own latest-start date is the truth.
          if (latestStart && to > latestStart) to = latestStart;
          if (latestStart && from > latestStart) {
            throw new Refuse(`supply starts ${from}, past SEFE's latest start ${latestStart}`);
          }
        } else {
          ur = g('unitratepkwh'); scRaw = g('standingchargeday', 'standingcharge');
          term = toNum(String(g('contractduration') || '').replace(/[^0-9.]/g, ''));
          from = toDate(g('contractstartdatefrom'));
          if (!from) throw new Refuse('no contract start date');
          // Their own end date, falling back to the ladder if it is ever missing.
          to = toDate(g('contractstartdateto')) || ladder.get(from) || plusMonthsMinusDay(from, 1);
          r.aq_min = toNum(g('min'));
          r.aq_max = toNum(g('max'));
        }

        if (term == null) throw new Refuse('no contract duration');
        r.term_months = Math.round(term);
        r.start_date_min = from;
        r.start_date_max = to;
        if (from && (!openest || from < openest)) openest = from;
        if (to && (!closest || to > closest)) closest = to;

        // The band index only becomes a consumption range via the AQ bands table, which the
        // matrix file carries on its own sheet. Without it the row would match every meter.
        if (r.aq_min == null && aqBands && aqBands[bandTxt]) {
          r.aq_min = aqBands[bandTxt][0];
          r.aq_max = aqBands[bandTxt][1];
        }
        if (r.aq_min == null || r.aq_max == null) {
          throw new Refuse(`band ${bandTxt} has no consumption range, so it would match `
                         + 'every meter');
        }
        r.product_code = `band ${bandTxt} | ${r.ldz}`;

        r.unit_rate_p_kwh = rate(ur);
        if (r.unit_rate_p_kwh == null) throw new Refuse('no unit rate on the row');
        // POUNDS per day -> pence per day. Both files label the column £/day.
        const scN = toNum(scRaw);
        r.standing_charge_p_day = scN == null ? null
          : sc(Math.round(scN * 100 * 1e4) / 1e4);
        r.sc_type = (r.standing_charge_p_day === 0) ? 'no_sc' : 'with_sc';
        onRow(r);
      } catch (e) {
        if (e instanceof Refuse) onRefuse(n + 1, e.message); else throw e;
      }
    }
    if (shape === 'matrix') { meta.window_open = openest; meta.window_close = closest; }
  }

  /** Same day n months on, clamped. Used for SEFE's contract-start offsets. */
  function addMonths(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return isoOf(t);
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────────────────

  /**
   * parse({ parserKey, supplierKey, fuel, sheets }) -> { rows, refusals, meta }
   *
   * `sheets` is [{ name, rows }] where rows is an array of arrays, header first. The caller
   * reads the workbook, because it also has to pick the sheet, and the sheet a supplier
   * hides its data in is a per-supplier fact (UGP's visible sheet is a formula front end).
   */
  function parse(opts) {
    const { parserKey, supplierKey, fuel, sheets, saleScope } = opts;
    const rows = [];
    const refusals = [];
    const meta = { version: null, window_open: null, window_close: null };
    const onRow = (r) => rows.push(r);
    const MAX_KEPT = 200;   // enough to diagnose; the count is what matters at scale
    const onRefuse = (line, reason) => {
      if (refusals.length < MAX_KEPT) refusals.push({ row: line, reason });
      else refusals.overflow = (refusals.overflow || 0) + 1;
    };

    // SEFE's consumption ranges are on a separate sheet, so they are read before any price
    // row is looked at.
    let sefeBands = null, sefeLatestStart = null;
    if (parserKey === 'sefe') {
      // "Latest contract start date:" on the Single site pricing sheet. It caps the final
      // supply-start window, which is shorter than a month.
      for (const sh of sheets) {
        for (const row of (sh.rows || []).slice(0, 40)) {
          for (let j = 0; j < (row || []).length; j++) {
            if (/^latestcontractstartdate/.test(key(row[j]))) {
              for (let k2 = j + 1; k2 < row.length; k2++) {
                const d = toDate(row[k2]);
                if (d) { sefeLatestStart = d; break; }
              }
            }
          }
          if (sefeLatestStart) break;
        }
        if (sefeLatestStart) break;
      }
      const bs = sheets.find(sh => /aq\s*bands/i.test(sh.name || ''));
      if (bs && bs.rows) {
        sefeBands = {};
        for (let i = 2; i < bs.rows.length; i++) {
          const row = bs.rows[i] || [];
          const band = String(row[0] == null ? '' : row[0]).trim();
          const lo = toNum(row[1]), hi = toNum(row[2]);
          if (band && lo != null && hi != null) sefeBands[band] = [lo, hi];
        }
        if (!Object.keys(sefeBands).length) sefeBands = null;
      }
    }

    for (const sheet of sheets) {
      if (!sheet.rows || !sheet.rows.length) continue;
      switch (parserKey) {
        case 'bkf':       parseBkf(sheet.rows, supplierKey, onRow, onRefuse); break;
        case 'bg_long':   parseBgLong(sheet.rows, supplierKey, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        case 'ugp_spark': parseUgp(sheet.rows, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        case 'smartest':  parseSmartest(sheet.rows, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        case 'utilita':   parseUtilita(sheet.rows, onRow, onRefuse, meta); break;
        // TotalEnergies ships gas as 9 columns and power as 17, so the header decides.
        case 'te_gas':
        case 'te_power':
        case 'total_energies': {
          const A = accessor(sheet.rows[0] || []);
          if (A.has('finalprice') || A.has('region')) {
            parseTotalGas(sheet.rows, supplierKey, saleScope, onRow, onRefuse, meta);
          } else if (A.has('distid') || A.has('dayunits')) {
            parseTotalPower(sheet.rows, supplierKey, saleScope, opts.green,
                            onRow, onRefuse, meta);
          } else {
            throw new Error('sheet "' + sheet.name + '" is neither the TotalEnergies gas '
              + 'nor the TotalEnergies power layout');
          }
          break;
        }
        case 'corona_gas':   parseCoronaGas(sheet.rows, supplierKey, onRow, onRefuse, meta); break;
        case 'corona_power': parseCoronaPower(sheet.rows, supplierKey, onRow, onRefuse, meta); break;
        case 'ecotricity':   parseEcotricity(sheet.rows, supplierKey, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        // Corona ships two completely different layouts, 109 columns for gas and 24 for
        // power, so the header decides which. One supplier, one parser key, two shapes.
        case 'corona': {
          const A = accessor(sheet.rows[0] || []);
          if (A.has('dnoexitzone') || A.has('rate1aperkwh')) {
            parseCoronaGas(sheet.rows, supplierKey, onRow, onRefuse, meta);
          } else if (A.has('supplyzone') || A.has('ratestructure')) {
            parseCoronaPower(sheet.rows, supplierKey, onRow, onRefuse, meta);
          } else {
            throw new Error('sheet "' + sheet.name + '" is neither the Corona gas nor the '
              + 'Corona power layout');
          }
          break;
        }
        case 'sse':          parseSse(sheet.rows, supplierKey, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        // SEFE's matrix file gives a BAND INDEX, not a consumption range: the ranges live
        // on their own "AQ bands" sheet. Without it every row would match every meter, so
        // the table is built first and the price sheet is skipped if it is missing.
        case 'sefe': {
          // Only the price sheets carry rows; the others are lookups already read above.
          if (/aq\s*bands|single\s*site|postcode/i.test(sheet.name || '')) break;
          parseSefe(sheet.rows, supplierKey, onRow, onRefuse, meta, sheet.name, sefeBands,
                    sefeLatestStart);
          break;
        }
        default: throw new Error(`no parser called "${parserKey}"`);
      }
    }
    return { rows, refusals, meta };
  }

  root.PricingParsers = {
    /**
     * The version pricing.html checks against its own EXPECTS_PARSERS.
     *
     * Bump this whenever a change alters what a rate MEANS — a new supplier, a unit
     * conversion, a new matching dimension like EDF's selling days. Then bump the same
     * string in pricing.html. If the two disagree the page refuses to parse and says so.
     *
     * This exists because a stale parser does not fail visibly, it writes plausible wrong
     * prices into the database. It happened: the EDF selling-days fix was deployed, CES
     * re-uploaded EDF, and the browser was still running the previous file — so the
     * re-upload wrote 8,916 rows with no selling days and the wrong rate kept winning.
     * Caching headers are the first line of defence and this is the second.
     */
    VERSION: '2026-09-11.1',
    parse, normHeader, readZip, headerRowIndex, CANON_FIELDS, P_KVA_DAY_TO_MONTH,
    // exported for the test suite
    _internals: { saleType, rateStructure, tcrBand, toNum, toDate, toBool, dnoId, rate, sc,
                  capFromDay, key, scType, eonProductName, zipCryptoDecrypt,
                  gspToDno, ldzOfZone, termFromDates, plusMonthsMinusDay, startWindowLadder,
                  dayBefore, monthsBetween, GSP_TO_DNO, ZONE_LDZ, SSE_STRUCT,
                  CORONA_PWR_STRUCT, TE_DNO_ABBR, TE_HORIZON_MONTHS, sefeShape, sefeHeaderRow,
                  addMonths },
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).PricingParsers;
}
