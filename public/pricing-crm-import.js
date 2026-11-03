/*
 * pricing-crm-import.js - turns UtilityClick (UC) exports into clean CRM records.
 *
 * One file, two callers, so the rules can never drift apart:
 *   - the pricing desk's "Import UC exports" card (browser, SheetJS reads the xlsx), and
 *   - the Node script that did the first load on 3 Nov 2026.
 *
 * Input: the seven UC exports, each as { name, rows } where rows is an array of arrays
 * (header first) as SheetJS gives it with { header: 1, raw: true }. Dates therefore arrive
 * as Excel serial numbers and are converted here with UTC arithmetic only. (The desk has
 * been bitten twice by local-time Date objects landing a day early under BST.)
 *
 * Output: plain records shaped exactly like the crm_* tables, plus a list of data-quality
 * issues. Nothing here talks to the database.
 *
 * THE RULES THAT MATTER
 *  - UC never moves a contract out of "Live". 22,875 of 26,242 "Live" meter rows ended
 *    before 3 Nov 2026. So whether a contract is live, upcoming or ended is decided from
 *    its DATES, at read time (crm_contracts_v), never stored. status_group only says what
 *    KIND of row it is: a supply contract, a deal still in progress, a lost/void deal, a
 *    contract placed by someone other than CES, or a MOP/DC/DA service line.
 *  - Units are converted from the stated unit and the raw figure is always kept beside the
 *    converted one. Standing charge -> p/day. Capacity -> p/kVA/month (house rule, never
 *    p/kVA/day). Unit rates p/kWh. A converted figure that is implausible is NOT guessed
 *    at: it is left empty and an issue names the raw figure, its label and the likely
 *    reading, because UC's unit labels are wrong often enough to matter.
 *  - A per-kWh rate of exactly 0 is an empty register, not free energy: stored empty.
 *    A standing charge of 0 is real and is kept.
 *  - The sole-trader date of birth in the customer export is deliberately never read.
 */
