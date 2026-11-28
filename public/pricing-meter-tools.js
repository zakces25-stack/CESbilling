/*
 * pricing-meter-tools.js - the desk tools of round 4 (CES, 28 Nov 2026).
 *
 * CES asked, 28 Nov 2026: the Price a meter search box should have a drop-down; "when it says price a meter that is
 * not in the portfolio, I would like to type in MPAN, hit search and have it grab the address, top line, meter type,
 * and EAC from totalportal. That should leave us to only enter the contract start date, current supplier and then
 * lets stretch this to also work with gas"; "everytime we quote, have it search the total portal the first time, then
 * once confirmed it doesnt need to search the total portal anymore"; "a little settings button next to each MPAN which
 * allows us to manually edit the details like this in UC"; and whatever TotalEnergies throws up that Claude cannot
 * settle goes to "a manual review section" in the locked admin portal.
 *
 * This file holds the parts that are not tied to the page script, so they can be tested on their own:
 *
 *   * typeahead(input, deps)     the drop-down under Price a meter's search box (arrow keys, Enter, Escape, mouse).
 *   * rankSuggestions(...)       which meters, customers and sites to suggest for what was typed (pure).
 *   * lookupOne(sb, id, opts)    te-lookup for one MPAN or MPRN, never throws (SPEC-PORTALS.md F).
 *   * manualFromTe(res)          what a TotalEnergies answer fills in on "Price a meter that is not in the portfolio".
 *   * splitToBoxes(split, regs)  TotalEnergies' usage split onto the meter's kWh boxes (pure).
 *   * openMeterDialog(meter, d)  Meter details, the gear next to the MPAN: UtilityClick's meter form, saved through
 *                                pricing_meter_update (pricing team), read only for a broker, this quote only for a
 *                                meter typed in by hand.
 *   * mountReview(host, deps)    Settings > Manual review: meter_review_counts / meter_review_list / meter_review_resolve.
 *
 * Pure helpers are on MeterTools._test for the Node tests (repo/public/__tests__/pricing-meter-tools.test.js).
 */
