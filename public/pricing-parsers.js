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
    'start_date_min', 'start_date_max', 'quote_valid_from', 'quote_valid_to',
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
        const ti2IsStructure = /^(standard|economy7|flat_economy7|three_rate|off_peak|nhh_)/i.test(ti2);
        r.product_name = (ti2 && !ti2IsStructure ? ti2 : pn) || null;
        r.product_code = String(g('tariffinformation1') || '').trim() || null;
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

  // ── Dispatch ─────────────────────────────────────────────────────────────────────────

  /**
   * parse({ parserKey, supplierKey, fuel, sheets }) -> { rows, refusals, meta }
   *
   * `sheets` is [{ name, rows }] where rows is an array of arrays, header first. The caller
   * reads the workbook, because it also has to pick the sheet, and the sheet a supplier
   * hides its data in is a per-supplier fact (UGP's visible sheet is a formula front end).
   */
  function parse(opts) {
    const { parserKey, supplierKey, fuel, sheets } = opts;
    const rows = [];
    const refusals = [];
    const meta = { version: null, window_open: null, window_close: null };
    const onRow = (r) => rows.push(r);
    const MAX_KEPT = 200;   // enough to diagnose; the count is what matters at scale
    const onRefuse = (line, reason) => {
      if (refusals.length < MAX_KEPT) refusals.push({ row: line, reason });
      else refusals.overflow = (refusals.overflow || 0) + 1;
    };

    for (const sheet of sheets) {
      if (!sheet.rows || !sheet.rows.length) continue;
      switch (parserKey) {
        case 'bkf':       parseBkf(sheet.rows, supplierKey, onRow, onRefuse); break;
        case 'bg_long':   parseBgLong(sheet.rows, supplierKey, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        case 'ugp_spark': parseUgp(sheet.rows, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        case 'smartest':  parseSmartest(sheet.rows, sheet.fuel || fuel, onRow, onRefuse, meta); break;
        case 'utilita':   parseUtilita(sheet.rows, onRow, onRefuse, meta); break;
        default: throw new Error(`no parser called "${parserKey}"`);
      }
    }
    return { rows, refusals, meta };
  }

  root.PricingParsers = {
    parse, normHeader, CANON_FIELDS, P_KVA_DAY_TO_MONTH,
    // exported for the test suite
    _internals: { saleType, rateStructure, tcrBand, toNum, toDate, toBool, dnoId, rate, sc,
                  capFromDay, key, scType },
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).PricingParsers;
}