(function (root) {
  'use strict';

  // .2 (3 Nov, before any push): capacity problems are worded in p/kVA/month only.
  var VERSION = '2026-11-03.2';
  var P_KVA_DAY_TO_MONTH = 365 / 12;          // the house conversion, as pricing-parsers.js
  var CAPACITY_MAX_P_KVA_MONTH = 3000;        // ~100 p/kVA/day: above this it is a label error
  var RATE_MAX_P_KWH = 200;                   // above this a "p/kWh" figure is not p/kWh
  var KVA_MAX = 10000;                        // one portfolio row says 2,000,000 kVA

  // ---------------------------------------------------------------- small helpers
  // Headers and unit labels are compared in a folded ASCII form: the pound sign becomes
  // 'gbp' and a superscript 3 becomes '3' (UC writes 'm' + superscript 3 and pound signs in
  // its headers). Done by character code so this file itself stays pure ASCII.
  function fold(s) {
    var o = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 163) o += 'gbp'; else if (c === 179) o += '3'; else if (c === 178) o += '2';
      else if (c < 128) o += s[i];
    }
    return o;
  }
  function norm(h) { return fold(String(h == null ? '' : h)).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function txt(v) {
    if (v == null) return null;
    var s = String(v).replace(/\r\n/g, '\n').trim();
    return s === '' ? null : s;
  }
  function num(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = fold(String(v)).replace(/gbp/ig, '').replace(/[,\s]/g, '').replace(/p$/i, '');
    if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function round(n, dp) { if (n == null) return null; var f = Math.pow(10, dp); return Math.round(n * f) / f; }
  function bool(v) {
    if (v == null) return null;
    if (typeof v === 'boolean') return v;
    var s = String(v).trim().toLowerCase();
    if (/^(yes|y|true|active|1)$/.test(s)) return true;
    if (/^(no|n|false|inactive|0)$/.test(s)) return false;
    return null;
  }
  // Excel serial -> 'YYYY-MM-DD', UTC only. Serial 1 is 1900-01-01 and Excel counts a
  // 29 Feb 1900 that never happened, so from serial 61 the base is 1899-12-30. Anything
  // below that is a UC placeholder (their "1900-01-02") and is reported, never trusted.
  var DAY_MS = 86400000, EXCEL_BASE = Date.UTC(1899, 11, 30);
  function isoFromSerial(n) { return new Date(EXCEL_BASE + Math.round(n * DAY_MS)).toISOString(); }
  function date(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? isoFromSerial(Math.floor(v)).slice(0, 10) : null;
    if (v instanceof Date) {
      // Only reached if a caller read with cellDates: true. Local parts, never UTC: SheetJS
      // builds these in local time and getUTCDate() would land a day early under BST.
      return isNaN(v) ? null : v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    var s = String(v).trim(), m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[1] + '-' + m[2] + '-' + m[3];
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
    return null;
  }
  function stamp(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? isoFromSerial(v).replace(/\.\d{3}Z$/, 'Z') : null;
    var d = date(v);
    return d ? d + 'T00:00:00Z' : null;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function uuid(v) {
    var s = txt(v);
    return s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s.toLowerCase() : null;
  }
  function joinParts(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) { var t = txt(parts[i]); if (t) out.push(t.replace(/,\s*$/, '')); }
    return out.length ? out.join(', ') : null;
  }
  // 'LL616TQ' -> 'LL61 6TQ'. Gas postcodes without the space split wrongly on ' ' and a
  // whole postcode was being used as its own outcode (seen 8 Sep 2026).
  function postcode(v) {
    var s = txt(v);
    if (!s) return null;
    var c = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(c)) return c.slice(0, -3) + ' ' + c.slice(-3);
    return s.toUpperCase().replace(/\s+/g, ' ');
  }

  // ---------------------------------------------------------------- identifiers
  // MPAN core check digit (MRA): primes over the first 12 digits, sum mod 11 mod 10.
  var MPAN_PRIMES = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];
  function mpanCheckOk(s) {
    var t = 0;
    for (var i = 0; i < 12; i++) t += (s.charCodeAt(i) - 48) * MPAN_PRIMES[i];
    return (t % 11) % 10 === s.charCodeAt(12) - 48;
  }
  function meterId(raw, fuel) {
    var s = raw == null ? '' : (typeof raw === 'number' ? String(Math.round(raw)) : String(raw));
    s = s.trim().replace(/^#/, '').replace(/\s+/g, '').toUpperCase();
    var r = { id: s || null, raw: raw == null ? null : String(raw), valid: false, problem: null };
    if (!s) { r.problem = 'no meter number'; return r; }
    if (/^(0+|TBC|TEST|NA|N\/A|UNKNOWN)$/.test(s)) { r.problem = 'placeholder "' + s + '"'; return r; }
    if (fuel === 'electricity') {
      if (!/^\d{13}$/.test(s)) r.problem = 'an MPAN core is 13 digits, this is "' + s + '"';
      else if (!mpanCheckOk(s)) r.problem = 'MPAN check digit does not add up';
      else r.valid = true;
    } else if (fuel === 'gas') {
      if (/^WT/.test(s) || /W\d{2}$/.test(s)) r.problem = 'looks like a water SPID, not a gas MPRN';
      else if (!/^\d{6,10}$/.test(s)) r.problem = 'an MPRN is 6 to 10 digits, this is "' + s + '"';
      else r.valid = true;
    } else if (fuel === 'water') {
      if (/^\d{9,10}[0-9A-Z]{0,5}$/.test(s)) r.valid = true;
      else r.problem = 'not the shape of a water supply point id ("' + s + '")';
    } else {
      r.valid = /^\d{13}$/.test(s) || /^\d{6,10}$/.test(s);
    }
    return r;
  }

  // ---------------------------------------------------------------- vocabularies
  var UTILITY = {
    'non half hourly electric': { fuel: 'electricity', supply: 'NHH' },
    'half hourly electric': { fuel: 'electricity', supply: 'HH' },
    'gas': { fuel: 'gas', supply: 'gas' },
    'water - supply': { fuel: 'water', supply: 'water_supply' },
    'water - waste': { fuel: 'water', supply: 'water_waste' },
    'nhh': { fuel: 'electricity', supply: 'NHH' },
    'hh': { fuel: 'electricity', supply: 'HH' },
    'ws': { fuel: 'water', supply: 'water_supply' },
    'ww': { fuel: 'water', supply: 'water_waste' },
  };
  function utility(v) { return UTILITY[norm(v)] || { fuel: null, supply: txt(v) }; }

  var REGISTERS = {
    'standard': 'single', 'economy 7': 'day_night', 'evening/weekend/night': 'day_night_ew',
    'evening/weekend': 'eve_weekend', 'off peak': 'off_peak',
  };

  // Meter Deal Status -> what kind of row it is. Dates decide live/upcoming/ended later.
  var STATUS_GROUP = {
    'live': 'supply', 'locked in': 'supply', 'locked in - verified': 'supply', 'out of contract': 'supply',
    'sales pack approved': 'pipeline', 'sales pack/validation pending': 'pipeline', 'backlog': 'pipeline',
    'tender issued': 'pipeline', 'tender ready': 'pipeline', 'ready to quote': 'pipeline',
    'in progress': 'pipeline', 'awaiting lock in': 'pipeline', 'awaiting signature': 'pipeline',
    'new business won': 'pipeline', 'cot pending': 'pipeline', 'incoming cot': 'pipeline',
    'in objection': 'pipeline', 'awaiting feedback': 'pipeline', 'more info required': 'pipeline',
    'info requested': 'pipeline',
    'lost contract': 'lost', 'meters removed / de-energised': 'lost', 'supplier rejected': 'lost',
    'rejection upheld': 'lost', 'de-appointed': 'lost', 'renewal lost': 'lost',
    'sales pack/validation failed': 'lost',
    'non-commercial energy solutions (n/a)': 'other_broker',
  };
  // MOP, DC/DA, ESOS and SECR lines all sit under these "suppliers". Not supply contracts.
  // (British Gas's "BG MOP Acq DD SC" rows ARE supply contracts with day/night rates, so the
  // rule is on the supplier, never on "MOP" appearing in the product name.)
  var SERVICE_SUPPLIERS = { 'supplier x': 1, 'esos': 1, 'secr': 1 };

  var TENDER_GROUP = {
    'locked in': 'won', 'live': 'won', 'lost contract': 'lost', 'renewal lost': 'lost',
    'sales pack/validation failed': 'lost', 'non-commercial energy solutions (n/a)': 'lost',
  };

  // ---------------------------------------------------------------- unit conversion
  var SC_FACTOR = { 'p/day': 1, 'pounds/day': 100, 'pounds/year': 100 / 365, 'pounds/month': 1200 / 365, 'pounds/quarter': 400 / 365 };
  function standingCharge(raw, type) {
    var v = num(raw), t = norm(type);
    if (v == null) return { value: null, problem: null };
    if (!(t in SC_FACTOR)) return { value: null, problem: 'standing charge ' + v + ' has an unknown unit "' + (type || '') + '"' };
    return { value: round(v * SC_FACTOR[t], 4), problem: null };
  }
  // AVCAP Type as UC writes it. Converted from the stated unit; implausible results are
  // left empty with the likely reading spelled out (see feedback_uc_capacity_unit_labels).
  // `uc` is UC's own label, quoted as a label: a message never states a capacity per day.
  var CAP_UNIT = {
    'p kva/d': { f: P_KVA_DAY_TO_MONTH, uc: 'p kVA/D', pence: true, perDay: true },
    'p kva/m': { f: 1, uc: 'p kVA/M', pence: true, perDay: false },
    'gbp kva/d': { f: 100 * P_KVA_DAY_TO_MONTH, uc: 'GBP kVA/D', pence: false, perDay: true },
    'gbp kva/m': { f: 100, uc: 'GBP kVA/M', pence: false, perDay: false },
  };
  function capacity(raw, type) {
    var v = num(raw);
    if (v == null || v === 0) return { value: null, problem: null };
    var u = CAP_UNIT[norm(type)];
    if (!u) return { value: null, problem: 'capacity ' + v + ' with no unit; not converted' };
    var m = v * u.f;
    if (m > CAPACITY_MAX_P_KVA_MONTH || m < 0) {
      // The likely reading, always in p/kVA/month: pounds that are really pence, or a monthly
      // figure carrying a per-day label (then the raw figure itself is the monthly one).
      var alt = !u.pence ? m / 100 : (u.perDay ? v : null);
      var likely = alt != null && alt >= 0 && alt <= CAPACITY_MAX_P_KVA_MONTH
        // Math.round(m) / 100, not Math.round(alt * 100) / 100: the same rounding as the figure
        // printed before it (1.14 GBP gave "3468 ... probably 34.67" the other way).
        ? 'probably ' + (u.perDay && u.pence ? v : Math.round(m) / 100) + ' p/kVA/month: '
          + (!u.pence ? 'pence, not pounds' : 'a monthly figure with a per-day label')
        : 'check UC';
      return { value: null, problem: 'capacity ' + v + ' (UC unit "' + u.uc + '") is ' + Math.round(m) +
        ' p/kVA/month as labelled, which is not a real charge; ' + likely };
    }
    return { value: round(m, 4), problem: null };
  }
  function rateP(raw, what) {
    var v = num(raw);
    if (v == null || v === 0) return { value: null, problem: null };
    if (v > RATE_MAX_P_KWH || v < 0) return { value: null, problem: what + ' ' + v + ' p/kWh is not a real unit rate (left empty)' };
    return { value: round(v, 5), problem: null };
  }

  // ---------------------------------------------------------------- export detection
  var KINDS = {
    contracts: ['tender id', 'mpan/mprn/spid', 'meter deal status', 'meter contract start date (dd/mm/yyyy)'],
    portfolio: ['site id', 'meter id', 'mpan/mprn/spid', 'current contract supplier'],
    customers: ['customer id', 'legal status', 'registered address 1'],
    contacts: ['contact id', 'first name', 'primary contact'],
    tenders: ['tender id', 'reference number', 'forecast duration (months)', 'deal status'],
    notes: ['linked to', 'linked entity', 'note', 'date added'],
    reads: ['meter id', 'read date (dd/mm/yyyy)', 'reading day'],
  };
  function detectKind(header) {
    var h = {};
    (header || []).forEach(function (c) { h[norm(c)] = 1; });
    var hits = Object.keys(KINDS).filter(function (k) { return KINDS[k].every(function (c) { return h[c]; }); });
    // The contract export also has "tender id" and "deal status"; it is the more specific one.
    if (hits.indexOf('contracts') >= 0) return 'contracts';
    return hits.length === 1 ? hits[0] : null;
  }

  function Table(rows) {
    var header = rows[0] || [], idx = {};
    for (var i = 0; i < header.length; i++) { var k = norm(header[i]); if (!(k in idx)) idx[k] = i; }
    return {
      rows: rows,
      has: function (name) { return norm(name) in idx; },
      get: function (row, name) { var i = idx[norm(name)]; return i == null ? null : row[i]; },
    };
  }

  // ---------------------------------------------------------------- the build
  function build(files, opts) {
    opts = opts || {};
    var asOf = opts.asOf || new Date().toISOString().slice(0, 10);
    var issues = [], seenIssue = {};
    function issue(kind, severity, entity, key, fields, message, extra) {
      var k = kind + '|' + entity + '|' + key + '|' + (fields || '');
      if (seenIssue[k]) return;
      seenIssue[k] = 1;
      var o = { issue_key: k, kind: kind, severity: severity, entity: entity, entity_key: String(key),
        field: fields || null, message: message };
      if (extra) for (var p in extra) o[p] = extra[p];
      issues.push(o);
    }

    var byKind = {}, unknown = [];
    (files || []).forEach(function (f) {
      var k = f.kind || detectKind((f.rows || [])[0]);
      if (!k) { unknown.push(f.name); return; }
      if (byKind[k]) throw new Error('Two files look like the UC ' + k + ' export: ' + byKind[k].name + ' and ' + f.name + '. Drop one.');
      byKind[k] = { name: f.name, rows: f.rows };
    });

    var out = { customers: [], contacts: [], sites: [], meters: [], contracts: [], tenders: [], notes: [], reads: [] };
    var dupNotes = 0;
    var custById = {}, siteById = {}, meterById = {}, tenderById = {}, tenderByRef = {};

    function addCustomer(id, name, extra) {
      if (!id) return null;
      var c = custById[id];
      if (!c) {
        c = { uc_customer_id: id, name: txt(name) || '(no name in UC)', is_lead: false, in_customer_export: false };
        custById[id] = c; out.customers.push(c);
      } else if (c.name === '(no name in UC)' && txt(name)) c.name = txt(name);
      if (extra) for (var p in extra) if (extra[p] != null && c[p] == null) c[p] = extra[p];
      return c;
    }

    // ---- customers (the authoritative customer list; leads only appear in the portfolio)
    if (byKind.customers) {
      var T = Table(byKind.customers.rows);
      for (var r = 1; r < T.rows.length; r++) {
        var row = T.rows[r]; if (!row) continue;
        var id = uuid(T.get(row, 'customer id')); if (!id) continue;
        var c = addCustomer(id, T.get(row, 'customer name'));
        c.in_customer_export = true;
        c.is_lead = false;
        c.active = bool(T.get(row, 'active'));
        c.is_parent = bool(T.get(row, 'is parent?'));
        c.parent_name = txt(T.get(row, 'parent company name'));
        c.account_manager = txt(T.get(row, 'account manager'));
        c.account_manager_team = txt(T.get(row, 'account manager team'));
        c.lead_generator = txt(T.get(row, 'lead generator'));
        c.lead_generator_team = txt(T.get(row, 'lead generator team'));
        c.portfolio_consumption = num(T.get(row, 'portfolio consumption (kwh / m3)'));
        c.legal_status = txt(T.get(row, 'legal status'));
        c.company_reg_number = txt(T.get(row, 'company reg number'));
        c.customer_type = txt(T.get(row, 'customer type name')) || txt(T.get(row, 'customer type'));
        c.industry_type = txt(T.get(row, 'industry type'));
        c.referral_partner = txt(T.get(row, 'default referral partner'));
        c.website = txt(T.get(row, 'website'));
        // 'Date of Birth (Sole Trader)' is deliberately not read. Personal data the desk does
        // not need; British Gas's credit-vetting box is filled from the customer at the time.
        c.time_at_premises = txt(T.get(row, 'time at premises (sole trader)'));
        c.years_trading = txt(T.get(row, 'years trading (sole trader)'));
        c.registered_address = joinParts([T.get(row, 'registered address 1'), T.get(row, 'registered address 2'), T.get(row, 'registered address line 3'), T.get(row, 'registered address line 4')]);
        c.registered_postcode = postcode(T.get(row, 'registered address postcode'));
        c.billing_address = joinParts([T.get(row, 'billing address 1'), T.get(row, 'billing address 2'), T.get(row, 'billing address line 3'), T.get(row, 'billing address line 4')]);
        c.billing_postcode = postcode(T.get(row, 'billing address postcode'));
        c.head_office_address = joinParts([T.get(row, 'head office address 1'), T.get(row, 'head office address 2'), T.get(row, 'head office address line 3'), T.get(row, 'head office address line 4')]);
        c.head_office_postcode = postcode(T.get(row, 'head office address postcode'));
        c.customer_notes = txt(T.get(row, 'customer notes'));
        c.required_payment_terms = txt(T.get(row, 'required payment terms'));
        c.required_billing = txt(T.get(row, 'required billing requirements'));
        c.preferred_hh_commission = txt(T.get(row, 'preferred hh commission'));
        c.preferred_nhh_commission = txt(T.get(row, 'preferred nhh commission'));
        c.preferred_gas_commission = txt(T.get(row, 'preferred gas commission'));
        c.loa_start = date(T.get(row, 'loa start date (dd/mm/yyyy)'));
        c.loa_end = date(T.get(row, 'loa end date (dd/mm/yyyy)'));
        c.loa_status = txt(T.get(row, 'loa status'));
        c.micro_business = txt(T.get(row, 'micro business'));
        c.annual_turnover = txt(T.get(row, 'annual turnover (gbp)'));
        c.employees = txt(T.get(row, 'number of employees'));
        c.customer_references = txt(T.get(row, 'customer references (ref type: ref name or number (date dd/mm/yyyy))'));
        c.contract_signatory = txt(T.get(row, 'contract signatory'));
        c.signed_loa = txt(T.get(row, 'signed loa'));
        c.vat_status = txt(T.get(row, 'vat status'));
        c.initial_enquiry_date = date(T.get(row, 'initial enquiry date'));
        c.forecasting_start_month = txt(T.get(row, 'forecasting start month'));
        c.uc_created = date(T.get(row, 'date created'));
        c.uc_updated = date(T.get(row, 'last updated'));
      }
    }

    // ---- portfolio: sites and meters (and the leads, which the customer export leaves out)
    if (byKind.portfolio) {
      var P = Table(byKind.portfolio.rows);
      for (var pr = 1; pr < P.rows.length; pr++) {
        var prow = P.rows[pr]; if (!prow) continue;
        var cid = uuid(P.get(prow, 'customer id')), sid = uuid(P.get(prow, 'site id')), mid = uuid(P.get(prow, 'meter id'));
        if (!cid || !mid) continue;
        var isLead = norm(P.get(prow, 'customer/lead')) === 'lead';
        var cust = addCustomer(cid, P.get(prow, 'customer name'), {
          account_manager: txt(P.get(prow, 'account manager')), account_manager_team: txt(P.get(prow, 'team')),
          parent_name: txt(P.get(prow, 'parent company')),
        });
        if (!cust.in_customer_export) {
          if (isLead) cust.is_lead = true;
          if (cust.active == null) cust.active = bool(P.get(prow, 'customer status (active/inactive)'));
        }
        if (sid && !siteById[sid]) {
          var s = {
            uc_site_id: sid, uc_customer_id: cid, site_name: txt(P.get(prow, 'site name')),
            address_1: txt(P.get(prow, 'site address 1')), address_2: txt(P.get(prow, 'site address 2')),
            address_3: txt(P.get(prow, 'site address line 3')), address_4: txt(P.get(prow, 'site address line 4')),
            postcode: postcode(P.get(prow, 'postcode')), postcode_raw: txt(P.get(prow, 'postcode')),
            active: bool(P.get(prow, 'site status (active/inactive)')),
            site_references: txt(P.get(prow, 'customer site references(ref type: ref name / number (date (dd/mm/yyyy)))')),
            site_last_updated: date(P.get(prow, 'site last updated')),
          };
          siteById[sid] = s; out.sites.push(s);
          if (!s.postcode) issue('postcode_missing', 'low', 'site', sid, 'postcode', 'Site has no postcode in UC', { uc_customer_id: cid, customer_name: cust.name });
        }
        var u = utility(P.get(prow, 'utility type'));
        var mi = meterId(P.get(prow, 'mpan/mprn/spid'), u.fuel);
        var kva = num(P.get(prow, 'available capacity (kva)'));
        var llfRaw = txt(P.get(prow, 'llf'));
        var llf = llfRaw ? llfRaw.toUpperCase() : null;
        if (llf && /^\d{1,3}$/.test(llf)) llf = ('000' + llf).slice(-3);
        var sscRaw = txt(P.get(prow, 'ssc/mtc'));
        var sscDigits = sscRaw && /^\d+$/.test(sscRaw) ? sscRaw : null;
        var prof = num(P.get(prow, 'profile'));
        var mtype = txt(P.get(prow, 'meter type'));
        var scCur = standingCharge(P.get(prow, 'current standing charge'), P.get(prow, 'current standing charge type'));
        var capCur = capacity(P.get(prow, 'current avcap'), P.get(prow, 'current avcap type'));
        var m = {
          uc_meter_id: mid, uc_site_id: sid, uc_customer_id: cid,
          mpan: mi.id || ('(none ' + mid.slice(0, 8) + ')'), mpan_raw: mi.raw, mpan_valid: mi.valid,
          fuel: u.fuel, utility: txt(P.get(prow, 'utility type')), supply_type: u.supply,
          meter_type: mtype, registers: u.fuel === 'gas' ? 'single' : (REGISTERS[norm(mtype)] || null),
          meter_serial: txt(P.get(prow, 'meter serial number')),
          aq: num(P.get(prow, 'annual tender consumption')), aq_unit: u.fuel === 'water' ? 'm3' : 'kWh',
          capacity_kva: kva && kva > 0 && kva <= KVA_MAX ? kva : null, capacity_kva_raw: kva,
          ssc_mtc_raw: sscRaw,
          // A 4-digit value is already an SSC. A 3-digit one is an MTC and needs the MDD to
          // become an SSC, so it is NOT guessed here (the meters table carries the converted
          // SSC for the broker portfolio; the desk prefers that where the MPAN matches).
          ssc: sscDigits && sscDigits.length === 4 ? sscDigits : null,
          mtc: sscDigits && sscDigits.length === 3 ? sscDigits : null,
          profile_class: prof == null ? null : Math.round(prof),
          llfc: llf, llfc_raw: llfRaw,
          measurement_class: txt(P.get(prow, 'measurement class')), voltage: txt(P.get(prow, 'voltage')),
          active: bool(P.get(prow, 'meter status (active/inactive)')), is_lead: isLead,
          amr_status: txt(P.get(prow, 'amr status')), meter_technology: txt(P.get(prow, 'meter technology')),
          dcda_availability: txt(P.get(prow, 'dc/da availability')), energisation: txt(P.get(prow, 'energisation status')),
          mhhs_migrated: bool(P.get(prow, 'mhhs - migration complete?')), mhhs_segment: txt(P.get(prow, 'mhhs - market segment')),
          mhhs_effective: date(P.get(prow, 'mhhs - indicator effective date')),
          mop_name: txt(P.get(prow, 'current mop: name')), mop_type: txt(P.get(prow, 'current mop: contract type')),
          mop_start: date(P.get(prow, 'current mop: contract start date (dd/mm/yyyy)')), mop_end: date(P.get(prow, 'current mop: contract end date (dd/mm/yyyy)')),
          dc_name: txt(P.get(prow, 'current dc: name')), dc_type: txt(P.get(prow, 'current dc: contract type')),
          dc_start: date(P.get(prow, 'current dc: contract start date (dd/mm/yyyy)')), dc_end: date(P.get(prow, 'current dc: contract end date (dd/mm/yyyy)')),
          da_name: txt(P.get(prow, 'current da: name')), da_type: txt(P.get(prow, 'current da: contract type')),
          da_start: date(P.get(prow, 'current da: contract start date (dd/mm/yyyy)')), da_end: date(P.get(prow, 'current da: contract end date (dd/mm/yyyy)')),
          uc_current_supplier: txt(P.get(prow, 'current contract supplier')),
          uc_current_start: date(P.get(prow, 'current contract start date (dd/mm/yyyy)')),
          uc_current_end: date(P.get(prow, 'current contract end date (dd/mm/yyyy)')),
          uc_current_status: txt(P.get(prow, 'current meter deal status')),
          uc_current_unit_rate: rateP(P.get(prow, 'current unit rate (inc commission)'), 'unit rate').value,
          uc_current_day_rate: rateP(P.get(prow, 'current day rate (inc commission)'), 'day rate').value,
          uc_current_night_rate: rateP(P.get(prow, 'current night rate (inc commission)'), 'night rate').value,
          uc_current_ew_rate: rateP(P.get(prow, 'current e/w rate (inc commission)'), 'E/W rate').value,
          uc_current_sc_p_day: scCur.value,
          uc_current_capacity_p_kva_month: capCur.value,
          uc_next_supplier: txt(P.get(prow, 'next contract supplier')),
          uc_next_start: date(P.get(prow, 'next contract start date (dd/mm/yyyy)')),
          uc_next_end: date(P.get(prow, 'next contract end date (dd/mm/yyyy)')),
          uc_last_known_ced: date(P.get(prow, 'last known contract end date (dd/mm/yyyy)')),
          hh_consumption_start: date(P.get(prow, 'current hh consumption start date (dd/mm/yyyy)')),
          hh_consumption_end: date(P.get(prow, 'current hh consumption end date (dd/mm/yyyy)')),
          lead_reference: txt(P.get(prow, 'customer/lead reference')), lead_status: txt(P.get(prow, 'lead status')),
          meter_references: txt(P.get(prow, 'customer meter references(ref type: ref name / number (date (dd/mm/yyyy)))')),
          meter_last_updated: date(P.get(prow, 'meter last updated')),
        };
        meterById[mid] = m; out.meters.push(m);
        var who = { uc_customer_id: cid, customer_name: cust.name, mpan: m.mpan };
        if (!mi.valid) issue('meter_id_invalid', m.active === false ? 'low' : 'medium', 'meter', mid, 'mpan', 'Meter number problem: ' + mi.problem, who);
        if (kva != null && kva > KVA_MAX) issue('capacity_kva_implausible', 'medium', 'meter', mid, 'capacity_kva', 'Available capacity ' + kva + ' kVA is not believable; left empty', who);
        if (llfRaw && /O/i.test(llfRaw) && /\d/.test(llfRaw)) issue('llfc_letter_o', 'low', 'meter', mid, 'llfc', 'LLFC "' + llfRaw + '" has a letter O next to digits; probably a zero', who);
        if (capCur.problem) issue('capacity_implausible', 'medium', 'meter', mid, 'uc_current_capacity', capCur.problem, who);
      }
    }

    // ---- contracts
    if (byKind.contracts) {
      var C = Table(byKind.contracts.rows);
      for (var cr = 1; cr < C.rows.length; cr++) {
        var crow = C.rows[cr]; if (!crow) continue;
        var tid = uuid(C.get(crow, 'tender id')), ccid = uuid(C.get(crow, 'customer id'));
        if (!tid || !ccid) continue;
        var ccust = addCustomer(ccid, C.get(crow, 'customer name'));
        var cu = utility(C.get(crow, 'utility type'));
        var cmi = meterId(C.get(crow, 'mpan/mprn/spid'), cu.fuel);
        var supplier = txt(C.get(crow, 'supplier'));
        var mds = txt(C.get(crow, 'meter deal status')) || txt(C.get(crow, 'deal status'));
        var group = SERVICE_SUPPLIERS[norm(supplier)] ? 'service' : (STATUS_GROUP[norm(mds)] || 'unknown');
        var urUom = txt(C.get(crow, 'unit rate uom'));
        var isWater = cu.fuel === 'water' || /m3/i.test(norm(urUom));
        var ur = isWater ? { value: null, problem: null } : rateP(C.get(crow, 'unit rate'), 'unit rate');
        var dr = rateP(C.get(crow, 'day rate (p/kwh)'), 'day rate');
        var nr = rateP(C.get(crow, 'night rate (p/kwh)'), 'night rate');
        var er = rateP(C.get(crow, 'e/w rate (p/kwh)'), 'E/W rate');
        var scc = standingCharge(C.get(crow, 'standing charge'), C.get(crow, 'standing charge type'));
        var cap = capacity(C.get(crow, 'avcap'), C.get(crow, 'avcap type'));
        var ms = date(C.get(crow, 'meter contract start date (dd/mm/yyyy)')) || date(C.get(crow, 'contract start date (dd/mm/yyyy)'));
        var me = date(C.get(crow, 'meter contract end date (dd/mm/yyyy)')) || date(C.get(crow, 'contract end date (dd/mm/yyyy)'));
        var k = {
          uc_tender_id: tid, mpan: cmi.id || '(none)', mpan_valid: cmi.valid,
          reference: txt(C.get(crow, 'reference number')), uc_customer_id: ccid, customer_name: txt(C.get(crow, 'customer name')),
          parent_name: txt(C.get(crow, 'parent name')),
          utility: txt(C.get(crow, 'utility type')), fuel: cu.fuel, supply_type: cu.supply,
          supplier: supplier, product: txt(C.get(crow, 'product')),
          duration_months: (function (d) { return d == null ? null : Math.round(d); })(num(C.get(crow, 'duration (months)'))),
          commission_rate: num(C.get(crow, 'commission rate')), commission_uom: txt(C.get(crow, 'commission rate uom')),
          commission_gbp_meter_year: num(C.get(crow, 'commission rate (gbp/meter/y)')),
          commission_pct: num(C.get(crow, 'commission rate %')), commission_gbp_contract: num(C.get(crow, 'commission rate (gbp/contract)')),
          total_commission_gbp: num(C.get(crow, 'total commission')),
          contract_start: date(C.get(crow, 'contract start date (dd/mm/yyyy)')), contract_end: date(C.get(crow, 'contract end date (dd/mm/yyyy)')),
          meter_start: ms, meter_end: me,
          live_start: date(C.get(crow, 'live start date (of meter)')), live_end: date(C.get(crow, 'live end date (of meter)')),
          quote_accepted: date(C.get(crow, 'quote accepted date (dd/mm/yyyy)')),
          date_submitted: stamp(C.get(crow, 'date submitted (dd/mm/yyyy)')),
          tender_return: date(C.get(crow, 'tender return date')),
          business_type: txt(C.get(crow, 'business type')), opportunity_type: txt(C.get(crow, 'opportunity type')),
          deal_status: txt(C.get(crow, 'deal status')), meter_deal_status: mds,
          reason_for_loss: txt(C.get(crow, 'reason for loss')), lost_note: txt(C.get(crow, 'lost note')),
          account_manager: txt(C.get(crow, 'account manager')), team: txt(C.get(crow, 'team')),
          meters_on_tender: (function (d) { return d == null ? null : Math.round(d); })(num(C.get(crow, 'number of meters'))),
          total_contract_cost_gbp: num(C.get(crow, 'total contract cost')),
          site_name: txt(C.get(crow, 'site name')),
          unit_rate_p_kwh: ur.value, day_rate_p_kwh: dr.value, night_rate_p_kwh: nr.value, ew_rate_p_kwh: er.value,
          water_rate_gbp_m3: isWater ? num(C.get(crow, 'unit rate')) : null,
          fit_rate_p_kwh: num(C.get(crow, 'fit rate (p/kwh)')),
          unit_rate_raw: num(C.get(crow, 'unit rate')), unit_rate_uom: urUom,
          day_rate_raw: num(C.get(crow, 'day rate (p/kwh)')), night_rate_raw: num(C.get(crow, 'night rate (p/kwh)')), ew_rate_raw: num(C.get(crow, 'e/w rate (p/kwh)')),
          standing_charge_p_day: scc.value, standing_charge_raw: num(C.get(crow, 'standing charge')), standing_charge_type: txt(C.get(crow, 'standing charge type')),
          capacity_p_kva_month: cap.value, capacity_raw: num(C.get(crow, 'avcap')), capacity_type: txt(C.get(crow, 'avcap type')),
          aq: num(C.get(crow, 'annual meter consumption')), aq_unit: txt(C.get(crow, 'annual meter consumption uom')),
          payment_terms: txt(C.get(crow, 'payment terms')),
          sign_pct: num(C.get(crow, 'sign %')), live_pct: num(C.get(crow, 'live %')), anniversary_pct: num(C.get(crow, 'anniversary %')),
          referral_partner: txt(C.get(crow, '(1) referral partner name')),
          referral_commission: txt(C.get(crow, '(1) referral partner commission/type')),
          referral_value_gbp: num(C.get(crow, '(1) referral partner value (gbp)')),
          termination_status: txt(C.get(crow, 'termination status')), registration_status: txt(C.get(crow, 'registration status')),
          ds_last_edited: stamp(C.get(crow, 'ds last edited date')), uc_last_updated: stamp(C.get(crow, 'last updated')),
          status_group: group, is_service: group === 'service',
        };
        out.contracts.push(k);
        var kkey = tid + '|' + k.mpan;
        var kwho = { uc_customer_id: ccid, customer_name: ccust.name, mpan: k.mpan };
        var supplyish = group === 'supply' || group === 'other_broker';
        if (group === 'unknown') issue('status_unknown', 'medium', 'contract', kkey, 'meter_deal_status', 'Deal status "' + mds + '" is not one this import knows; shown as unknown', kwho);
        if (!cmi.valid && group !== 'service') issue('meter_id_invalid', supplyish ? 'medium' : 'low', 'contract', kkey, 'mpan', 'Meter number problem: ' + cmi.problem, kwho);
        if (!ms || !me) issue('dates_missing', 'medium', 'contract', kkey, 'meter_start,meter_end', 'Contract has no start or end date', kwho);
        if (ms && ms < '1990-01-01') issue('csd_placeholder', 'low', 'contract', kkey, 'meter_start', 'Start date ' + ms + ' is a UC placeholder, not a real date', kwho);
        if (ms && me && me < ms) issue('ced_before_csd', me >= asOf ? 'high' : 'low', 'contract', kkey, 'meter_start,meter_end', 'Ends ' + me + ' before it starts ' + ms + ' (probably a typo in UC)', kwho);
        [['unit rate', ur], ['day rate', dr], ['night rate', nr], ['E/W rate', er]].forEach(function (p) {
          if (p[1].problem) issue('rate_implausible', supplyish && me && me >= asOf ? 'medium' : 'low', 'contract', kkey, p[0], p[1].problem, kwho);
        });
        if (scc.problem) issue('standing_charge_unit', 'low', 'contract', kkey, 'standing_charge', scc.problem, kwho);
        if (cap.problem) issue('capacity_implausible', supplyish && me && me >= asOf ? 'medium' : 'low', 'contract', kkey, 'capacity', cap.problem, kwho);
        if (group === 'pipeline' && me && me < asOf) issue('stale_pipeline', 'info', 'contract', kkey, 'meter_deal_status', '"' + mds + '" but the contract would already have ended ' + me + ': never progressed', kwho);
        if (supplyish && k.aq != null && k.aq <= 100 && cu.fuel !== 'water' && me && me >= asOf) issue('aq_placeholder', 'info', 'contract', kkey, 'aq', 'Annual consumption ' + k.aq + ' ' + (k.aq_unit || '') + ' looks like a UC placeholder', kwho);
      }
    }

    // ---- tenders
    if (byKind.tenders) {
      var TD = Table(byKind.tenders.rows);
      for (var tr = 1; tr < TD.rows.length; tr++) {
        var trow = TD.rows[tr]; if (!trow) continue;
        var ttid = uuid(TD.get(trow, 'tender id')); if (!ttid) continue;
        var tcid = uuid(TD.get(trow, 'customer id'));
        if (tcid) addCustomer(tcid, TD.get(trow, 'customer'));
        var tu = utility(TD.get(trow, 'utility'));
        var tds = txt(TD.get(trow, 'deal status'));
        var t = {
          uc_tender_id: ttid, reference: txt(TD.get(trow, 'reference number')), uc_customer_id: tcid,
          customer_name: txt(TD.get(trow, 'customer')), parent_name: txt(TD.get(trow, 'parent name')),
          utility: txt(TD.get(trow, 'utility')), fuel: tu.fuel,
          contract_start: date(TD.get(trow, 'contract start date (dd/mm/yyyy)')),
          business_type: txt(TD.get(trow, 'business type')),
          date_submitted: date(TD.get(trow, 'date submitted (dd/mm/yyyy)')), tender_return: date(TD.get(trow, 'tender return (dd/mm/yyyy)')),
          deal_status: tds, days_at_status: (function (d) { return d == null ? null : Math.round(d); })(num(TD.get(trow, 'days at status'))),
          reason_for_loss: txt(TD.get(trow, 'reason for loss')), lost_note: txt(TD.get(trow, 'lost note')),
          opportunity_type: txt(TD.get(trow, 'opportunity type')), account_manager: txt(TD.get(trow, 'account manager')),
          team: txt(TD.get(trow, 'team (of accnt manager)')),
          meters: (function (d) { return d == null ? null : Math.round(d); })(num(TD.get(trow, 'number of meters'))),
          total_consumption: num(TD.get(trow, 'total consumption (kwh / m3)')),
          // A time-formatted cell in UC's sheet: 0.7 shows as 16:48:00. Read raw, it is 0.7.
          forecast_commission_rate: num(TD.get(trow, 'forecast commission rate (p/kwh / gbp/m3 / gbp/contract / %)')),
          forecast_duration_months: (function (d) { return d == null ? null : Math.round(d); })(num(TD.get(trow, 'forecast duration (months)'))),
          expected_close: date(TD.get(trow, 'expected close date (dd/mm/yyyy)')),
          forecast_commission_gbp: num(TD.get(trow, 'forecast commission (gbp)')),
          is_lead: bool(TD.get(trow, 'is customer a lead?')),
          forecast_probability: num(TD.get(trow, 'forecast probability (%)')),
          ds_last_edited: stamp(TD.get(trow, 'ds last edited date')), uc_last_updated: stamp(TD.get(trow, 'last updated')),
          primary_contact_email: txt(TD.get(trow, 'primary contact email')), primary_contact_mobile: txt(TD.get(trow, 'primary contact mobile')),
          status_group: TENDER_GROUP[norm(tds)] || 'open',
        };
        out.tenders.push(t);
        tenderById[ttid] = t;
        if (t.reference) tenderByRef[t.reference.toUpperCase()] = t;
      }
    }
    // contract references are tender references too (notes link to either)
    out.contracts.forEach(function (k) { if (k.reference && !tenderByRef[k.reference.toUpperCase()]) tenderByRef[k.reference.toUpperCase()] = { uc_customer_id: k.uc_customer_id }; });

    // ---- contacts
    if (byKind.contacts) {
      var CT = Table(byKind.contacts.rows);
      for (var nr2 = 1; nr2 < CT.rows.length; nr2++) {
        var nrow = CT.rows[nr2]; if (!nrow) continue;
        var conid = uuid(CT.get(nrow, 'contact id')), ncid = uuid(CT.get(nrow, 'customer id'));
        if (!conid || !ncid) continue;
        var ncust = addCustomer(ncid, CT.get(nrow, 'customer name'));
        // 272 customers appear ONLY here, every one through a contact marked "Lead": they
        // are leads with no meter on file yet, not missing customers.
        if (!ncust.in_customer_export && norm(CT.get(nrow, 'lead / customer')) === 'lead') ncust.is_lead = true;
        out.contacts.push({
          uc_contact_id: conid, uc_customer_id: ncid,
          title: txt(CT.get(nrow, 'title')), first_name: txt(CT.get(nrow, 'first name')), last_name: txt(CT.get(nrow, 'last name')),
          job_title: txt(CT.get(nrow, 'job title')), contact_reference: txt(CT.get(nrow, 'contact reference')),
          telephone: txt(CT.get(nrow, 'telephone')), telephone_ext: txt(CT.get(nrow, 'ext.#')), mobile: txt(CT.get(nrow, 'mobile')),
          email: txt(CT.get(nrow, 'email')), active: bool(CT.get(nrow, 'active')),
          customer_portal_user: bool(CT.get(nrow, 'customer portal user')), primary_contact: bool(CT.get(nrow, 'primary contact')),
          lead_or_customer: txt(CT.get(nrow, 'lead / customer')), gdpr_status: txt(CT.get(nrow, 'gdpr status')),
          correspondence_preference: txt(CT.get(nrow, 'correspondence preference')),
          reporting_contact: bool(CT.get(nrow, 'reporting contact?')), tps: bool(CT.get(nrow, 'tps')),
          ctps: txt(CT.get(nrow, 'ctps')), emergency_contact: bool(CT.get(nrow, 'emergency contact?')),
        });
      }
    }

    // ---- notes (the export carries a customer NAME and a reference, never an id)
    if (byKind.notes) {
      var NT = Table(byKind.notes.rows), nameIdx = {}, noteSeen = {};
      out.customers.forEach(function (c) { var k2 = norm(c.name); (nameIdx[k2] = nameIdx[k2] || []).push(c.uc_customer_id); });
      for (var no = 1; no < NT.rows.length; no++) {
        var orow = NT.rows[no]; if (!orow) continue;
        var ntext = txt(NT.get(orow, 'note')); if (!ntext) continue;
        var cname = txt(NT.get(orow, 'customer name'));
        var ent = txt(NT.get(orow, 'linked entity'));
        var viaRef = ent && tenderByRef[ent.toUpperCase()];
        var ids = cname ? (nameIdx[norm(cname)] || []) : [];
        var ncid2 = viaRef && viaRef.uc_customer_id ? viaRef.uc_customer_id : (ids.length === 1 ? ids[0] : null);
        var added = stamp(NT.get(orow, 'date added'));
        var nkey = [cname || '', NT.get(orow, 'linked to') || '', ent || '', added || '', ntext.slice(0, 200)].join('|');
        // UC repeats a note once per meter on the deal: 274 of the 391 rows on 3 Nov 2026
        // were exact copies. One note is kept.
        if (noteSeen[nkey]) { dupNotes++; continue; }
        noteSeen[nkey] = 1;
        out.notes.push({
          note_key: nkey,
          uc_customer_id: ncid2, customer_name: cname, linked_to: txt(NT.get(orow, 'linked to')), linked_entity: ent,
          note: ntext, added_at: added, added_by: txt(NT.get(orow, 'added by')),
          visible_to_customer: bool(NT.get(orow, 'visible to customer')),
        });
      }
    }

    // ---- meter readings
    if (byKind.reads) {
      var RD = Table(byKind.reads.rows);
      for (var rr = 1; rr < RD.rows.length; rr++) {
        var rrow = RD.rows[rr]; if (!rrow) continue;
        var rmid = uuid(RD.get(rrow, 'meter id')), rcid = uuid(RD.get(rrow, 'customer id'));
        var ru = utility(RD.get(rrow, 'utility type'));
        var rmi = meterId(RD.get(rrow, 'meter number'), ru.fuel);
        var rd = date(RD.get(rrow, 'read date (dd/mm/yyyy)'));
        if (rcid) addCustomer(rcid, RD.get(rrow, 'customer name'));
        var rec = {
          uc_meter_id: rmid, uc_customer_id: rcid, mpan: rmi.id, site_name: txt(RD.get(rrow, 'site name')),
          utility: txt(RD.get(rrow, 'utility type')), serial: txt(RD.get(rrow, 'serial number')),
          read_date: rd, reading_type: txt(RD.get(rrow, 'reading type')),
          reading: num(RD.get(rrow, 'reading')), clocked: bool(RD.get(rrow, 'clocked?')),
          reading_day: num(RD.get(rrow, 'reading day')), day_clocked: bool(RD.get(rrow, '(day) clocked?')),
          reading_night: num(RD.get(rrow, 'reading night')), night_clocked: bool(RD.get(rrow, '(night) clocked?')),
          reading_ew: num(RD.get(rrow, 'reading e/w')), ew_clocked: bool(RD.get(rrow, '(e/w) clocked?')),
        };
        rec.read_key = [rmid || rmi.id, rd, rec.reading_type, rec.reading, rec.reading_day, rec.reading_night, rec.reading_ew].join('|');
        out.reads.push(rec);
      }
    }

    // ------------------------------------------------------------ cross-record checks
    // Supply history per (customer, meter): overlaps and gaps between consecutive contracts.
    var hist = {};
    out.contracts.forEach(function (k) {
      if (k.status_group !== 'supply' && k.status_group !== 'other_broker') return;
      if (!k.meter_start || !k.meter_end || k.meter_end < k.meter_start || k.meter_start < '1990-01-01') return;
      var hk = k.uc_customer_id + '|' + k.mpan;
      (hist[hk] = hist[hk] || []).push(k);
    });
    var others = {}, meterByKey = {};
    out.contracts.forEach(function (k) {
      if (k.status_group === 'lost' || k.status_group === 'pipeline') (others[k.uc_customer_id + '|' + k.mpan] = others[k.uc_customer_id + '|' + k.mpan] || []).push(k);
    });
    out.meters.forEach(function (m) { meterByKey[m.uc_customer_id + '|' + m.mpan] = m; });
    var outOfContract = 0;
    Object.keys(hist).forEach(function (hk) {
      var list = hist[hk].sort(function (a, b) { return a.meter_start < b.meter_start ? -1 : a.meter_start > b.meter_start ? 1 : (a.meter_end < b.meter_end ? -1 : 1); });
      var a0 = list[0];
      var who2 = { uc_customer_id: a0.uc_customer_id, customer_name: (custById[a0.uc_customer_id] || {}).name, mpan: a0.mpan };
      var maxEnd = list[0].meter_end;
      for (var i = 1; i < list.length; i++) {
        var prev = list[i - 1], cur = list[i];
        var gapDays = Math.round((Date.parse(cur.meter_start) - Date.parse(maxEnd)) / DAY_MS) - 1;
        if (gapDays > 0 && cur.meter_start > addDaysIso(asOf, -365)) {
          var sev = (maxEnd < asOf && cur.meter_start > asOf) ? 'high' : (cur.meter_start > asOf ? 'medium' : 'low');
          issue('contract_gap', sev, 'meter', hk, 'meter_end,meter_start',
            gapDays + ' day gap: ' + prev.supplier + ' ends ' + maxEnd + ', ' + cur.supplier + ' starts ' + cur.meter_start +
            (sev === 'high' ? '. Out of contract right now.' : ''), who2);
        } else if (gapDays < -1 && cur.meter_end >= addDaysIso(asOf, -365) && prev.status_group === 'supply' && cur.status_group === 'supply') {
          issue('contract_overlap', 'low', 'meter', hk + '|' + cur.uc_tender_id, 'meter_start', prev.supplier + ' (to ' + maxEnd + ') overlaps ' + cur.supplier + ' (from ' + cur.meter_start + ') by ' + (-gapDays - 1) + ' days', who2);
        }
        if (cur.meter_end > maxEnd) maxEnd = cur.meter_end;
      }
      // No contract on file today: the latest supply ended within the last year and no
      // supply contract follows it. That is EITHER out of contract (deemed rates) OR renewed
      // without CES, and UC cannot tell the two apart, so the message says exactly that and
      // names any lost or in-progress renewal it can see. Urgent only for an active meter on
      // an active, non-lead customer with nothing in progress.
      if (maxEnd < asOf && maxEnd >= addDaysIso(asOf, -365)) {
        var after = (others[hk] || []).filter(function (o) { return (o.meter_end || '') >= maxEnd; });
        var lost = after.filter(function (o) { return o.status_group === 'lost'; });
        var going = after.filter(function (o) { return o.status_group === 'pipeline' && (o.meter_end || '') >= asOf; });
        var mt = meterByKey[hk], cu2 = custById[a0.uc_customer_id] || {};
        var activeMeter = !mt || mt.active !== false, activeCust = cu2.active !== false && !cu2.is_lead;
        var last = list[list.length - 1];
        var msg = 'Last contract (' + last.supplier + ') ended ' + maxEnd + ' and UC has no contract after it: out of contract, or renewed without CES.';
        var sev2 = activeMeter && activeCust ? 'high' : 'low';
        if (lost.length) { msg += ' The renewal is marked lost (' + (lost[0].supplier || '?') + ').'; sev2 = 'info'; }
        else if (going.length) { msg += ' A renewal is in progress: ' + going[0].supplier + ', "' + going[0].meter_deal_status + '".'; sev2 = 'medium'; }
        if (sev2 === 'high') outOfContract++;
        issue('out_of_contract', sev2, 'meter', hk, 'meter_end', msg, who2);
      }
    });

    // One MPAN, several ACTIVE meter records on different customers.
    var byMpan = {};
    out.meters.forEach(function (m) { if (m.mpan_valid && m.active !== false) (byMpan[m.mpan] = byMpan[m.mpan] || []).push(m); });
    Object.keys(byMpan).forEach(function (mp) {
      var l = byMpan[mp], cids = {};
      l.forEach(function (m) { cids[m.uc_customer_id] = 1; });
      if (Object.keys(cids).length > 1) {
        var real = l.filter(function (m) { return !m.is_lead; });
        var realCust = {}; real.forEach(function (m) { realCust[m.uc_customer_id] = 1; });
        issue('mpan_on_several_customers', Object.keys(realCust).length > 1 ? 'medium' : 'low', 'mpan', mp, 'uc_customer_id',
          'Active on ' + Object.keys(cids).length + ' customers: ' + l.map(function (m) { return (custById[m.uc_customer_id] || {}).name + (m.is_lead ? ' (lead)' : ''); }).join('; '),
          { mpan: mp, uc_customer_id: (real[0] || l[0]).uc_customer_id });
      }
    });

    // Same company name on more than one customer id.
    var nameIds = {};
    out.customers.forEach(function (c) { var nk = norm(c.name).replace(/\b(ltd|limited|plc|llp)\b\.?/g, '').replace(/[^a-z0-9]/g, ''); if (nk) (nameIds[nk] = nameIds[nk] || []).push(c); });
    Object.keys(nameIds).forEach(function (nk) {
      var l = nameIds[nk];
      if (l.length > 1) issue('customer_duplicate_name', 'low', 'customer', l.map(function (c) { return c.uc_customer_id; }).sort().join(','), 'name',
        l.length + ' UC customers share the name "' + l[0].name + '"' + (l.some(function (c) { return c.is_lead; }) ? ' (some are leads)' : ''),
        { uc_customer_id: l[0].uc_customer_id, customer_name: l[0].name });
    });


    // Fill the customer name on every issue that only carries an id.
    issues.forEach(function (i) { if (i.uc_customer_id && !i.customer_name) i.customer_name = (custById[i.uc_customer_id] || {}).name || null; });

    return {
      version: VERSION, as_of: asOf, files: Object.keys(byKind).map(function (k) { return { kind: k, name: byKind[k].name, rows: byKind[k].rows.length - 1 }; }),
      unrecognised: unknown, data: out, issues: issues,
      stats: Object.assign(summarise(out, issues, asOf, outOfContract), { duplicate_notes_dropped: dupNotes }),
    };
  }

  function addDaysIso(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }

  /** The same rule as crm_contracts_v, for the import preview and the audit workbook. */
  function lifecycle(k, asOf) {
    var start = k.meter_start || k.contract_start, end = k.meter_end || k.contract_end;
    if (k.status_group === 'service') return 'service';
    if (k.status_group === 'lost') return 'lost';
    if (k.status_group === 'unknown') return 'unknown';
    if (k.status_group === 'pipeline') return end && end < asOf ? 'stale' : 'pipeline';
    if (end && end < asOf) return 'ended';
    if (start && start > asOf) return 'upcoming';
    return 'live';
  }

  /** Tenders: open / stale / won / lost, the same rule as crm_tenders_v. An open tender
   *  whose wanted start date is more than 30 days gone is stale: nobody is working it. */
  function tenderLifecycle(t, asOf) {
    if (t.status_group !== 'open') return t.status_group;
    return t.contract_start && t.contract_start < addDaysIso(asOf, -30) ? 'stale' : 'open';
  }

  function summarise(out, issues, asOf, outOfContract) {
    var life = {}, sev = {}, kinds = {}, tl = {};
    out.contracts.forEach(function (k) { var l = lifecycle(k, asOf); life[l] = (life[l] || 0) + 1; });
    out.tenders.forEach(function (t) { var l = tenderLifecycle(t, asOf); tl[l] = (tl[l] || 0) + 1; });
    issues.forEach(function (i) { sev[i.severity] = (sev[i.severity] || 0) + 1; kinds[i.kind] = (kinds[i.kind] || 0) + 1; });
    return {
      customers: out.customers.length, leads: out.customers.filter(function (c) { return c.is_lead; }).length,
      contacts: out.contacts.length, sites: out.sites.length, meters: out.meters.length,
      contracts: out.contracts.length, tenders: out.tenders.length, notes: out.notes.length, reads: out.reads.length,
      contract_lifecycle: life, tender_lifecycle: tl, issues_by_severity: sev, issues_by_kind: kinds, out_of_contract_meters: outOfContract,
    };
  }

  /** Read a dropped xlsx with the page's SheetJS. Raw values: dates stay serial numbers. */
  function readWorkbook(XLSX, buf, name) {
    var wb = XLSX.read(buf, { cellDates: false, dense: true });
    var sheet = wb.SheetNames.map(function (n) { return { n: n, ws: wb.Sheets[n] }; })
      .find(function (s) { var st = (wb.Workbook && wb.Workbook.Sheets || []).find(function (x) { return x.name === s.n; }); return !st || !st.Hidden; });
    if (!sheet) throw new Error(name + ': no visible sheet');
    var rows = XLSX.utils.sheet_to_json(sheet.ws, { header: 1, raw: true, defval: null, blankrows: false });
    return { name: name, rows: rows, kind: detectKind(rows[0]) };
  }

  root.CrmImport = {
    VERSION: VERSION, build: build, detectKind: detectKind, lifecycle: lifecycle, tenderLifecycle: tenderLifecycle, readWorkbook: readWorkbook,
    _internals: { date: date, stamp: stamp, meterId: meterId, mpanCheckOk: mpanCheckOk, capacity: capacity,
      standingCharge: standingCharge, rateP: rateP, postcode: postcode, utility: utility, norm: norm,
      STATUS_GROUP: STATUS_GROUP, P_KVA_DAY_TO_MONTH: P_KVA_DAY_TO_MONTH },
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CrmImport;
}