(function (root) {
  'use strict';
  var VERSION = '2026-11-28.4';
  var TE_FN = 'te-lookup';
  var MPAN_PRIMES = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];
  // The meter types in CES's words (the codes are meters.rate_structure's).
  var TYPE_LABEL = { single: 'Standard', day_night: 'Economy 7', eve_weekend: 'Evening / weekend',
                     day_night_ew: 'Evening / weekend / night', off_peak: 'Off peak' };
  // Which kWh registers each type has (the same as REGISTERS in pricing.html).
  var REGS = { single: ['total'], day_night: ['day', 'night'], eve_weekend: ['day', 'ew'],
               day_night_ew: ['day', 'night', 'ew'], off_peak: ['night'] };
  var REG_LABEL = { total: 'Annual consumption (kWh)', day: 'Day kWh', night: 'Night kWh', ew: 'Evening / weekend kWh' };
  // What pricing_meter_update takes (SPEC-PORTALS.md F). Anything else is never sent.
  var PATCH_KEYS = ['site_name', 'site_address', 'postcode', 'profile_class', 'ssc', 'llfc', 'mtc', 'meter_serial',
                    'rate_structure', 'est_annual_consumption', 'usage_split', 'supplier', 'contract_end_date'];
  var FIELD_WORDS = { site_name: 'site name', site_address: 'site address', postcode: 'postcode', profile_class: 'profile class',
                      ssc: 'SSC', llfc: 'LLFC', mtc: 'MTC', meter_serial: 'serial number', rate_structure: 'meter type',
                      est_annual_consumption: 'annual consumption', usage_split: 'usage split', supplier: 'current supplier',
                      contract_end_date: 'contract end date' };
  // meter_review_items.kind in words.
  var KIND_WORDS = { postcode_mismatch: 'Postcode differs', not_found: 'TotalEnergies cannot find this meter',
                     consumption_jump: 'Consumption jumped', type_conflict: 'Meter type not recognised' };
  var KIND_HINT = {
    postcode_mismatch: 'The meter keeps our postcode until someone decides. Take TotalEnergies\' writes their postcode and address to the meter.',
    not_found: 'Nothing on the meter was changed. Check the number against a bill.',
    consumption_jump: 'The meter already uses TotalEnergies\' figure. Keep ours puts our figure back.',
    type_conflict: 'TotalEnergies named a meter type we do not know, so the meter type was not changed.',
  };

  // ------------------------------------------------------------------ pure helpers

  function str(v) { return v == null ? '' : String(v); }
  function digits(v) { return str(v).replace(/\D/g, ''); }
  function clean(v) { var s = str(v).trim(); return s ? s : null; }
  function escDefault(s) {
    return str(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtN(n) { var v = Number(n); if (!isFinite(v)) return ''; try { return Math.round(v).toLocaleString('en-GB'); } catch (_) { return String(Math.round(v)); } }

  /** A date and time as CES reads it: "28 Nov, 14:32" (UK time). Empty when it is not a date. */
  function whenUk(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  /** The MPAN check digit (the same mod-11 rule as crm_mpan_ok and pricing-topline.js). */
  function mpanOk(core) {
    var d = digits(core);
    if (d.length !== 13) return false;
    var s = 0;
    for (var i = 0; i < 12; i++) s += Number(d[i]) * MPAN_PRIMES[i];
    return (s % 11) % 10 === Number(d[12]);
  }

  /**
   * What a typed number is: 13 digits (or a whole supply number, the last 13) is an MPAN, 6 to 10 digits an MPRN.
   * {id, fuel: 'electricity'|'gas'|null, ok}. ok is false for an MPAN that fails its check digit.
   */
  function idKind(v) {
    var d = digits(v);
    if (d.length >= 13) { var core = d.slice(-13); return { id: core, fuel: 'electricity', ok: mpanOk(core) }; }
    if (d.length >= 6 && d.length <= 10) return { id: d, fuel: 'gas', ok: true };
    return { id: d, fuel: null, ok: false };
  }

  /** A UK postcode written the usual way ("dy20uw" -> "DY2 0UW"); anything that is not one, upper-cased as typed. */
  function normPostcode(v) {
    var s = str(v).toUpperCase().replace(/\s+/g, ' ').trim();
    if (!s) return null;
    var c = s.replace(/\s/g, '');
    if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(c)) return c.slice(0, -3) + ' ' + c.slice(-3);
    return s;
  }
  function samePostcode(a, b) { return str(a).toUpperCase().replace(/\s/g, '') === str(b).toUpperCase().replace(/\s/g, ''); }

  /** A usage split as numbers: {day, night, ew} (only the registers it has) or {total}. Null when there is none. */
  function cleanSplit(split) {
    if (!split || typeof split !== 'object') return null;
    var out = {}, any = false;
    ['day', 'night', 'ew', 'total'].forEach(function (k) {
      var v = split[k];
      if (v == null || v === '') return;
      var n = Number(v);
      if (isFinite(n) && n >= 0) { out[k] = Math.round(n); any = true; }
    });
    if (!any) return null;
    if (out.day != null || out.night != null || out.ew != null) delete out.total;
    return out;
  }

  /**
   * TotalEnergies' usage split onto a meter's kWh boxes. regs is the meter's registers (['day','night'] and so on);
   * total is its annual figure. The split's shares are kept and scaled to the total (when there is one), rounded, the
   * last register taking what is left, as TotalEnergies does. A register the split has and the meter does not goes into
   * the meter's first register (nothing is lost, as foldKwh does on the page). Null for a one-register meter (its
   * figure is the total) or when there is no usable split.
   */
  function splitToBoxes(split, regs, total) {
    var s = cleanSplit(split);
    if (!s || !regs || !regs.length || (regs.length === 1 && regs[0] === 'total')) return null;
    var keys = ['day', 'night', 'ew'].filter(function (k) { return s[k] != null; });
    if (!keys.length) return null;
    var sum = keys.reduce(function (a, k) { return a + s[k]; }, 0);
    if (!(sum > 0)) return null;
    var want = Number(total) > 0 ? Math.round(Number(total)) : sum;
    var raw = {};
    regs.forEach(function (r) { raw[r] = 0; });
    keys.forEach(function (k) { if (raw[k] != null) raw[k] += s[k]; else raw[regs[0]] += s[k]; });
    var out = {}, used = 0;
    regs.forEach(function (r, i) {
      if (i === regs.length - 1) out[r] = want - used;
      else { out[r] = Math.round(raw[r] / sum * want); used += out[r]; }
    });
    return out;
  }

  /** "80% day / 20% night" for a split, or ''. */
  function splitWords(split) {
    var s = cleanSplit(split);
    if (!s) return '';
    var keys = ['day', 'night', 'ew'].filter(function (k) { return s[k] != null; });
    if (keys.length < 2) return '';
    var sum = keys.reduce(function (a, k) { return a + s[k]; }, 0);
    if (!(sum > 0)) return '';
    var w = { day: 'day', night: 'night', ew: 'evening/weekend' };
    return keys.map(function (k) { return Math.round(s[k] / sum * 100) + '% ' + w[k]; }).join(' / ');
  }

  // A first part of an address that is a business or a building, not a house number or a street.
  var PLACE = /\b(LTD|LIMITED|PLC|LLP|CIC|GROUP|COMPANY|HOLDINGS|TRUST|HOUSE|FARM|HALL|CENTRE|CENTER|SCHOOL|ACADEMY|COLLEGE|CHURCH|HOTEL|PUB|INN|CLUB|SURGERY|STORES?|SHOP|GARAGE|WORKS|MILL|DEPOT|WAREHOUSE|OFFICES?|BUILDING|MARINA)\b/i;
  /**
   * TotalEnergies' address is "building, number street, town" with the empty parts left out. The building is the
   * nearest thing it has to a site name ("AMBIENCE FURNITURE LTD, PEARTREE LANE, DUDLEY"), so with three parts the
   * first is the site name; with two, only when it reads like a business or a building.
   */
  function splitAddress(address) {
    var parts = str(address).split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) return { site_name: null, address: null };
    var first = parts[0];
    var named = !/^\d/.test(first) && !/^(UNIT|FLAT|SUITE|APARTMENT|ROOM)\b/i.test(first)
      && (parts.length >= 3 || (parts.length === 2 && PLACE.test(first)));
    if (named) return { site_name: first, address: parts.slice(1).join(', ') };
    return { site_name: null, address: parts.join(', ') };
  }

  /**
   * What a TotalEnergies answer (a te-lookup result) fills in on "Price a meter that is not in the portfolio": the
   * values by box id (xAq, xPc, xStruct, xSsc, xLlfc, xSite, xAddr, xPostcode, xSerial) and what travels with the meter
   * (the usage split, the top line, when TotalEnergies answered). opts.recase re-cases TotalEnergies' capitals for the
   * site name and address (the page passes tradingName). Null for anything but a 'done' answer.
   */
  function manualFromTe(res, opts) {
    opts = opts || {};
    var recase = typeof opts.recase === 'function' ? opts.recase : function (s) { return s; };
    if (!res || res.status !== 'done') return null;
    var gas = res.utility === 'gas';
    var v = {};
    var eac = Number(gas ? (res.aq || res.eac) : res.eac);
    if (eac > 0) v.xAq = String(Math.round(eac));
    var a = splitAddress(res.address);
    if (a.site_name) v.xSite = recase(a.site_name);
    if (a.address) v.xAddr = recase(a.address);
    var pc = normPostcode(res.postcode);
    if (pc) v.xPostcode = pc;
    if (clean(res.serial)) v.xSerial = str(res.serial).trim();
    var type = null;
    if (!gas) {
      var p = digits(res.pc);
      if (p && Number(p) <= 8) v.xPc = String(Number(p));
      if (/^\d{4}$/.test(str(res.ssc))) v.xSsc = str(res.ssc);
      var ll = str(res.llfc).trim().toUpperCase();
      if (/^[0-9A-Z]{2,3}$/.test(ll)) v.xLlfc = /^\d+$/.test(ll) ? ('00' + ll).slice(-3) : ll;
      type = TYPE_LABEL[res.meter_type] ? res.meter_type : (TYPE_LABEL[res.meter_type_code] ? res.meter_type_code : null);
      if (type) v.xStruct = type;
    }
    return {
      fuel: gas ? 'gas' : 'electricity', id: digits(res.mpan), values: v, eac: eac > 0 ? Math.round(eac) : null,
      type: type, te_meter_type: res.te_meter_type || null, split: gas ? null : cleanSplit(res.split),
      top_line: res.top_line || null, mtc: res.mtc || null, postcode: pc, address: res.address || null,
      looked_up_at: res.looked_up_at || null, cached: !!res.cached,
      supported: res.supported == null ? null : !!res.supported, unsupported_reason: str(res.unsupported_reason),
      warnings: Array.isArray(res.warnings) ? res.warnings.filter(Boolean).map(str) : [],
    };
  }

  /** "site name, address, postcode, top line, meter type (Economy 7), EAC with its split (80% day / 20% night), serial". */
  function filledWords(f) {
    if (!f) return '';
    var v = f.values || {}, out = [];
    if (v.xSite) out.push('site name');
    if (v.xAddr) out.push('address');
    if (v.xPostcode) out.push('postcode');
    if (v.xPc || v.xSsc || v.xLlfc) out.push('top line');
    if (v.xStruct) out.push('meter type (' + TYPE_LABEL[v.xStruct] + ')');
    if (v.xAq) {
      var sw = splitWords(f.split);
      out.push((f.fuel === 'gas' ? 'AQ' : 'EAC') + (sw ? ' with its split (' + sw + ')' : ''));
    }
    if (v.xSerial) out.push('serial');
    return out.join(', ');
  }

  // --- suggestions ---------------------------------------------------------------------------------
  function low(s) { return str(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function compact(s) { return str(s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  /** How well t matches hay: whole 100, from the start 90, from the start of a word 75, anywhere 55, not at all 0. */
  function textScore(hay, t) {
    hay = low(hay); t = low(t);
    if (!hay || !t) return 0;
    if (hay === t) return 100;
    var i = hay.indexOf(t);
    if (i === 0) return 90;
    if (i > 0) return /[^a-z0-9]/.test(hay.charAt(i - 1)) ? 75 : 55;
    return 0;
  }
  function fuelWord(u) { return u === 'gas' ? 'Gas' : u === 'electricity' ? 'Electricity' : ''; }

  /**
   * Up to opts.max (12) suggestions for what was typed, from the rows the search would show: data.rows (portfolio
   * meters), data.crm (UtilityClick meters no portfolio holds), data.nameOf(row) (the customer's name). A number finds
   * meters by the start of their MPAN / MPRN (then anywhere in it); words find customers by name and sites by site
   * name, postcode or address. Each suggestion: {kind: 'meter'|'customer'|'site'|'crm', key, label, sub, score} plus
   * row (meter), crm (crm), customer_id, site_name, postcode (customer, site).
   */
  function rankSuggestions(term, data, opts) {
    opts = opts || {};
    var max = opts.max || 12;
    data = data || {};
    var rows = data.rows || [], crm = data.crm || [];
    var nameOf = typeof data.nameOf === 'function' ? data.nameOf : function (r) { return str(r.customer_name || r.customer_id); };
    var t = low(term), td = digits(term);
    var numeric = /^[\d\s]+$/.test(str(term).trim()) && td.length >= 3;
    var out = [];
    var capped = rows.length >= 50;

    rows.forEach(function (r) {
      var m = digits(r.mpan);
      var sc = 0;
      if (numeric) sc = m.indexOf(td) === 0 ? 100 : (m.indexOf(td) > 0 ? 60 : 0);
      if (!sc) return;
      out.push({ kind: 'meter', key: 'm:' + str(r.id || r.mpan), score: sc, label: str(r.mpan), row: r, utility: r.utility || null,
                 sub: [nameOf(r), r.site_name || r.postcode, fuelWord(r.utility)].filter(Boolean).join(' · ') });
    });

    if (!numeric && t.length) {
      var byCust = {}, custOrder = [];
      rows.forEach(function (r) {
        var id = str(r.customer_id);
        if (!id) return;
        if (!byCust[id]) { byCust[id] = []; custOrder.push(id); }
        byCust[id].push(r);
      });
      var custLabel = {};
      custOrder.forEach(function (id) {
        var list = byCust[id], name = str(nameOf(list[0])) || id;
        custLabel[id] = low(name);
        var sc = Math.max(textScore(name, t), textScore(id.replace(/[-_]+/g, ' '), t) - 5);
        if (sc <= 0) return;
        out.push({ kind: 'customer', key: 'c:' + id, score: sc - 2, label: name, customer_id: id,
                   sub: list.length + (capped ? '+' : '') + ' meter' + (list.length === 1 && !capped ? '' : 's') });
      });
      var bySite = {}, siteOrder = [];
      rows.forEach(function (r) {
        var site = str(r.site_name).trim(), pc = str(r.postcode).trim();
        if (!site && !pc) return;
        var k = str(r.customer_id) + '|' + (site ? 's:' + low(site) : 'p:' + compact(pc));
        if (!bySite[k]) { bySite[k] = { site: site, pc: pc, cid: str(r.customer_id), rows: [] }; siteOrder.push(k); }
        bySite[k].rows.push(r);
      });
      siteOrder.forEach(function (k) {
        var g = bySite[k];
        var ct = compact(term);
        var sc = Math.max(textScore(g.site, t),
                          ct.length >= 2 && compact(g.pc).indexOf(ct) === 0 ? 85 : 0,
                          g.rows.some(function (r) { return textScore(r.site_address, t) > 0; }) ? 50 : 0);
        if (sc <= 0) return;
        // A site called what its customer is called adds nothing to the customer's own line.
        if (g.site && custLabel[g.cid] === low(g.site) && out.some(function (s) { return s.kind === 'customer' && s.customer_id === g.cid; })) return;
        var cname = str(nameOf(g.rows[0]));
        out.push({ kind: 'site', key: 's:' + k, score: sc - 4, label: g.site || g.pc, customer_id: g.cid,
                   site_name: g.site || null, postcode: g.site ? null : (g.pc || null),
                   sub: [cname, g.site ? g.pc : '', g.rows.length + ' meter' + (g.rows.length === 1 ? '' : 's')].filter(Boolean).join(' · ') });
      });
    }

    var crmOut = [];
    crm.forEach(function (c) {
      var m = digits(c.mpan), sc = 0;
      if (numeric) sc = m.indexOf(td) === 0 ? 70 : (m.indexOf(td) > 0 ? 40 : 0);
      else if (t.length) {
        var ct = compact(term);
        sc = (textScore(c.customer_name, t) || textScore(c.site_name, t) || (ct.length >= 2 && compact(c.postcode).indexOf(ct) === 0)) ? 30 : 0;
      }
      if (!sc) return;
      crmOut.push({ kind: 'crm', key: 'u:' + str(c.uc_meter_id || c.mpan), score: sc, label: str(c.mpan), crm: c, utility: c.fuel || null,
                    sub: [c.customer_name, c.site_name || c.postcode, 'not in a portfolio'].filter(Boolean).join(' · ') });
    });
    // UtilityClick's own meters come after the portfolio's and never crowd it out.
    out = out.concat(crmOut.slice(0, 4));

    var order = numeric ? { meter: 0, crm: 1, customer: 2, site: 3 } : { customer: 0, site: 1, meter: 2, crm: 3 };
    out.sort(function (a, b) {
      return (b.score - a.score) || (order[a.kind] - order[b.kind]) || (low(a.label) < low(b.label) ? -1 : low(a.label) > low(b.label) ? 1 : 0);
    });
    return out.slice(0, max);
  }

  // --- Meter details (the gear) --------------------------------------------------------------------
  function normPc(v) { var d = digits(v); return d !== '' && Number(d) <= 8 ? String(Number(d)) : null; }
  function normSsc(v) { var d = digits(v); return d && d.length <= 4 ? ('0000' + d).slice(-4) : null; }
  function normLlfc(v) {
    var s = str(v).trim().toUpperCase();
    if (!s) return null;
    return /^\d{1,3}$/.test(s) ? ('00' + s).slice(-3) : s;
  }
  function normMtc(v) { var d = digits(v); return d && d.length <= 3 ? ('00' + d).slice(-3) : null; }
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function isoDate(v) { var s = str(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

  /** A meter row as the Meter details form holds it (every value normalised, so an untouched box is never a change). */
  function meterForm(meter) {
    var m = meter || {}, gas = m.utility === 'gas';
    return {
      site_name: clean(m.site_name), site_address: clean(m.site_address), postcode: normPostcode(m.postcode),
      profile_class: gas ? null : normPc(m.profile_class), ssc: gas ? null : normSsc(m.ssc), llfc: gas ? null : normLlfc(m.llfc),
      mtc: gas ? null : normMtc(m.mtc), meter_serial: clean(m.meter_serial),
      rate_structure: gas ? null : (TYPE_LABEL[m.rate_structure] ? m.rate_structure : clean(m.rate_structure)),
      est_annual_consumption: num(m.est_annual_consumption) == null ? null : Math.round(num(m.est_annual_consumption)),
      usage_split: cleanSplit(m.usage_split),
      supplier: clean(m.supplier), contract_end_date: isoDate(m.contract_end_date),
    };
  }

  function sortedJson(o) {
    if (o == null || typeof o !== 'object') return JSON.stringify(o);
    return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + sortedJson(o[k]); }).join(',') + '}';
  }
  function sameValue(a, b) {
    if (a === '' || a === undefined) a = null;
    if (b === '' || b === undefined) b = null;
    if (a === null || b === null) return a === b;
    if (typeof a === 'object' || typeof b === 'object') return sortedJson(a) === sortedJson(b);
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return String(a) === String(b);
  }
  /**
   * Only what changed, and only keys pricing_meter_update takes: {patch, changed}. A key missing from after is not a
   * change (the form did not hold it). '' is null.
   */
  function patchDiff(before, after) {
    var patch = {}, changed = [];
    before = before || {}; after = after || {};
    PATCH_KEYS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(after, k)) return;
      if (sameValue(before[k], after[k])) return;
      patch[k] = after[k] === '' || after[k] === undefined ? null : after[k];
      changed.push(k);
    });
    return { patch: patch, changed: changed };
  }
  function changedWords(keys) {
    return (keys || []).map(function (k) { return FIELD_WORDS[k] || str(k).replace(/_/g, ' '); }).join(', ');
  }

  // --- Manual review -------------------------------------------------------------------------------
  function reviewKindWords(kind) {
    var k = str(kind);
    if (KIND_WORDS[k]) return KIND_WORDS[k];
    var w = k.replace(/_/g, ' ').trim();
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : 'Something else';
  }
  function reviewHint(kind) { return KIND_HINT[str(kind)] || ''; }
  /** Which buttons an item gets: Take TotalEnergies' only when TotalEnergies has something to take. */
  function reviewActions(item) {
    var k = str(item && item.kind), t = (item && item.theirs) || {};
    var acts = ['keep_ours'];
    if (k === 'postcode_mismatch' ? !!(clean(t.postcode) || clean(t.address)) : k === 'consumption_jump') acts.push('take_theirs');
    acts.push('dismiss');
    return acts;
  }
  /** Ours against TotalEnergies', row by row: [{label, ours, theirs, differs}], rows where neither side says anything left out. */
  function reviewCompare(item, typeLabel) {
    var o = (item && item.ours) || {}, t = (item && item.theirs) || {};
    var gas = item && item.utility === 'gas';
    var tl = typeof typeLabel === 'function' ? typeLabel : function (c) { return TYPE_LABEL[c] || str(c); };
    var rows = [
      ['Postcode', str(o.postcode), str(t.postcode), function (a, b) { return !samePostcode(a, b); }],
      ['Address', str(o.site_address), str(t.address), function (a, b) { return low(a) !== low(b); }],
      ['Site name', str(o.site_name), '', null],
      [gas ? 'AQ (kWh)' : 'EAC (kWh)', o.est_annual_consumption == null ? '' : fmtN(o.est_annual_consumption),
       t.eac == null ? '' : fmtN(t.eac), function (a, b) { return a !== b; }],
      ['Serial number', str(o.meter_serial), str(t.serial), function (a, b) { return low(a) !== low(b); }],
    ];
    if (!gas) rows.push(['Meter type', o.rate_structure ? tl(o.rate_structure) : '', str(t.te_meter_type), null]);
    return rows.filter(function (r) { return r[1] || r[2]; }).map(function (r) {
      return { label: r[0], ours: r[1], theirs: r[2], differs: !!(r[3] && r[1] && r[2] && r[3](r[1], r[2])) };
    });
  }
  /** Claude's word on an item: "Claude: <reason> (needs a person, 70% sure)", or ''. */
  function claudeWords(v) {
    if (!v || typeof v !== 'object') return '';
    var reason = str(v.reason).trim(), verdict = str(v.verdict).replace(/_/g, ' ').trim();
    var c = Number(v.confidence), conf = isFinite(c) && c > 0 ? Math.round((c <= 1 ? c * 100 : c)) + '% sure' : '';
    var tail = [verdict, conf].filter(Boolean).join(', ');
    if (!reason && !tail) return '';
    return 'Claude: ' + (reason || 'no reason given') + (tail ? ' (' + tail + ')' : '');
  }

  // --- te-lookup -----------------------------------------------------------------------------------
  /** The JSON body of a non-2xx edge function answer (supabase-js puts the Response in error.context). */
  function errorBody(err) {
    var res = err && err.context, status = (res && res.status) || 0;
    var p = res && typeof res.text === 'function' ? Promise.resolve(res.text()).catch(function () { return ''; }) : Promise.resolve('');
    return p.then(function (raw) {
      var b = null; try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = null; }
      return { status: status, body: b || {} };
    });
  }
  function invokeTe(sb, body) {
    if (!sb || !sb.functions || typeof sb.functions.invoke !== 'function') {
      return Promise.resolve({ ok: false, code: 'unavailable', status: 0, error: 'The TotalEnergies lookup is not available on this page.' });
    }
    var p;
    try { p = Promise.resolve(sb.functions.invoke(TE_FN, { body: body })); } catch (e) { p = Promise.reject(e); }
    return p.then(function (r) {
      if (!r || !r.error) {
        var d = r ? r.data : null;
        if (d && d.error && !d.results) return { ok: false, code: d.code || 'error', status: 0, error: str(d.error) };
        return { ok: true, data: d || {} };
      }
      return errorBody(r.error).then(function (x) {
        var code = (x.body && x.body.code) || (x.status === 404 ? 'not_deployed' : x.status === 429 ? 'cap' : x.status === 401 ? 'auth' : 'error');
        return { ok: false, code: code, status: x.status, error: str((x.body && (x.body.error || x.body.message)) || r.error.message) };
      });
    }, function (e) { return { ok: false, code: 'error', status: 0, error: str((e && e.message) || e) }; });
  }
  /**
   * te-lookup for one MPAN or MPRN (SPEC-PORTALS.md F). opts {fuel, auto}: auto reuses an answer TotalEnergies gave
   * before (CES: "once its been done for the first time"). Resolves to {ok:true, result} or {ok:false, code, error,
   * result?}; never throws.
   */
  function lookupOne(sb, id, opts) {
    opts = opts || {};
    var k = idKind(id);
    var fuel = opts.fuel || k.fuel;
    if (!k.fuel || !k.ok) {
      return Promise.resolve({ ok: false, code: 'invalid', error: k.fuel === 'electricity'
        ? 'MPAN ' + k.id + ' fails its check digit, so it was not looked up.'
        : str(id) + ' is not an MPAN (13 digits) or an MPRN (6 to 10 digits).' });
    }
    var body = fuel === 'gas' ? { mprns: [k.id] } : { mpans: [k.id] };
    if (opts.auto) body.auto = true;
    return invokeTe(opts.sb || sb, body).then(function (x) {
      if (!x.ok) return x;
      var list = (x.data && x.data.results) || [];
      var res = list.filter(function (r) { return digits(r && r.mpan) === k.id; })[0];
      if (!res) return { ok: false, code: 'no_answer', error: 'TotalEnergies sent nothing back for ' + k.id + '.' };
      if (res.status !== 'done') {
        return { ok: false, code: res.status || 'failed', result: res,
                 error: str(res.message) || (res.status === 'not_found' ? 'TotalEnergies has no ' + (fuel === 'gas' ? 'gas meter with MPRN ' : 'electricity meter with MPAN ') + k.id + '.' : 'The TotalEnergies lookup failed.') };
      }
      return { ok: true, result: res };
    });
  }
  /** A calm sentence for a lookup that did not fill anything in. Nothing is ever blocked by it. */
  function lookupWords(out, fuel) {
    var o = out || {}, what = fuel === 'gas' ? 'MPRN' : 'MPAN';
    var byHand = ' Fill the boxes in by hand; nothing else is held up.';
    switch (o.code) {
      case 'not_found': return (o.error || ('TotalEnergies has no meter with this ' + what + '.')) + ' Check the number against a bill, or fill the boxes in by hand.';
      case 'invalid': return (o.error || ('That is not a valid ' + what + '.'));
      case 'not_configured': return 'TotalEnergies lookups are not set up on the server yet.' + byHand;
      case 'disabled': return 'TotalEnergies lookups are switched off at the moment.' + byHand;
      case 'busy': return 'Someone else is looking up on TotalEnergies right now. Press Search again in a few seconds.';
      case 'cap': return 'Today\'s TotalEnergies lookups are used up.' + byHand;
      case 'not_deployed': return 'The TotalEnergies lookup is not on this site yet.' + byHand;
      case 'auth': return 'Sign in again to look meters up on TotalEnergies.' + byHand;
      case 'forbidden': return 'TotalEnergies lookups are for CES staff.' + byHand;
      case 'unavailable': return 'The TotalEnergies lookup is not available on this page.' + byHand;
      default: return 'TotalEnergies did not answer just now' + (o.error ? ' (' + o.error + ')' : '') + '. Press Search again in a minute, or fill the boxes in by hand.';
    }
  }

  // ------------------------------------------------------------------ the browser side
  var STYLES = ''
    + '.msug{position:absolute;z-index:45;left:0;right:0;top:100%;margin-top:4px;max-height:380px;overflow:auto;background:var(--panel,#fff);'
    + 'border:1px solid var(--line-2,#c6d1e3);border-radius:10px;box-shadow:0 10px 30px rgba(19,32,57,.14);padding:4px}'
    + '.msug.hide{display:none}'
    + '.msug-i{display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-radius:7px;cursor:pointer}'
    + '.msug-i.on,.msug-i:hover{background:var(--cyan-glow,rgba(31,79,174,.08))}'
    + '.msug-k{flex:0 0 66px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#526179)}'
    + '.msug-b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.msug-l{font-weight:700;color:var(--text,#132039);font-size:13px}'
    + '.msug-s{font-size:11.5px;color:var(--muted,#526179);margin-left:6px}'
    + '.msug-none{padding:8px 10px;font-size:12px;color:var(--muted,#526179)}'
    + '.te-filled{background:var(--ok-bg,#e4f1e7)!important}'
    + '.te-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;background:var(--ok-bg,#e4f1e7);color:var(--ok,#12682f);'
    + 'font-size:9.5px;letter-spacing:.02em;text-transform:none;font-weight:700;vertical-align:1px}'
    + '.mt-wrap{position:fixed;inset:0;z-index:60;background:rgba(10,18,36,.45);display:grid;place-items:center;padding:16px}'
    + '.mt-card{width:100%;max-width:820px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:14px;'
    + 'box-shadow:0 20px 50px rgba(0,0,0,.3);padding:22px}'
    + '.mt-card h2{font-size:17px;margin:0 0 6px}'
    + '.mt-card p{font-size:12.5px;color:var(--muted,#526179);line-height:1.55;margin:0 0 12px}'
    + '.mt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px 14px}'
    + '.mt-f.w2{grid-column:span 2}'
    + '.mt-sec{grid-column:1/-1;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2,#3d4c66);'
    + 'margin-top:6px;padding-top:10px;border-top:1px solid var(--line,#dde4ef)}'
    + '.mt-top{display:flex;gap:6px}.mt-top input{min-width:0;text-align:center}'
    + '.mt-ro{font-size:13px;color:var(--text,#132039);padding:8px 0;line-height:1.4}'
    + '.mt-card input:disabled,.mt-card select:disabled{background:var(--panel-2,#edf2f9);color:var(--text,#132039);opacity:1}'
    + '.mt-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center}'
    + '.mt-msg{margin-top:12px}'
    + '.mr-head{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px}'
    + '.mr-counts{display:flex;gap:6px;flex-wrap:wrap;flex:1}'
    + '.mr-item{border:1px solid var(--line,#dde4ef);border-radius:10px;padding:12px 14px;margin-top:10px;background:var(--panel,#fff)}'
    + '.mr-top{display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center;font-size:12.5px}'
    + '.mr-cmp{margin-top:8px;max-width:760px}.mr-cmp td,.mr-cmp th{font-size:12px;padding:5px 8px}'
    + '.mr-cmp td.diff{background:var(--warn-bg,#f7efdc);font-weight:700}'
    + '.mr-claude{font-size:12px;color:var(--text-2,#3d4c66);margin-top:8px;line-height:1.5}'
    + '.mr-hint{font-size:11.5px;color:var(--muted,#526179);margin-top:4px}'
    + '.mr-btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}'
    + '.mr-btns input{max-width:280px;height:30px;font-size:12px;padding:4px 8px}';

  function injectStyles(doc) {
    if (!doc || !doc.head || doc.getElementById('mtStyles')) return;
    var s = doc.createElement('style'); s.id = 'mtStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }

  /**
   * Mark a box (and its label) as filled from TotalEnergies, or clear the mark. The mark goes when the person types
   * in the box, because from then on the value is theirs.
   */
  function markFilled(el, on) {
    if (!el) return;
    var doc = el.ownerDocument;
    injectStyles(doc);
    el.classList.toggle('te-filled', !!on);
    var lab = el.id && doc ? doc.querySelector('label[for="' + el.id + '"]') : null;
    var tag = lab ? lab.querySelector('.te-tag') : null;
    if (on) {
      el.title = 'from TotalEnergies';
      if (lab && !tag) { tag = doc.createElement('span'); tag.className = 'te-tag'; tag.textContent = 'from TotalEnergies'; lab.appendChild(tag); }
      if (!el.__teWatch) {
        el.__teWatch = true;
        var off = function () { if (el.classList.contains('te-filled')) markFilled(el, false); };
        el.addEventListener('input', off);
        el.addEventListener('change', off);
      }
    } else {
      if (el.title === 'from TotalEnergies') el.title = '';
      if (tag) tag.remove();
    }
  }

  /**
   * The drop-down under a search box. deps: {fetch(term) -> Promise<suggestions>, pick(suggestion), esc, minChars (3),
   * delay (250 ms), max (12), doc}. The page calls onInput() from the box's input event and onKey(e) from its keydown;
   * onKey returns true when it used the key (the page then does nothing more with it). Enter with nothing highlighted
   * is left to the page (its Search). A late answer for an older term is dropped.
   */
  function typeahead(input, deps) {
    deps = deps || {};
    var doc = deps.doc || input.ownerDocument;
    var esc = deps.esc || escDefault;
    var min = deps.minChars || 3, delay = deps.delay == null ? 250 : deps.delay, max = deps.max || 12;
    injectStyles(doc);
    var list = deps.list || null;
    if (!list) {
      list = doc.createElement('div');
      list.id = (input.id || 'search') + 'Suggest';
      list.className = 'msug hide';
      input.parentNode.appendChild(list);
    }
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Suggestions');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('autocomplete', 'off');
    var S = { items: [], active: -1, open: false, seq: 0, timer: null, blurT: null, term: '', shownFor: '' };
    var KIND = { meter: 'Meter', customer: 'Customer', site: 'Site', crm: 'Meter' };

    function paint() {
      if (!S.open) { list.classList.add('hide'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); return; }
      list.classList.remove('hide');
      input.setAttribute('aria-expanded', 'true');
      if (!S.items.length) {
        list.innerHTML = '<div class="msug-none">Nothing matches yet. Press Enter or Search to search everything.</div>';
        input.removeAttribute('aria-activedescendant');
        return;
      }
      list.innerHTML = S.items.map(function (s, i) {
        return '<div class="msug-i' + (i === S.active ? ' on' : '') + '" role="option" id="' + list.id + '-' + i + '" data-i="' + i
          + '" aria-selected="' + (i === S.active ? 'true' : 'false') + '"><span class="msug-k">' + esc(KIND[s.kind] || '') + '</span>'
          + '<span class="msug-b"><span class="msug-l' + (s.kind === 'meter' || s.kind === 'crm' ? ' mono' : '') + '">' + esc(s.label) + '</span>'
          + (s.sub ? '<span class="msug-s">' + esc(s.sub) + '</span>' : '') + '</span></div>';
      }).join('');
      if (S.active >= 0) {
        input.setAttribute('aria-activedescendant', list.id + '-' + S.active);
        var on = list.querySelector('[data-i="' + S.active + '"]');
        if (on && typeof on.scrollIntoView === 'function') { try { on.scrollIntoView({ block: 'nearest' }); } catch (_) { /* old browser */ } }
      } else input.removeAttribute('aria-activedescendant');
    }
    function close() { S.open = false; S.active = -1; paint(); }
    function cancel() { S.seq++; if (S.timer) { clearTimeout(S.timer); S.timer = null; } close(); }
    function run() {
      S.timer = null;
      var term = S.term, my = ++S.seq;
      var p;
      try { p = Promise.resolve(deps.fetch(term)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (items) {
        if (my !== S.seq || str(input.value).trim() !== term) return;
        S.items = (items || []).slice(0, max);
        S.active = -1;
        S.open = doc.activeElement === input || !!deps.keepOpen;
        S.shownFor = term;
        paint();
      }, function () { if (my === S.seq) close(); });
    }
    function onInput() {
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
      S.term = str(input.value).trim();
      if (S.term.length < min) { S.seq++; S.items = []; close(); return; }
      S.timer = setTimeout(run, delay);
    }
    function choose(i) {
      var s = S.items[i];
      if (!s) return;
      cancel();
      if (deps.pick) deps.pick(s);
    }
    function onKey(e) {
      var k = e && e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        if (!S.items.length) return false;
        e.preventDefault();
        if (!S.open) { S.open = true; S.active = k === 'ArrowDown' ? 0 : S.items.length - 1; paint(); return true; }
        var n = S.items.length;
        S.active = k === 'ArrowDown' ? (S.active + 1) % n : (S.active <= 0 ? n - 1 : S.active - 1);
        paint();
        return true;
      }
      if (k === 'Enter') {
        if (S.open && S.active >= 0) { e.preventDefault(); choose(S.active); return true; }
        cancel();
        return false;
      }
      if (k === 'Escape') {
        if (!S.open) return false;
        e.preventDefault();
        close();
        return true;
      }
      if (k === 'Tab') close();
      return false;
    }
    // The mouse: mousedown keeps the focus in the box (so the blur does not close the list first), click picks.
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-i]') : null;
      if (el) choose(Number(el.getAttribute('data-i')));
    });
    list.addEventListener('mousemove', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-i]') : null;
      if (!el) return;
      var i = Number(el.getAttribute('data-i'));
      if (i !== S.active) { S.active = i; paint(); }
    });
    input.addEventListener('blur', function () { S.blurT = setTimeout(close, 150); });
    input.addEventListener('focus', function () {
      if (S.blurT) { clearTimeout(S.blurT); S.blurT = null; }
      if (S.items.length && S.shownFor === str(input.value).trim()) { S.open = true; paint(); }
    });
    return { onInput: onInput, onKey: onKey, close: close, cancel: cancel, choose: choose, run: run, state: S, list: list };
  }

  /**
   * Meter details: the gear next to the MPAN on Price a meter, laid out like UtilityClick's meter form.
   * deps: {sb, esc, doc, canEdit, onFile, structOptions [[code, words]], registers {type: [regs]}, registerLabel,
   * suppliers [names], whenUk, onSaved({changed, meter, patch}), onLocal(patch, changed)}.
   *   * onFile and canEdit (the pricing team): Save sends only what changed to pricing_meter_update and calls onSaved.
   *   * onFile and not canEdit (a broker): every box is read only; Close.
   *   * not onFile (a meter typed in by hand): Save changes this quote only (onLocal); nothing is sent.
   * Returns {close, save, state}.
   */
  function openMeterDialog(meter, deps) {
    deps = deps || {};
    var doc = deps.doc || root.document;
    var esc = deps.esc || escDefault;
    var sb = deps.sb;
    injectStyles(doc);
    var m = meter || {};
    var gas = m.utility === 'gas';
    var onFile = deps.onFile != null ? !!deps.onFile : (!m.manual && !!m.id);
    var canEdit = deps.canEdit != null ? !!deps.canEdit : true;
    var editable = canEdit || !onFile;
    var regsFor = function (type) { var R = deps.registers || REGS; return (R[type] || ['total']).slice(); };
    var regLabel = deps.registerLabel || REG_LABEL;
    var opts = deps.structOptions || [['', 'Not known']].concat(Object.keys(TYPE_LABEL).map(function (k) { return [k, TYPE_LABEL[k]]; }));
    var when = typeof deps.whenUk === 'function' ? deps.whenUk : whenUk;
    var before = meterForm(m);
    var S = { touched: { eac: false, type: false, split: false }, busy: false, regs: regsFor(gas ? 'single' : (before.rate_structure || '')) };

    var wrap = doc.createElement('div');
    wrap.className = 'mt-wrap';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'mtTitle');
    var dis = editable ? '' : ' disabled';
    var val = function (v) { return v == null ? '' : esc(v); };
    var field = function (id, label, inner, cls) {
      return '<div class="mt-f' + (cls ? ' ' + cls : '') + '"><label' + (id ? ' for="' + id + '"' : '') + '>' + esc(label) + '</label>' + inner + '</div>';
    };
    var input = function (id, v, extra) { return '<input id="' + id + '"' + (extra || '') + ' value="' + val(v) + '"' + dis + ' />'; };
    var ro = function (text) { return '<div class="mt-ro">' + esc(text) + '</div>'; };
    var teWhen = m.te_checked_at ? when(m.te_checked_at) : '';
    var teState = { found: 'found', not_found: 'not found', failed: 'did not answer', invalid: 'not a valid number' }[str(m.te_status)] || '';
    var teBits = [m.te_meter_type, m.te_postcode].filter(Boolean).join(', ');
    var teText = m.te_checked_at
      ? (teWhen || 'yes') + (teState ? ': ' + teState : '') + (teBits ? ' (' + teBits + ')' : '')
      : (m.te_check && m.te_check.state === 'local' ? 'Used on this quote only' : 'Not yet');
    var pcShow = before.profile_class == null ? '' : ('0' + before.profile_class).slice(-2);
    var lead = !onFile
      ? 'This meter is not on file, so what you change here is used on this quote only. Nothing is saved.'
      : canEdit
      ? 'What you change is saved to the meter for everyone, and every change is logged. Leave a box as it is to keep it.'
      : 'Only the pricing team can change these. If something is wrong, tell them.';
    var supList = (deps.suppliers || []).map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('');

    wrap.innerHTML = '<div class="mt-card">'
      + '<h2 id="mtTitle">Meter details</h2><p>' + esc(lead) + '</p>'
      + '<div class="mt-grid">'
      + field('', 'Utility', ro(gas ? 'Gas' : 'Electricity'))
      + field('', gas ? 'MPRN' : 'MPAN', '<div class="mt-ro mono">' + esc(m.mpan) + '</div>')
      + (gas ? '' : field('mtPc', 'Top line (PC | SSC | LLFC)',
          '<div class="mt-top">' + input('mtPc', pcShow, ' class="mono" maxlength="2" aria-label="Profile class" style="flex:0 0 52px"')
          + input('mtSsc', before.ssc, ' class="mono" maxlength="4" aria-label="SSC" style="flex:0 0 74px"')
          + input('mtLlfc', before.llfc, ' class="mono" maxlength="3" aria-label="LLFC" style="flex:0 0 64px"') + '</div>', 'w2')
        + field('mtMtc', 'MTC', input('mtMtc', before.mtc, ' class="mono" maxlength="3"')))
      + field('mtSerial', 'Serial number', input('mtSerial', before.meter_serial, ' class="mono"'))
      + (gas ? '' : field('mtType', 'Meter type', '<select id="mtType"' + dis + '>' + opts.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (str(o[0]) === str(before.rate_structure || '') ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + (before.rate_structure && !opts.some(function (o) { return o[0] === before.rate_structure; })
          ? '<option value="' + esc(before.rate_structure) + '" selected>' + esc(before.rate_structure) + '</option>' : '') + '</select>'))
      + field('mtEac', gas ? 'Annual consumption, AQ (kWh)' : 'Annual consumption, EAC (kWh)',
              input('mtEac', before.est_annual_consumption, ' class="mono" inputmode="numeric"'))
      + '<div id="mtSplit" style="display:contents"></div>'
      + '<div class="mt-sec">Site</div>'
      + field('mtSite', 'Site name', input('mtSite', before.site_name), 'w2')
      + field('mtAddr', 'Site address', input('mtAddr', before.site_address), 'w2')
      + field('mtPost', 'Postcode', input('mtPost', before.postcode, ' class="mono"'))
      + '<div class="mt-sec">Supply</div>'
      + field('mtSup', 'Current supplier', input('mtSup', before.supplier, ' list="mtSupList"') + '<datalist id="mtSupList">' + supList + '</datalist>', 'w2')
      + field('mtEnd', 'Contract end date', input('mtEnd', before.contract_end_date, ' type="date"'))
      + field('', 'Last checked on TotalEnergies', ro(teText), 'w2')
      + '</div>'
      + '<div class="mt-msg" id="mtMsg"></div>'
      + '<div class="mt-btns">'
      + (editable ? '<button class="act" type="button" data-mt="save">' + (onFile ? 'Save to the meter' : 'Use on this quote') + '</button>'
                    + '<button class="act ghost" type="button" data-mt="cancel">Cancel</button>'
                  : '<button class="act" type="button" data-mt="cancel">Close</button>')
      + '</div></div>';
    doc.body.appendChild(wrap);
    var $ = function (id) { return wrap.querySelector('#' + id); };

    function splitValues() {
      var o = {};
      S.regs.forEach(function (r) { var el = $('mtK_' + r); o[r] = el ? str(el.value).replace(/[,\s]/g, '') : ''; });
      return o;
    }
    function boxesFilled(o) { return S.regs.length > 1 && S.regs.every(function (r) { return o[r] !== '' && isFinite(Number(o[r])); }); }
    function paintSplit(values) {
      var host = $('mtSplit');
      if (!host) return;
      if (gas || S.regs.length < 2) { host.innerHTML = ''; return; }
      host.innerHTML = S.regs.map(function (r) {
        var v = values && values[r] != null ? values[r] : '';
        return field('mtK_' + r, regLabel[r] || r, '<input id="mtK_' + r + '" class="mono" inputmode="numeric" data-k="' + r + '" value="' + val(v) + '"' + dis + ' />');
      }).join('');
      S.regs.forEach(function (r) {
        var el = $('mtK_' + r);
        if (el) el.addEventListener('input', onSplitInput);
      });
    }
    function onSplitInput() {
      S.touched.split = true;
      var o = splitValues();
      if (boxesFilled(o)) {
        var sum = S.regs.reduce(function (a, r) { return a + Number(o[r]); }, 0);
        $('mtEac').value = String(Math.round(sum));
      }
    }
    function onEacInput() {
      S.touched.eac = true;
      var o = splitValues(), e = Number(str($('mtEac').value).replace(/[,\s]/g, ''));
      if (boxesFilled(o) && e > 0) {
        var asSplit = {}; S.regs.forEach(function (r) { asSplit[r] = Number(o[r]); });
        var next = splitToBoxes(asSplit, S.regs, e);
        if (next) S.regs.forEach(function (r) { var el = $('mtK_' + r); if (el) el.value = String(next[r]); });
      }
    }
    function onTypeInput() {
      S.touched.type = true;
      var o = splitValues(), asSplit = null;
      if (boxesFilled(o)) { asSplit = {}; S.regs.forEach(function (r) { asSplit[r] = Number(o[r]); }); }
      S.regs = regsFor($('mtType').value || '');
      var e = Number(str($('mtEac').value).replace(/[,\s]/g, ''));
      paintSplit(splitToBoxes(asSplit || before.usage_split, S.regs, e > 0 ? e : null));
    }
    paintSplit(splitToBoxes(before.usage_split, S.regs, before.est_annual_consumption));
    if (editable) {
      $('mtEac').addEventListener('input', onEacInput);
      if ($('mtType')) $('mtType').addEventListener('change', onTypeInput);
    }

    /** The form as values, every one checked: {after, errors}. */
    function read() {
      var errs = [], a = {};
      var v = function (id) { var el = $(id); return el ? str(el.value).trim() : ''; };
      a.site_name = clean(v('mtSite'));
      a.site_address = clean(v('mtAddr'));
      a.postcode = normPostcode(v('mtPost'));
      a.meter_serial = clean(v('mtSerial'));
      a.supplier = clean(v('mtSup'));
      var end = v('mtEnd');
      if (end && !isoDate(end)) errs.push('The contract end date is not a date.');
      a.contract_end_date = isoDate(end);
      if (!gas) {
        var pc = v('mtPc');
        if (pc && (!/^\d{1,2}$/.test(pc) || Number(pc) > 8)) errs.push('The profile class is 00 to 08.');
        else a.profile_class = pc ? String(Number(pc)) : null;
        var ssc = v('mtSsc');
        if (ssc && !/^\d{4}$/.test(ssc)) errs.push(/^\d{3}$/.test(ssc)
          ? '"' + ssc + '" is three digits, so it is a meter timeswitch code, not an SSC. The SSC is four digits (0393, 0151).'
          : 'The SSC is four digits, for example 0393.');
        else a.ssc = ssc || null;
        var ll = v('mtLlfc').toUpperCase();
        if (ll && !/^(\d{1,3}|[0-9A-Z]{2,3})$/.test(ll)) errs.push('The LLFC is three letters or digits, for example 631 or 02D.');
        else a.llfc = normLlfc(ll);
        var mtc = v('mtMtc');
        if (mtc && !/^\d{1,3}$/.test(mtc)) errs.push('The MTC is three digits, for example 801.');
        else a.mtc = normMtc(mtc);
        a.rate_structure = v('mtType') || null;
      }
      var eacRaw = v('mtEac').replace(/[,\s]/g, '');
      if (eacRaw && !(Number(eacRaw) >= 0)) errs.push('The annual consumption is a number of kWh.');
      else a.est_annual_consumption = eacRaw ? Math.round(Number(eacRaw)) : null;
      if (!gas && (S.touched.eac || S.touched.type || S.touched.split)) {
        if (S.regs.length > 1) {
          var o = splitValues();
          var some = S.regs.some(function (r) { return o[r] !== ''; });
          if (some && !boxesFilled(o)) errs.push('Fill every kWh box of the split, or leave them all empty.');
          else if (some) {
            var sp = {}, sum = 0;
            S.regs.forEach(function (r) { sp[r] = Math.round(Number(o[r])); sum += sp[r]; });
            a.usage_split = sp;
            a.est_annual_consumption = sum;
          } else a.usage_split = null;
        } else {
          a.usage_split = a.est_annual_consumption ? (S.regs[0] === 'total' ? { total: a.est_annual_consumption } : (function () {
            var x = {}; x[S.regs[0]] = a.est_annual_consumption; return x; })()) : null;
        }
      }
      return { after: a, errors: errs };
    }
    function msg(kind, text) {
      var el = $('mtMsg');
      if (el) el.innerHTML = text ? '<div class="note ' + (kind || '') + '">' + esc(text) + '</div>' : '';
    }
    function close() {
      doc.removeEventListener('keydown', onKey);
      wrap.remove();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    doc.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });

    function save() {
      if (S.busy || !editable) return Promise.resolve(null);
      var r = read();
      if (r.errors.length) { msg('bad', r.errors.join(' ')); return Promise.resolve(null); }
      var d = patchDiff(before, r.after);
      if (!d.changed.length) { msg('', 'Nothing has changed.'); return Promise.resolve(null); }
      if (!onFile) {
        close();
        if (deps.onLocal) deps.onLocal(d.patch, d.changed);
        return Promise.resolve({ local: true, patch: d.patch, changed: d.changed });
      }
      S.busy = true;
      var btn = wrap.querySelector('[data-mt="save"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      msg('', '');
      var p;
      try { p = Promise.resolve(sb.rpc('pricing_meter_update', { p_meter_id: m.id, p_patch: d.patch })); } catch (e) { p = Promise.reject(e); }
      return p.then(function (res) {
        if (res && res.error) {
          var e = res.error, missing = e.code === 'PGRST202' || e.code === '42883' || res.status === 404
            || /could not find the function|function .* does not exist/i.test(e.message || '');
          throw new Error(missing ? 'Saving meter details is not installed yet (pricing_meter_update). Nothing was changed.' : (e.message || 'The save failed.'));
        }
        var out = res ? res.data : null;
        if (Array.isArray(out)) out = out[0];
        if (out && out.ok === false) throw new Error(str(out.error || out.message) || 'The meter was not saved.');
        close();
        var result = { changed: (out && Array.isArray(out.changed) && out.changed.length ? out.changed : d.changed),
                       meter: (out && out.meter) || null, patch: d.patch };
        if (deps.onSaved) deps.onSaved(result);
        return result;
      }).catch(function (e) {
        S.busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Save to the meter'; }
        msg('bad', (e && e.message) || String(e));
        return null;
      });
    }
    wrap.querySelector('[data-mt="cancel"]').addEventListener('click', close);
    var sv = wrap.querySelector('[data-mt="save"]');
    if (sv) sv.addEventListener('click', save);
    var first = wrap.querySelector('input:not([disabled]), select:not([disabled]), button');
    if (first && typeof first.focus === 'function') { try { first.focus(); } catch (_) { /* fine */ } }
    return { close: close, save: save, read: read, state: S, el: wrap };
  }

  /**
   * Settings > Manual review. deps: {sb, esc, whenUk, typeLabel, onChange}. Counts from meter_review_counts(), the list
   * from meter_review_list(status), and Keep ours / Take TotalEnergies' / Dismiss through meter_review_resolve.
   * A consumption jump's Keep ours first puts our figure back on the meter (pricing_meter_update), because the meter
   * already uses TotalEnergies' figure. Returns {refresh, state}.
   */
  function mountReview(host, deps) {
    deps = deps || {};
    var doc = host.ownerDocument;
    var esc = deps.esc || escDefault, sb = deps.sb;
    var when = typeof deps.whenUk === 'function' ? deps.whenUk : whenUk;
    injectStyles(doc);
    var S = { status: 'needs_person', counts: null, items: [], missing: false, err: '', loading: true, busy: {}, notes: {} };
    var STATUS = [['needs_person', 'Needs a person'], ['open', 'Open (Claude has not looked yet)'], ['done', 'Done']];
    var DONE = ['claude_ok', 'resolved', 'dismissed'];
    var STATUS_WORDS = { open: 'waiting for Claude', needs_person: 'needs a person', claude_ok: 'sorted by Claude',
                         resolved: 'resolved', dismissed: 'dismissed' };

    function missingFn(r) {
      var e = r && r.error;
      if (!e) return false;
      return e.code === 'PGRST202' || e.code === '42883' || r.status === 404 || /could not find the function|function .* does not exist/i.test(e.message || '');
    }
    function call(name, args) {
      var p;
      try { p = Promise.resolve(sb.rpc(name, args)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (r) {
        if (missingFn(r)) { var x = new Error('missing'); x.missing = true; throw x; }
        if (r && r.error) throw new Error(r.error.message || 'failed');
        return r ? r.data : null;
      });
    }
    function counts() {
      var c = S.counts || {};
      var chip = function (k, label, cls) {
        var n = Number(c[k]) || 0;
        return '<span class="pill ' + (n && cls ? cls : 'p-mute') + '">' + esc(label) + ' ' + n + '</span>';
      };
      return chip('needs_person', 'Needs a person', 'p-warn') + chip('open', 'Waiting for Claude', '') + chip('claude_ok', 'Sorted by Claude', 'p-ok')
        + chip('resolved', 'Resolved', '') + chip('dismissed', 'Dismissed', '');
    }
    function itemHtml(it) {
      var cmp = reviewCompare(it, deps.typeLabel);
      var acts = DONE.indexOf(it.status) >= 0 ? [] : reviewActions(it);
      var busy = !!S.busy[it.id];
      var words = { keep_ours: 'Keep ours', take_theirs: 'Take TotalEnergies\'', dismiss: 'Dismiss' };
      var cw = claudeWords(it.claude_verdict);
      return '<div class="mr-item" data-mr-item="' + esc(it.id) + '">'
        + '<div class="mr-top"><b class="mono">' + esc(it.mpan) + '</b>'
        + '<span class="pill p-mute">' + esc(it.utility === 'gas' ? 'Gas' : 'Electricity') + '</span>'
        + (it.customer_name ? '<span>' + esc(it.customer_name) + '</span>' : '')
        + (it.site_name ? '<span style="color:var(--muted)">' + esc(it.site_name) + '</span>' : '')
        + '<span class="pill ' + (it.kind === 'not_found' || it.kind === 'consumption_jump' ? 'p-fail' : 'p-warn') + '">' + esc(reviewKindWords(it.kind)) + '</span>'
        + (DONE.indexOf(it.status) >= 0 ? '<span class="pill p-ok">' + esc(STATUS_WORDS[it.status] || it.status) + '</span>' : '')
        + '<span style="color:var(--muted);font-size:11.5px">' + esc(when(it.created_at)) + '</span></div>'
        + (cmp.length ? '<table class="mr-cmp"><thead><tr><th></th><th>Ours</th><th>TotalEnergies\'</th></tr></thead><tbody>'
          + cmp.map(function (r) {
              return '<tr><th scope="row">' + esc(r.label) + '</th><td' + (r.differs ? ' class="diff"' : '') + '>' + esc(r.ours || '') + '</td>'
                + '<td' + (r.differs ? ' class="diff"' : '') + '>' + esc(r.theirs || '') + '</td></tr>';
            }).join('') + '</tbody></table>' : '')
        + '<div class="mr-claude">' + esc(cw || (it.status === 'open' ? 'Claude has not looked at this yet.' : 'Claude gave no reason.')) + '</div>'
        + (acts.length ? '<div class="mr-hint">' + esc(reviewHint(it.kind)) + '</div><div class="mr-btns">'
          + acts.map(function (a) {
              return '<button class="act ' + (a === 'dismiss' ? 'ghost ' : '') + 'sm" type="button" data-mr-act="' + a + '" data-id="' + esc(it.id) + '"'
                + (busy ? ' disabled' : '') + '>' + esc(words[a]) + '</button>';
            }).join('')
          + '<input data-mr-note="' + esc(it.id) + '" placeholder="Note (optional)" value="' + esc(S.notes[it.id] || '') + '" aria-label="Note" />'
          + '<span data-mr-msg="' + esc(it.id) + '" style="font-size:11.5px"></span></div>' : '')
        + '</div>';
    }
    function paint() {
      if (S.missing) {
        host.innerHTML = '<div class="note">Manual review is not installed yet (meter_review_list). It appears here on its own once it is.</div>';
        return;
      }
      host.innerHTML = '<div class="mr-head"><div class="mr-counts">' + counts() + '</div>'
        + '<div><label for="mrStatus">Show</label><select id="mrStatus" data-mr="status" style="width:auto">'
        + STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === S.status ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('')
        + '</select></div><div><button class="act ghost sm" type="button" data-mr="refresh">Refresh</button></div></div>'
        + (S.err ? '<div class="note bad">' + esc(S.err) + '</div>' : '')
        + (S.loading ? '<div class="note">Loading&hellip;</div>'
          : !S.items.length ? '<div class="note good">' + esc(S.status === 'needs_person' ? 'Nothing needs a person. Claude has settled everything TotalEnergies threw up so far.'
                                                          : S.status === 'open' ? 'Nothing is waiting for Claude.' : 'Nothing done yet.') + '</div>'
          : S.items.map(itemHtml).join(''));
      var sel = host.querySelector('[data-mr="status"]');
      if (sel) sel.addEventListener('change', function () { S.status = sel.value; refresh(); });
      var rf = host.querySelector('[data-mr="refresh"]');
      if (rf) rf.addEventListener('click', function () { refresh(); });
      Array.prototype.forEach.call(host.querySelectorAll('[data-mr-note]'), function (el) {
        el.addEventListener('input', function () { S.notes[el.getAttribute('data-mr-note')] = el.value; });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-mr-act]'), function (b) {
        b.addEventListener('click', function () { resolve(b.getAttribute('data-id'), b.getAttribute('data-mr-act')); });
      });
    }
    function list(status) {
      var want = status === 'done' ? DONE : [status];
      return Promise.all(want.map(function (s) { return call('meter_review_list', { p_status: s, p_limit: 500 }); })).then(function (parts) {
        var all = [];
        parts.forEach(function (p) { (p || []).forEach(function (x) { all.push(x); }); });
        all.sort(function (a, b) { return str(b.created_at) < str(a.created_at) ? -1 : str(b.created_at) > str(a.created_at) ? 1 : 0; });
        return all;
      });
    }
    function refresh() {
      S.loading = true; S.err = '';
      paint();
      var cp = call('meter_review_counts', {}).then(function (c) { S.counts = (Array.isArray(c) ? c[0] : c) || {}; },
                                                   function (e) { if (e && e.missing) throw e; S.counts = null; });
      var lp = list(S.status).then(function (items) { S.items = items; });
      return Promise.all([cp, lp]).then(function () { S.loading = false; S.missing = false; paint(); }, function (e) {
        S.loading = false;
        if (e && e.missing) S.missing = true;
        else S.err = 'The review list did not load: ' + ((e && e.message) || e);
        paint();
      });
    }
    /** Keep ours on a consumption jump: our figure back on the meter (the split scaled to it), then resolved. */
    function putOursBack(it) {
      var o = it.ours || {};
      var eac = num(o.est_annual_consumption);
      if (eac == null) return Promise.resolve('');
      var b = sb.from('meters').select('id,est_annual_consumption,usage_split,rate_structure').eq('mpan', it.mpan).eq('utility', it.utility || 'electricity');
      if (o.customer_id) b = b.eq('customer_id', o.customer_id);
      return Promise.resolve(b.limit(5)).then(function (r) {
        if (r && r.error) throw new Error(r.error.message);
        var rows = (r && r.data) || [];
        if (!rows.length) return '';
        return Promise.all(rows.map(function (row) {
          var patch = { est_annual_consumption: eac };
          var sp = cleanSplit(row.usage_split);
          if (sp) {
            var keys = Object.keys(sp);
            patch.usage_split = sp.total != null ? { total: Math.round(eac) } : splitToBoxes(sp, keys, eac);
          }
          return call('pricing_meter_update', { p_meter_id: row.id, p_patch: patch });
        })).then(function () { return 'our figure (' + fmtN(eac) + ' kWh) put back'; });
      });
    }
    function resolve(id, action) {
      var it = S.items.filter(function (x) { return str(x.id) === str(id); })[0];
      if (!it || S.busy[id]) return Promise.resolve(null);
      S.busy[id] = true;
      var noteEl = host.querySelector('[data-mr-note="' + id + '"]');
      var typed = noteEl ? str(noteEl.value).trim() : str(S.notes[id]).trim();
      Array.prototype.forEach.call(host.querySelectorAll('[data-id="' + id + '"]'), function (b) { b.disabled = true; });
      var first = it.kind === 'consumption_jump' && action === 'keep_ours' ? putOursBack(it) : Promise.resolve('');
      var auto = it.kind === 'consumption_jump' && action === 'take_theirs' ? 'TotalEnergies\' figure kept (it was already on the meter)' : '';
      return first.then(function (did) {
        var note = [typed, did, auto].filter(Boolean).join('; ') || null;
        return call('meter_review_resolve', { p_id: it.id, p_action: action, p_note: note });
      }).then(function () {
        delete S.busy[id];
        S.items = S.items.filter(function (x) { return str(x.id) !== str(id); });
        if (S.counts) {
          var from = it.status, to = action === 'dismiss' ? 'dismissed' : 'resolved';
          if (S.counts[from] != null) S.counts[from] = Math.max(0, Number(S.counts[from]) - 1);
          S.counts[to] = (Number(S.counts[to]) || 0) + 1;
        }
        paint();
        if (deps.onChange) deps.onChange({ id: id, action: action });
        return true;
      }, function (e) {
        delete S.busy[id];
        Array.prototype.forEach.call(host.querySelectorAll('[data-id="' + id + '"]'), function (b) { b.disabled = false; });
        var m = host.querySelector('[data-mr-msg="' + id + '"]');
        if (m) { m.style.color = 'var(--fail)'; m.textContent = e && e.missing ? 'Resolving is not installed yet.' : 'Not saved: ' + ((e && e.message) || e); }
        return false;
      });
    }
    paint();
    refresh();
    return { refresh: refresh, resolve: resolve, state: S };
  }

  root.MeterTools = {
    VERSION: VERSION,
    idKind: idKind, mpanOk: mpanOk, whenUk: whenUk, normPostcode: normPostcode, samePostcode: samePostcode,
    rankSuggestions: rankSuggestions, typeahead: typeahead,
    lookupOne: lookupOne, lookupWords: lookupWords, manualFromTe: manualFromTe, filledWords: filledWords, markFilled: markFilled,
    splitToBoxes: splitToBoxes, splitWords: splitWords, cleanSplit: cleanSplit,
    openMeterDialog: openMeterDialog, meterForm: meterForm, patchDiff: patchDiff, changedWords: changedWords,
    mountReview: mountReview, reviewKindWords: reviewKindWords,
    TYPE_LABEL: TYPE_LABEL,
    _test: { str: str, digits: digits, mpanOk: mpanOk, idKind: idKind, normPostcode: normPostcode, cleanSplit: cleanSplit,
             splitToBoxes: splitToBoxes, splitWords: splitWords, splitAddress: splitAddress, manualFromTe: manualFromTe,
             filledWords: filledWords, textScore: textScore, rankSuggestions: rankSuggestions, meterForm: meterForm,
             patchDiff: patchDiff, sameValue: sameValue, changedWords: changedWords, reviewKindWords: reviewKindWords,
             reviewHint: reviewHint, reviewActions: reviewActions, reviewCompare: reviewCompare, claudeWords: claudeWords,
             lookupWords: lookupWords, PATCH_KEYS: PATCH_KEYS },
  };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).MeterTools;
