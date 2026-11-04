/* ═══════════════════════════════════════════════════════════════════════════════════
   CES Flex — shared render core.  window.FlexCore

   THE ONE RULE: every number, unit and column heading that a customer can see must be
   produced HERE, and nowhere else. flex.html (the desk) and flexclient.html (the client
   portal) both render from this file, so a change Dan makes to a heading, a decimal
   place or a calculation lands on both portals at once. Before this existed the two
   pages carried parallel implementations and had silently drifted apart: gas WAP on the
   client's Seasons tab was 100x too small, Secured % was 0dp on one and 1dp on the
   other, volumes were fixed-4dp on one and trailing-zero-stripped on the other, and
   auto-achieved targets the desk showed green read as pending to the customer.

   WHAT STAYS OUT OF HERE. Anything a customer must not see or does not need:
   internal notes, broker cursors, the admin tab, editing, alert colouring, the
   Marex/TotalEnergies source toggle. The desk layers those on top of the shared cell
   via the `desk` hook on each column — the VALUE and the HEADING still come from here,
   so embellishment can never move a number.

   THE ONE DELIBERATE DIFFERENCE. Mkt Price. The desk prints whichever curve the
   Marex/TE toggle selects; the customer always sees their supplier's (TotalEnergies)
   price, falling back to Marex per missing month. So the heading and the formatting are
   shared, and only the value resolver is injected by each page as ctx.mktPrice.

   CACHING. .htaccess marks .js immutable for 30 days. There is an explicit
   FilesMatch override for this file — without it a change here would reach the desk and
   the client weeks apart, which is the exact failure this file exists to prevent.
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* ── UNITS & PRECISION ────────────────────────────────────────────────────────────
     The single source of truth for display rounding. Power volumes carry 4 dp because
     an MW rate is small and meaningful to 4 places; gas volumes are whole therms.     */

  function isPower(basket) { return !!(basket && basket.commodity === 'power'); }

  // Costs (secured_cost, mtm_cost) are stored in POUNDS. Power prices are £/MWh, so
  // £ ÷ MWh already lands in the right unit — but gas prices are p/th, and £ ÷ therms
  // lands in £/th, which reads 100x too small under a "p/th" heading. Anywhere a WAP or
  // a price is DERIVED from a cost rather than read from flex_positions.secured_wap
  // (which is already in the basket's own price unit), scale by this so the two agree.
  function costToPrice(basket) { return isPower(basket) ? 1 : 100; }

  // Gross calorific value of a therm. One number, used by both the price conversion and
  // the volume conversion below, so a p/kWh rate and a kWh volume can never be derived
  // from two different therms.
  var THERM_KWH = 29.3071;

  // Wholesale price to p/kWh: power £/MWh ÷ 10; gas p/therm ÷ 29.3071.
  function convPkwh(basket, mkt) {
    if (mkt == null) return null;
    return isPower(basket) ? mkt / 10 : mkt / THERM_KWH;
  }

  // An energy total in the basket's own unit — MWh for power (MW × 24 × days), therms for
  // gas (th/d × days) — converted to kWh. Takes the TOTAL, not the row, so every volume
  // on the table goes through one conversion and the kWh columns cannot disagree.
  function toKwh(basket, total) {
    if (total == null) return null;
    return isPower(basket) ? +total * 1000 : +total * THERM_KWH;
  }
  function energyKwh(basket, m)  { return toKwh(basket, m && m.baseload_vol_total); }
  function securedKwh(basket, m) { return toKwh(basket, m && m.secured_vol_total); }
  function openKwh(basket, m)    { return toKwh(basket, m && m.open_vol_total); }

  // Commodity-aware volume rounding. Power -> 4 dp, gas -> whole, half away from zero.
  function volDisp(n, power) {
    if (n == null || isNaN(n)) return null;
    if (power) return Math.round(n * 1e4) / 1e4;
    var r = (n < 0 ? -1 : 1) * Math.round(Math.abs(n));
    return r === 0 ? 0 : r;                       // normalise -0 to 0
  }

  // Text form of volDisp(). Fixed dp on purpose: 12.5 prints "12.5000" on a power
  // basket, so a column of MW rates aligns on the decimal point and two portals cannot
  // show the same position as "12.5" and "12.5000".
  function fmtVolC(n, power) {
    var v = volDisp(n, power);
    if (v == null) return '-';
    var dp = power ? 4 : 0;
    return v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  function fmtNum(n, dp) {
    if (n == null || isNaN(n)) return '-';
    return n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  // Up to 3 dp, trailing zeros stripped. Used for rule labels ("0.25 MW"), never for a
  // table column — a column needs fixed precision to align.
  function fmtVol(n) {
    if (n == null || isNaN(n)) return '-';
    return n.toFixed(3).replace(/\.?0+$/, '');
  }

  // Whole pounds. The desk has always shown costs unsigned-with-leading-minus rather
  // than the accounting "+£/−£" the client portal used, so that is what both now show.
  function fmtFull(n) {
    if (n == null || isNaN(n)) return '-';
    return (n < 0 ? '-' : '') + '£' + Math.abs(Math.round(n)).toLocaleString('en-GB');
  }

  // Mark-to-market sign, as a CSS suffix: .mtm-positive / .mtm-negative / .mtm-zero.
  // The DESK's convention is authoritative and it is deliberately inverted — a POSITIVE
  // mtm_cost is money the book is down, so it prints red, and a negative one prints
  // green. The client portal used to colour it the other way round with its own .pos /
  // .neg classes, which meant the same figure read as good news to the customer and bad
  // news to the trader. One convention, defined here.
  function signOf(n) { return n > 0 ? 'positive' : n < 0 ? 'negative' : 'zero'; }

  // A price typed by the desk (target tiers, upper alerts) echoes back exactly as typed
  // rather than forced to 2 dp. Deliberate: these are entered values, not computed ones,
  // and rounding them makes the desk's own input look wrong back at them.
  function fmtTyped(n) { return n == null ? '—' : String(n); }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── CALENDAR ─────────────────────────────────────────────────────────────────── */

  function monthKey(y, m) {
    var yy = y, mm = m;
    while (mm < 1) { mm += 12; yy--; }
    while (mm > 12) { mm -= 12; yy++; }
    return yy + '-' + String(mm).padStart(2, '0') + '-01';
  }
  function nowMonth()  { var d = new Date(); return monthKey(d.getFullYear(), d.getMonth() + 1); }
  function nextMonth() { var d = new Date(); return monthKey(d.getFullYear(), d.getMonth() + 2); }

  // Apr–Sep is summer S-YY; Oct–Mar is winter W-YY named for the year it starts in.
  // Must stay identical to the season CASE inside flex_client_positions_rows(), or a
  // delivered rate computed here and one read from the view pick different NECs.
  function seasonKey(mIso) {
    var d = new Date(mIso);
    if (isNaN(d)) return null;
    var y = d.getUTCFullYear(), mo = d.getUTCMonth();
    if (mo >= 3 && mo <= 8) return 'S-' + String(y).slice(2);
    return 'W-' + String(mo >= 9 ? y : y - 1).slice(2);
  }

  function fmtMonth(s) {
    if (!s) return '—';
    return new Date(String(s).slice(0, 10) + 'T00:00:00Z')
      .toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      .replace(' ', '-');
  }

  /* ── NON-ENERGY COSTS & DELIVERED RATE ────────────────────────────────────────────
     Both portals build the same season -> NEC map, so delivered rate is one formula.
     The desk reads flex_necs; the client reads flex_client_necs, which is the same
     table narrowed to the customer's own baskets. Rows are matched on basket NAME to
     match the desk's long-standing behaviour and the view's join.                     */

  function necMap(basket, necRows) {
    var map = {};
    (necRows || []).forEach(function (n) {
      if (n.nec == null || n.commodity !== basket.commodity) return;
      if (n.basket_name === basket.name) map[n.season] = n.nec;
    });
    return map;
  }

  // Delivered rate (p/kWh) = converted mark-to-market price + that season's NEC.
  // Blank without an MtM price or without an NEC — an incomplete number here would be
  // read as a real one. Mirrors the delivered_rate column in flex_client_positions.
  function deliveredRate(basket, m, nm) {
    var nec = (nm || {})[seasonKey(m.month)];
    var mtm = m.mtm_price;
    if (nec == null || !mtm) return null;
    return convPkwh(basket, mtm) + nec;
  }

  // The same rate against the month's own energy: p/kWh × kWh ÷ 100 = pounds. This ties
  // back to MtM Cost by construction — delivered rate is the MtM price converted plus the
  // season's NEC, so delivered cost is MtM cost plus that NEC over the same kWh. Blank
  // wherever the rate is blank, for the same reason: a cost missing its non-energy half
  // would be read as the whole thing.
  function deliveredCost(basket, m, nm) {
    var dr = deliveredRate(basket, m, nm), kwh = energyKwh(basket, m);
    if (dr == null || kwh == null) return null;
    return dr * kwh / 100;
  }

  /* ── TARGETS ──────────────────────────────────────────────────────────────────────
     A tier can be ticked by hand OR satisfied automatically once secured volume meets
     the tier's rule. The client portal could not see the rules at all until
     flex_client_baskets was widened to carry target_count/labels/kinds/rules, so a
     tier the desk showed green read as pending to the customer.                       */

  var RULE_TYPES = ['none', 'volume', 'percent', 'open', 'open_minus'];

  function tierCount(basket) {
    var n = basket && basket.target_count;
    if (n != null && n >= 1 && n <= 8) return n;
    return (basket && basket.commodity === 'gas') ? 8 : 5;
  }

  function targetRule(basket, i) {
    var r = (basket && basket.target_rules && basket.target_rules[i - 1]) || null;
    return {
      type:   (r && RULE_TYPES.indexOf(r.type) !== -1) ? r.type : 'none',
      amount: (r && r.amount != null && !isNaN(+r.amount)) ? +r.amount : null
    };
  }

  // The first column this month actually prices, or null for a month that prices none.
  // WHERE A MONTH'S LADDER STARTS. Both the achieved ticks below and the Targeted WAP
  // model in flex.html resolve blanks against this, so they cannot disagree about it.
  function firstPriced(t) {
    if (!t) return null;
    for (var k = 1; k <= 8; k++) if (t['lower_t' + k] != null) return k;
    return null;
  }
  function firstPricedTier(basket, monthKey) {
    return firstPriced(((basket && basket.targets) || []).find(function (x) {
      return x.month === monthKey;
    }) || null);
  }

  // Cumulative requirement for column `i` BEFORE the baseload cap.
  //
  // `t` is the target row for the month under test, and it decides where the ladder
  // starts. THE LADDER IS CUMULATIVE: "up to 80% of baseload" is a level the position
  // reaches by that column, not an increment bolted onto whatever sits priced below it.
  //
  // Two kinds of blank, and they mean different things (round 39):
  //
  //   LEADING  — the month prices nothing until column 3. Columns 1 and 2 were never
  //              asked of it. Baskets routinely stagger like this: the first two
  //              authorised for Oct-28 onwards, the next two advisory for the years
  //              before. Billing a month for rungs it was never given is how a 100 th/d
  //              ladder came to demand 300 th/d in the first column a month uses, so
  //              the sum starts at the first priced column.
  //   INTERIOR — the month prices 1, 2 and 4 but not 3. That is a rung inside a ladder
  //              the month is already climbing: the volume T3 would have bought is
  //              still intended, so it COUNTS and lands on T4. Until round 39 it was
  //              dropped, and CCCH's Nov-26 T4 asked 55% of baseload instead of 75%.
  //
  // Each column keeps its own rule. Omit `t` and the month-agnostic sum from column 1
  // is returned, which is what a caller asking "what would this column ask of a full
  // row" wants.
  function requiredRaw(basket, i, base, t) {
    if (targetRule(basket, i).type === 'none') return null;
    if (t && t['lower_t' + i] == null) return null;
    var from = t ? (firstPriced(t) || 1) : 1;
    var cum = 0;
    for (var n = from; n <= i; n++) {
      var r = targetRule(basket, n);
      if (r.type === 'none') continue;
      if (r.type === 'volume') {
        if (r.amount == null) return null;
        cum += r.amount;
      } else if (r.type === 'percent') {
        if (r.amount == null || base == null) return null;
        cum += base * r.amount / 100;
      } else if (r.type === 'open') {
        if (base == null) return null;
        cum = base;
      } else if (r.type === 'open_minus') {
        if (r.amount == null || base == null) return null;
        cum = Math.max(0, base - r.amount);
      }
    }
    return cum;
  }

  function requiredSecured(basket, m, i) {
    var base = (m && m.baseload_vol != null) ? m.baseload_vol : null;
    // No baseload to hedge means no meaningful test — better "not evaluable" than every
    // target ticking green on a month that carries no volume.
    if (base != null && !(base > 0)) return null;
    var t = ((basket && basket.targets) || []).find(function (x) {
      return x.month === (m && m.month);
    }) || null;
    var raw = requiredRaw(basket, i, base, t);
    if (raw == null) return null;
    // A month can never secure more than its own baseload, so a requirement above it is
    // unsatisfiable by construction: a 0.1 MW-per-tranche ladder asks 0.3 MW of a
    // 0.25 MW meter and that last rung sits pending forever. Capping means a full hedge
    // always finishes the ladder while earlier rungs keep their real thresholds.
    return (base != null) ? Math.min(raw, base) : raw;
  }

  // Compare at DISPLAY precision, so a tier cannot read "pending" beside a secured
  // figure that prints as exactly the required amount.
  function volMeets(basket, have, need) {
    if (have == null || need == null) return false;
    var power = isPower(basket);
    var h = volDisp(have, power), n = volDisp(need, power);
    if (h == null || n == null) return false;
    return h >= n - (power ? 1e-9 : 0);
  }

  function autoAchieved(basket, t, i) {
    if (!basket || !t) return null;
    var m = (basket.months || []).find(function (x) { return x.month === t.month; });
    if (!m) return null;
    var need = requiredSecured(basket, m, i);
    if (need == null) return null;
    return volMeets(basket, m.secured_vol, need);
  }

  function isAchieved(basket, t, i) {
    if (t && t['t' + i + '_achieved'] === 'Yes') return true;
    return autoAchieved(basket, t, i) === true;
  }

  // Every tier that actually carries a PRICE for this month is achieved. Blank columns
  // are skipped, so a basket using only T1 and T2 counts as complete on those two. A
  // month with no priced tier returns false — nothing was asked of it, so it is not done.
  function allTargetsHit(basket, monthStr) {
    var t = (basket.targets || []).find(function (x) { return x.month === monthStr; });
    if (!t) return false;
    var n = tierCount(basket), priced = 0;
    for (var i = 1; i <= n; i++) {
      if (t['lower_t' + i] == null) continue;
      priced++;
      if (!isAchieved(basket, t, i)) return false;
    }
    return priced > 0;
  }

  function targetKind(t, i) {
    return (t && t['t' + i + '_kind'] === 'advisory') ? 'advisory' : 'authorised';
  }

  function ruleLabel(basket, i) {
    var r = targetRule(basket, i), u = (basket && basket.unit_vol) || '';
    if (r.type === 'volume')     return r.amount != null ? fmtVol(r.amount) + ' ' + u : null;
    if (r.type === 'percent')    return r.amount != null ? fmtVol(r.amount) + '%' : null;
    if (r.type === 'open')       return 'All open';
    if (r.type === 'open_minus') return r.amount != null ? 'All but ' + fmtVol(r.amount) + ' ' + u : null;
    return null;
  }

  // Past and current months drop off: the current month prices day-ahead, so a target on
  // it can neither be hit nor missed in any useful sense.
  function visibleTargets(basket) {
    var cut = nowMonth();
    return (basket.targets || []).filter(function (t) { return t.month > cut; });
  }

  function nextTargetForMonth(basket, monthStr) {
    if (!basket.targets) return null;
    var t = basket.targets.find(function (x) { return x.month === monthStr; });
    if (!t) return null;
    var n = tierCount(basket);
    for (var i = 1; i <= n; i++) {
      var price = t['lower_t' + i];
      if (price != null && !isAchieved(basket, t, i)) return { price: price };
    }
    return allTargetsHit(basket, monthStr) ? { allHit: true } : null;
  }

  function upperAlertForMonth(basket, monthStr) {
    if (!basket.targets) return null;
    var t = basket.targets.find(function (x) { return x.month === monthStr; });
    return t && t.upper_alert != null ? t.upper_alert : null;
  }

  /* ── THE EIGHT STAT CARDS ─────────────────────────────────────────────────────────
     Weighted averages, never simple means: WAP by secured volume, MtM price and
     delivered rate by baseload volume. A simple mean across months of unequal size is
     wrong, and would quietly disagree with the per-month rows underneath it.

     Returns data, not markup, so each portal keeps its own card styling while the
     label, the figure and its decimal places are identical on both.                   */

  function stats(rows, basket, necRows) {
    rows = rows || [];
    var power = isPower(basket), unit = power ? 'MW' : 'th';
    var sum = function (f) { return rows.reduce(function (s, m) { return s + (f(m) || 0); }, 0); };

    var baseTot = sum(function (m) { return m.baseload_vol_total; });
    var secTot  = sum(function (m) { return m.secured_vol_total; });
    var baseRate = sum(function (m) { return m.baseload_vol; });
    var secRate  = sum(function (m) { return m.secured_vol; });
    var openRate = sum(function (m) { return m.open_vol; });
    var openTot  = sum(function (m) { return m.open_vol_total; });
    var mtmCost  = sum(function (m) { return m.mtm_cost; });
    var pct = baseTot > 0 ? secTot / baseTot : 0;

    // A month with a secured volume but no price carries no information about the
    // average paid, so it is excluded rather than dragging the mean toward zero.
    var wapRows = rows.filter(function (m) { return (m.secured_vol_total || 0) > 0 && m.secured_wap; });
    var wapW = wapRows.reduce(function (s, m) { return s + (m.secured_vol_total || 0); }, 0);
    var avgWap = wapW > 0
      ? wapRows.reduce(function (s, m) { return s + m.secured_wap * (m.secured_vol_total || 0); }, 0) / wapW
      : null;

    var mtmRows = rows.filter(function (m) { return (m.baseload_vol_total || 0) > 0 && m.mtm_price; });
    var mtmW = mtmRows.reduce(function (s, m) { return s + (m.baseload_vol_total || 0); }, 0);
    var avgMtm = mtmW > 0
      ? mtmRows.reduce(function (s, m) { return s + m.mtm_price * (m.baseload_vol_total || 0); }, 0) / mtmW
      : null;

    var nm = necMap(basket, necRows);
    var drSum = 0, drW = 0;
    rows.forEach(function (m) {
      var dr = deliveredRate(basket, m, nm), w = m.baseload_vol_total || 0;
      if (dr != null && w > 0) { drSum += dr * w; drW += w; }
    });
    var avgDr = drW > 0 ? drSum / drW : null;

    var pu = basket.unit_price;
    return {
      // raw figures, for anything that needs to compute rather than print
      raw: { avgWap: avgWap, avgMtm: avgMtm, pct: pct, avgDr: avgDr, mtmCost: mtmCost,
             baseTot: baseTot, secTot: secTot, openTot: openTot,
             baseRate: baseRate, secRate: secRate, openRate: openRate },
      cards: [
        { key: 'wap',   label: 'Avg WAP',            value: avgWap != null ? avgWap.toFixed(2) : '—', sub: pu + ' secured' },
        { key: 'mtmp',  label: 'Avg MtM Price',      value: avgMtm != null ? avgMtm.toFixed(2) : '—', sub: pu + ' mark-to-market' },
        { key: 'pct',   label: 'Secured',            value: (pct * 100).toFixed(2) + '%',            sub: 'Forward position' },
        { key: 'base',  label: 'Total Baseload',     value: power ? fmtNum(baseRate, 4) : fmtNum(baseTot, 0), sub: power ? 'MW total' : unit + ' total' },
        { key: 'sec',   label: 'Secured Vol',        value: power ? fmtNum(secRate, 4)  : fmtNum(secTot, 0),  sub: power ? 'MW total secured' : unit + ' hedged' },
        { key: 'open',  label: 'Open Vol',           value: power ? fmtNum(openRate, 4) : fmtNum(openTot, 0), sub: power ? 'MW open' : unit + ' open' },
        { key: 'dr',    label: 'Avg Delivered Rate', value: avgDr != null ? avgDr.toFixed(3) : '—',  sub: 'p/kWh incl. NECs' },
        { key: 'mtmc',  label: 'MtM Cost',           value: fmtFull(mtmCost), sub: 'Mark-to-market',
          sign: signOf(mtmCost) }
      ]
    };
  }

  /* ── POSITIONS ────────────────────────────────────────────────────────────────────
     One column list drives the desk table and the client table. `head` is the shared
     heading; `value` is the shared cell text; `total` is the shared totals-row cell.
     ctx carries only what a page must inject: ctx.mktPrice (the Marex/TE choice) and
     ctx.nec (the season -> NEC map, already built once per render).                   */

  function positionsTotals(rows, basket, nm) {
    var power = isPower(basket);
    var sum = function (f) { return rows.reduce(function (s, m) { return s + (f(m) || 0); }, 0); };
    var cost = sum(function (m) { return m.secured_cost; });
    var secEnergy  = sum(function (m) { return m.secured_vol_total; });
    var baseEnergy = sum(function (m) { return m.baseload_vol_total; });

    // Volume-weighted, matching the Avg Delivered Rate card directly above this table.
    // This row used to take a SIMPLE mean of the monthly rates, which disagreed with
    // that card on any basket whose months differ in size — two figures for one concept
    // on one screen. Weighting is the correct one and is now the only one.
    var drSum = 0, drW = 0;
    rows.forEach(function (m) {
      var dr = deliveredRate(basket, m, nm), w = m.baseload_vol_total || 0;
      if (dr != null && w > 0) { drSum += dr * w; drW += w; }
    });

    // MtM price is weighted the same way and over the same weight, so the two rate
    // columns in the totals row are answering the same question about the same book.
    // Months with no MtM price are left out of both halves rather than counted as zero.
    var mpSum = 0, mpW = 0;
    rows.forEach(function (m) {
      var w = m.baseload_vol_total || 0;
      if (m.mtm_price != null && w > 0) { mpSum += +m.mtm_price * w; mpW += w; }
    });

    return {
      base: sum(function (m) { return m.baseload_vol; }),
      sec:  sum(function (m) { return m.secured_vol; }),
      open: sum(function (m) { return m.open_vol; }),
      cost: cost,
      mtm:  sum(function (m) { return m.mtm_cost; }),
      // Derived from cost, so it needs the p/th scaling that secured_wap does not.
      wap:  secEnergy > 0 ? (cost / secEnergy) * costToPrice(basket) : 0,
      pct:  baseEnergy > 0 ? secEnergy / baseEnergy : 0,
      dr:   drW > 0 ? drSum / drW : null,
      mtmPx: mpW > 0 ? mpSum / mpW : null,
      kwh:  sum(function (m) { return energyKwh(basket, m); }),
      seckwh: sum(function (m) { return securedKwh(basket, m); }),
      openkwh: sum(function (m) { return openKwh(basket, m); }),
      // Open cost is residual_cost straight from the view — open volume at the market
      // price, already in pounds and already commodity-scaled.
      opencost: sum(function (m) { return m.residual_cost; }),
      dcost: rows.reduce(function (a, m) {
        var c = deliveredCost(basket, m, nm); return a + (c || 0);
      }, 0),
      power: power
    };
  }

  function POSITIONS(basket) {
    var power = isPower(basket);
    var vu = power ? 'MW' : 'th/d';
    var pu = basket.unit_price;
    var priceUnit = power ? '£/MWh' : 'p/th';

    return [
      { key: 'month',  head: 'Month',  align: 'left',
        value: function (m) { return fmtMonth(m.month); },
        total: function () { return '<strong>TOTAL</strong>'; } },

      { key: 'season', head: 'Season', align: 'left',
        value: function (m) { return esc(m.season || ''); },
        total: function () { return ''; } },

      { key: 'base',   head: 'Baseload (' + vu + ')', align: 'right',
        value: function (m) { return fmtVolC(m.baseload_vol, power); },
        total: function (t) { return fmtVolC(t.base, power); } },

      // The same volume as energy. Whole kWh on both portals — a fraction of a kilowatt
      // hour is noise on a monthly baseload and would only cost the column its alignment.
      { key: 'basekwh', head: 'Baseload (kWh)', align: 'right',
        value: function (m) { var k = energyKwh(basket, m); return k != null ? fmtNum(Math.round(k), 0) : '-'; },
        total: function (t) { return t.kwh != null ? fmtNum(Math.round(t.kwh), 0) : '-'; } },

      { key: 'sec',    head: 'Secured (' + vu + ')', align: 'right',
        value: function (m) { return fmtVolC(m.secured_vol, power); },
        total: function (t) { return fmtVolC(t.sec, power); } },

      // Secured as energy, beside its rate — the same pairing as Baseload above.
      { key: 'seckwh', head: 'Secured (kWh)', align: 'right',
        value: function (m) { var k = securedKwh(basket, m); return k != null ? fmtNum(Math.round(k), 0) : '-'; },
        total: function (t) { return t.seckwh != null ? fmtNum(Math.round(t.seckwh), 0) : '-'; } },

      { key: 'wap',    head: 'Weighted Average Price (' + pu + ')', align: 'right',
        value: function (m) { return m.secured_wap ? m.secured_wap.toFixed(2) : '-'; },
        total: function (t) { return t.wap > 0 ? t.wap.toFixed(2) : '-'; } },

      // Percent is a bar plus a whole-number label on both portals. 0 dp is deliberate:
      // a hedge book is managed in whole percent and a decimal implies false precision.
      { key: 'pct',    head: 'Secured %', align: 'left', bar: true,
        value: function (m) { return pctCell(m.secured_pct || 0); },
        total: function (t) { return pctCell(t.pct); } },

      { key: 'cost',   head: 'Secured Cost', align: 'right',
        value: function (m) { return fmtFull(m.secured_cost); },
        total: function (t) { return fmtFull(t.cost); } },

      { key: 'open',   head: 'Open (' + vu + ')', align: 'right',
        value: function (m) { return fmtVolC(m.open_vol, power); },
        total: function (t) { return fmtVolC(t.open, power); } },

      // Open as energy, beside its rate — the third of the same pairing.
      { key: 'openkwh', head: 'Open (kWh)', align: 'right',
        value: function (m) { var k = openKwh(basket, m); return k != null ? fmtNum(Math.round(k), 0) : '-'; },
        total: function (t) { return t.openkwh != null ? fmtNum(Math.round(t.openkwh), 0) : '-'; } },

      // The one injected value on the page: the desk prints whichever curve its toggle
      // selects, the client always prints the supplier's. Heading and dp are shared.
      { key: 'mkt',    head: 'Market Price (' + priceUnit + ')', align: 'right',
        value: function (m, ctx) {
          var v = ctx && ctx.mktPrice ? ctx.mktPrice(m) : m.market_price;
          return v ? (+v).toFixed(2) : '-';
        },
        total: function () { return ''; } },

      // What the open volume would cost at that market price — the view's residual_cost.
      // Sits beside the price that produced it, as MtM Cost sits beside MtM Price and
      // Delivered Cost beside Delivered Rate.
      { key: 'opencost', head: 'Open Cost', align: 'right',
        value: function (m) { return m.residual_cost != null ? fmtFull(m.residual_cost) : '-'; },
        total: function (t) { return fmtFull(t.opencost); } },

      // The blended price behind MtM Cost: secured volume at its WAP, open volume at the
      // Mkt price beside it. Sits between the two so the row reads price, price, cost.
      { key: 'mtmpx',  head: 'MtM Price (' + priceUnit + ')', align: 'right',
        value: function (m) { return m.mtm_price != null ? (+m.mtm_price).toFixed(2) : '-'; },
        total: function (t) { return t.mtmPx != null ? t.mtmPx.toFixed(2) : ''; } },

      { key: 'mtm',    head: 'MtM Cost', align: 'right',
        value: function (m) { return m.mtm_cost != null ? fmtFull(m.mtm_cost) : '-'; },
        total: function (t) { return fmtFull(t.mtm); },
        sign:  function (m) { return signOf(m.mtm_cost); },
        totalSign: function (t) { return signOf(t.mtm); } },

      // Delivered rate and the cost it produces, side by side and to the right of the
      // wholesale pair — so the table runs wholesale price, wholesale cost, delivered
      // rate, delivered cost, and each cost sits beside the rate that made it.
      { key: 'dr',     head: 'Delivered Rate (p/kWh)', align: 'right',
        value: function (m, ctx) {
          var dr = deliveredRate(basket, m, ctx && ctx.nec);
          return dr != null ? dr.toFixed(3) : '<span class="fx-dash">—</span>';
        },
        total: function (t) { return t.dr != null ? t.dr.toFixed(3) : ''; } },

      { key: 'dcost',  head: 'Delivered Cost', align: 'right',
        value: function (m, ctx) {
          var c = deliveredCost(basket, m, ctx && ctx.nec);
          return c != null ? fmtFull(c) : '<span class="fx-dash">—</span>';
        },
        total: function (t) { return t.dcost ? fmtFull(t.dcost) : ''; } },

      { key: 'nt',     head: 'Next Target', align: 'center',
        value: function (m) {
          var r = nextTargetForMonth(basket, m.month);
          if (!r) return '—';
          return r.allHit ? '<span class="fx-allhit">All hit &#10003;</span>' : fmtTyped(r.price);
        },
        total: function () { return ''; } },

      { key: 'ua',     head: 'Upper Alert', align: 'center',
        value: function (m) {
          var ua = upperAlertForMonth(basket, m.month);
          return ua != null ? fmtTyped(ua) : '—';
        },
        total: function () { return ''; } }
    ];
  }

  function pctCell(p) {
    return '<div class="pct-cell">'
         +   '<div class="pct-bar"><div class="pct-bar-fill" style="width:'
         +     Math.min(p * 100, 100).toFixed(1) + '%"></div></div>'
         +   '<div class="pct-label">' + (p * 100).toFixed(0) + '%</div>'
         + '</div>';
  }

  /* ── SEASONS ──────────────────────────────────────────────────────────────────────
     Grouped in month order, first appearance wins. Power shows the summed MW/th rate,
     not the energy total, so the figure ties back to the Positions table above it.    */

  function seasonGroups(rows, basket) {
    var order = [], map = {};
    (rows || []).slice()
      .sort(function (a, b) { return String(a.month) < String(b.month) ? -1 : 1; })
      .forEach(function (m) {
        var s = m.season || 'Unknown';
        if (!map[s]) { map[s] = { name: s, months: [] }; order.push(s); }
        map[s].months.push(m);
      });

    var power = isPower(basket);
    return order.map(function (sn) {
      var ms = map[sn].months;
      var sum = function (f) { return ms.reduce(function (s, m) { return s + (f(m) || 0); }, 0); };
      var baseTot = sum(function (m) { return m.baseload_vol_total; });
      var secTot  = sum(function (m) { return m.secured_vol_total; });
      var cost    = sum(function (m) { return m.secured_cost; });
      return {
        name: sn,
        count: ms.length,
        base: power ? sum(function (m) { return m.baseload_vol; }) : baseTot,
        sec:  power ? sum(function (m) { return m.secured_vol;  }) : secTot,
        // Derived from cost -> needs the gas scaling. Without it a gas season's WAP
        // printed as 0.62 under a "p/th" heading where the desk showed 62.00.
        wap:  secTot > 0 ? (cost / secTot) * costToPrice(basket) : 0,
        pct:  baseTot > 0 ? secTot / baseTot : 0,
        cost: cost,
        mtm:  sum(function (m) { return m.mtm_cost; })
      };
    });
  }

  function SEASONS(basket) {
    var power = isPower(basket);
    var vu = power ? 'MW' : 'th';
    var pu = basket.unit_price;
    return [
      { key: 'season', head: 'Season', align: 'left',
        value: function (g) { return '<strong>' + esc(g.name) + '</strong>'; } },
      { key: 'count',  head: 'Months', align: 'center',
        value: function (g) { return g.count; } },
      { key: 'base',   head: 'Baseload (' + vu + ')', align: 'right',
        value: function (g) { return fmtNum(g.base, power ? 4 : 0); } },
      { key: 'sec',    head: 'Secured (' + vu + ')', align: 'right',
        value: function (g) { return fmtNum(g.sec, power ? 4 : 0); } },
      { key: 'wap',    head: 'Weighted Average Price (' + pu + ')', align: 'right',
        value: function (g) { return g.wap > 0 ? g.wap.toFixed(2) : '-'; } },

      // The same WAP in p/kWh, through the same conversion the delivered rate uses, so a
      // season's wholesale rate can be read against a delivered rate without arithmetic.
      { key: 'wapkwh', head: 'Weighted Average Price (p/kWh)', align: 'right',
        value: function (g) {
          var v = g.wap > 0 ? convPkwh(basket, g.wap) : null;
          return v != null ? v.toFixed(3) : '-';
        } },
      { key: 'pct',    head: 'Secured %', align: 'left', bar: true,
        value: function (g) { return pctCell(g.pct); } },
      { key: 'cost',   head: 'Secured Cost', align: 'right',
        value: function (g) { return fmtFull(g.cost); } },
      { key: 'mtm',    head: 'MtM Cost', align: 'right',
        value: function (g) { return fmtFull(g.mtm); },
        sign:  function (g) { return signOf(g.mtm); } }
    ];
  }

  /* ── TARGETS ───────────────────────────────────────────────────────────────────────
     Tier columns come from tierCount(), not from scanning which tiers happen to carry a
     value — otherwise a basket configured for 8 tiers renders 3 columns this month and
     5 next, and the customer's table changes shape for no reason they can see.         */

  function TARGETS(basket) {
    var n = tierCount(basket);
    var labels = basket.target_labels || null;
    var cols = [
      { key: 'month', head: 'Month', align: 'left',
        value: function (t) { return fmtMonth(t.month); } },
      // Unit in the heading, matching POSITIONS above — the two tabs print the same figure
      // and used to label it differently, which is the drift this file exists to stop.
      { key: 'mkt',   head: 'Market Price (' + (isPower(basket) ? '£/MWh' : 'p/th') + ')', align: 'right',
        value: function (t, ctx) {
          var m = (basket.months || []).find(function (x) { return x.month === t.month; });
          var v = m && m.market_price != null ? m.market_price : null;
          if (ctx && ctx.mktPrice && m) { var o = ctx.mktPrice(m); if (o != null) v = o; }
          return v != null ? (+v).toFixed(2) : '-';
        } }
    ];
    for (var i = 1; i <= n; i++) {
      (function (idx) {
        cols.push({
          key: 't' + idx,
          head: (labels && labels[idx - 1]) ? String(labels[idx - 1]) : 'T' + idx,
          align: 'center',
          tier: idx,
          // Achieved, hit-but-not-yet-bought, or pending — all three states are shared,
          // so the customer's table says the same thing about a tier as the desk's.
          // The desk adds only the "auto" tag on top of this, and the rule chip in the
          // heading; both are internal and neither touches the number.
          value: function (t, ctx) {
            var price = t['lower_t' + idx];
            if (price == null) return '<span class="fx-dash">—</span>';
            if (isAchieved(basket, t, idx)) return fmtTyped(price) + ' &#10003;';
            var m = (basket.months || []).find(function (x) { return x.month === t.month; });
            var mp = m && m.market_price != null ? m.market_price : null;
            // The current month prices day-ahead, so a target on it is never "hit".
            var hit = (t.month !== nowMonth()) && mp != null && mp < price;
            if (hit) return fmtTyped(price);
            return '<span class="target-pending" title="Pending">&#9711;</span>'
                 + '<span class="target-price">' + fmtTyped(price) + '</span>';
          }
        });
      })(i);
    }
    cols.push({ key: 'ua', head: 'Upper Alert', align: 'right',
      value: function (t) { return t.upper_alert != null ? fmtTyped(t.upper_alert) : '-'; } });
    return cols;
  }

  /* ── TRADES ───────────────────────────────────────────────────────────────────────
     Both portals showed the same trades in a different column order, with the volume
     trailing-zero-stripped on one side, the strike thousand-separated on one side, and
     the cost rounded to whole pounds for the customer while the desk showed pence. A
     trade is a contractual fact — it has to read the same to both.

     normTrade() takes either shape: the desk's mapped row (date/ref/start/end) or the
     raw flex_client_trades row (trade_date/trade_ref/start_date/end_date).             */

  function normTrade(t) {
    var n = function (v) { return (v == null || v === '') ? null : +v; };
    return {
      date: t.date != null ? t.date : t.trade_date,
      ref: t.ref != null ? t.ref : t.trade_ref,
      counterparty: t.counterparty,
      start: t.start != null ? t.start : t.start_date,
      end: t.end != null ? t.end : t.end_date,
      volume: n(t.volume), product: t.product,
      strike: n(t.strike), deal_type: t.deal_type, cost: n(t.cost)
    };
  }

  function fmtDate(sv) {
    if (!sv) return '-';
    return new Date(String(sv).slice(0, 10) + 'T00:00:00Z')
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  }

  function TRADES(basket) {
    var power = isPower(basket);
    var vu = basket.unit_vol, pu = basket.unit_price;
    return [
      { key: 'date', head: 'Date', align: 'left', value: function (t) { return fmtDate(t.date); } },
      { key: 'ref',  head: 'Trade Ref', align: 'left', value: function (t) { return esc(t.ref || ''); } },
      { key: 'cp',   head: 'Counterparty', align: 'left', value: function (t) { return esc(t.counterparty || ''); } },
      { key: 'per',  head: 'Period', align: 'left',
        value: function (t) { return fmtMonth(t.start) + ' &rarr; ' + fmtMonth(t.end); } },
      { key: 'vol',  head: 'Vol (' + vu + ')', align: 'right',
        value: function (t) { return fmtVolC(t.volume, power); } },
      /* ROUND 47: the Product column is gone. Every trade on the book says
         "Baseload" — it was a field with one value, taking a column's width on two
         screens and two spreadsheets to tell nobody anything. flex_trades.product
         is NOT dropped: the data stays, normTrade still carries it, and the column
         can come back by restoring one line here if a shaped product is ever
         traded. Removing it here removes it from the desk table, the customer's
         table and both workbooks at once, which is the point of the shared spec. */
      { key: 'strike', head: 'Strike (' + pu + ')', align: 'right',
        value: function (t) { return t.strike != null ? t.strike.toFixed(2) : '-'; } },
      { key: 'type', head: 'Type', align: 'center', value: function (t) { return esc(t.deal_type || ''); } },
      // Pence, not whole pounds: a trade cost is a contracted figure and rounding it
      // meant the customer's number never quite tied back to the desk's.
      { key: 'cost', head: 'Cost (£)', align: 'right',
        value: function (t) { return '£' + (t.cost != null ? t.cost.toFixed(2) : '-'); } }
    ];
  }

  /* ── SITES ────────────────────────────────────────────────────────────────────────
     The last tab that was still built by hand on both portals, which is why the desk
     called the identifier column "MPAN/MPRN" on a gas basket and the customer's page
     called it "MPRN". One spec now, and the identifier is named for the commodity.

     Round 36 took the two NEC columns off and put the site address on. The NEC figures
     were the one thing here the desk saw and the customer did not, and they were not
     what anything calculates from — the delivered rate reads flex_necs, keyed by basket
     and season, not these per-site fields. So the spec is now identical for both
     portals, and nothing in it needs dropping for either of them.                      */

  function SITES(basket) {
    var power = isPower(basket);
    return [
      { key: 'mpxn',  head: power ? 'MPAN' : 'MPRN', align: 'left',
        value: function (s) { return esc(s.mpxn || '-'); } },
      { key: 'site',  head: 'Site', align: 'left',
        value: function (s) { return esc(s.customer || '-'); } },
      { key: 'addr',  head: 'Site Address', align: 'left', width: 52,
        value: function (s) { return esc(s.site_address || '-'); } },
      { key: 'start', head: 'Contract Start', align: 'left',
        value: function (s) { return fmtDate(s.contract_start); } },
      { key: 'end',   head: 'Contract End', align: 'left',
        value: function (s) { return fmtDate(s.contract_end); } }
    ];
  }

  /* ── SPREADSHEET ──────────────────────────────────────────────────────────────────
     Moved here from flexclient.html in round 30b, when the desk's export was retired in
     favour of it. The desk had its own hand-written column list, which had already
     drifted once — it was missing Delivered Rate for months after the tab gained it.

     The contract is the same one the tables keep: every cell in the file is the SAME
     FlexCore cell the table on screen renders, read back and written as a real number
     with a format showing the same decimals. So the file cannot show a figure the portal
     does not, and every figure is a number Excel can sum, sort and chart.

     Where it deliberately differs from the screen:
       · Every month, whatever the Positions filters are set to. Filters are shared across
         baskets, so honouring them could hand over a file that looks complete and is not.
       · Month and dates are real dates, so Excel sorts them by date, not A to Z.
       · What the two portals drop differs, and only that: see CLIENT_HIDE.sheet.       */

  /* WHAT THE CUSTOMER DOES NOT SEE — by surface, then table, then column key.
     Both the on-screen tables and the workbook read this one map.

     It is one map for a reason. Until 14 Oct the rule lived only in the workbook
     builder, as a flat list of keys, and both portals rendered their TABLES from the
     unfiltered specs — so the 17 Sep decision held for the file a customer downloaded
     and not for the page they were looking at, for two months, with nothing to notice
     it. A rule in one place cannot be half-applied.

     Two differences between screen and sheet are deliberate (Daniel, 14 Oct):
       targets.ua   the client's Targets TAB keeps Upper Alert. Their workbook has never
                    carried it and is left as it was.
       trades.cost  hidden on the client's Trades TAB. The workbook still carries it.
     Written side by side so it is clear they are intended rather than an oversight.

     nec / necsc stay under sites although SITES no longer emits them: an older cached
     portal can still hand those keys in, and a filter that stops recognising a column is
     how one quietly comes back on a customer's workbook. */
  var CLIENT_HIDE = {
    screen: {
      positions: { nt: 1, ua: 1 },      // Next Target, Upper Alert
      trades:    { cost: 1 }            // Cost (£)
    },
    sheet: {
      positions: { nt: 1, ua: 1 },
      targets:   { ua: 1 },
      sites:     { nec: 1, necsc: 1 }
    }
  };

  /* Filter a column spec for the customer. `where` is 'screen' or 'sheet', `table` the
     spec's own name. An unlisted table is returned untouched. */
  function clientCols(where, table, cols) {
    var h = (CLIENT_HIDE[where] || {})[table];
    if (!h) return cols;
    return (cols || []).filter(function (c) { return !h[c.key]; });
  }

  var XL_NAVY = 'FF1F2D4D', XL_CUR = 'FFFDF3CF', XL_TOT = 'FFEEF1F6', XL_HAIR = 'FFE0E3EC';
  var XL_BLANK = /^(?:|-|—|£-)$/;              // how the tables print "no value"

  // The months hold the figures as the screen rounds them, and TOTAL is the screen's
  // TOTAL, worked out before rounding. Said once in the file, so a SUM that lands a pound
  // or two away from TOTAL does not read as an error.
  var XL_ROUND_NOTE = 'Totals are calculated before rounding, so they can differ slightly '
                    + 'from a sum of the rounded figures above.';

  // The text a cell shows. A <template> parses its markup inert: nothing loads, nothing runs.
  function xlText(html) {
    var t = root.document.createElement('template');
    t.innerHTML = String(html == null ? '' : html);
    return t.content.textContent.replace(/\s+/g, ' ').trim();
  }

  // Displayed text back to the number it shows, with an Excel format of the same decimals.
  //   '12.5000' → 12.5 as #,##0.0000        '-£1,234' → -1234 as whole pounds
  //   '£-10.50' → -10.5 as pounds and pence  '63%'    → 0.63 as 0%
  // Anything that is not purely a number comes back null and is written as the text itself.
  function xlNum(text) {
    var m = /^([-−]?)(£?)([-−]?)(\d+(?:\.(\d+))?)(%?)$/.exec(String(text).replace(/[\s,]/g, ''));
    if (!m) return null;
    var dp = m[5] ? m[5].length : 0, d = dp ? '.' + new Array(dp + 1).join('0') : '';
    var v = parseFloat(m[4]) * ((m[1] || m[3]) ? -1 : 1);
    if (m[6]) v = v / 100;
    if (v === 0) v = 0;                                   // never write a -0
    var fmt = m[6] ? '0' + d + '%'
            : m[2] ? '"£"#,##0' + d + ';-"£"#,##0' + d
            : '#,##0' + d;
    return { v: v, fmt: fmt };
  }

  // 'YYYY-MM-DD' to an Excel date serial, from the calendar date alone. No local-time Date
  // is involved, so a client on BST cannot see a month shift back a day.
  function xlDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 864e5 : null;
  }

  // Lines a heading needs once wrapped at `w` characters, to size the heading row.
  function xlLines(text, w) {
    var lines = 1, len = 0, words = String(text).split(' ');
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (len && len + 1 + word.length > w) { lines++; len = word.length; }
      else len += (len ? 1 : 0) + word.length;
    }
    return lines;
  }
  // The narrowest column at which a heading wraps onto two lines at most, never one word
  // per line. 10 is the floor because ExcelJS leaves a width of exactly 9 (its default)
  // unwritten.
  function xlHeadWidth(h) {
    var longest = Math.max.apply(null, String(h).split(' ').map(function (w) { return w.length; }));
    for (var w = Math.max(10, longest + 2); w < 24; w++) if (xlLines(h, w - 1) <= 2) return w;
    return 24;
  }

  // Header and footer codes treat & as a control character.
  function xlHF(s) { return String(s == null ? '' : s).replace(/&/g, '&&'); }

  /* One sheet from a column spec: headings in row 1 exactly as the table prints them, a
     row per table row, then the table's TOTAL row. o.dates maps a column key to the row's
     ISO date and a date format; o.mark shades a row (the current month, as on screen). */
  function xlSheet(wb, name, cols, rows, ctx, o) {
    o = o || {};
    var ws = wb.addWorksheet(name, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    ws.pageSetup.printTitlesRow = '1:1';
    ws.headerFooter.oddHeader = '&L&B' + xlHF(o.title) + '&B&R' + xlHF(o.stamp);
    ws.headerFooter.oddFooter = '&LCES flex portal&RPage &P of &N';

    var heads = cols.map(function (c) { return xlText(c.head); });
    var width = heads.map(xlHeadWidth);
    // Numbers sit right as Excel expects, whatever the screen does (Secured % is a bar
    // there). Left-hand text is indented one step so it never runs into a number in the
    // column before.
    var LEFT = { horizontal: 'left', indent: 1 }, RIGHT = { horizontal: 'right' },
        MID = { horizontal: 'center' };
    var align = cols.map(function (c) {
      return c.align === 'right' ? RIGHT : c.align === 'center' ? MID : LEFT; });

    var hr = ws.addRow(heads);
    hr.eachCell(function (c) {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_NAVY } };
      c.font = { size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    var put = function (r, isTotal) {
      var row = ws.addRow([]);
      cols.forEach(function (c, i) {
        var cell = row.getCell(i + 1), dt = !isTotal && o.dates && o.dates[c.key];
        var shown = '';
        if (dt) {
          var v = xlDate(dt.get(r));
          if (v != null) { cell.value = v; cell.numFmt = dt.fmt; }
          shown = dt.fmt;                              // same length as the date it displays
        } else {
          shown = xlText(isTotal ? (c.total ? c.total(r, ctx) : '') : c.value(r, ctx));
          var n = (c.align === 'right' || c.bar) ? xlNum(shown) : null;
          if (n) { cell.value = n.v; cell.numFmt = n.fmt; }
          else if (!XL_BLANK.test(shown)) cell.value = shown;
        }
        width[i] = Math.max(width[i], Math.min(shown.length + 2, 40));
        cell.alignment = dt ? LEFT : typeof cell.value === 'number' ? RIGHT : align[i];
        cell.font = { size: 10, bold: !!isTotal };
        cell.border = isTotal ? { top: { style: 'thin', color: { argb: 'FF55679A' } } }
                              : { bottom: { style: 'hair', color: { argb: XL_HAIR } } };
        var fill = isTotal ? XL_TOT : (o.mark && o.mark(r) ? XL_CUR : null);
        if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      });
    };
    rows.forEach(function (r) { put(r, false); });

    if (!rows.length) {
      ws.addRow([o.empty]).getCell(1).font =
        { size: 10, italic: true, color: { argb: 'FF6B7280' } };
    } else {
      // Filter and sort on the rows only. TOTAL sits below a spacer row as well, because
      // Excel can stretch a filter over a row that touches the bottom of it, and a sort
      // would then carry TOTAL into the months.
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: cols.length } };
      if (o.totals) { ws.addRow([]).height = 6; put(o.totals, true); }
      if (o.note) {
        ws.addRow([]);
        var nr = ws.addRow([o.note]);
        ws.mergeCells(nr.number, 1, nr.number, cols.length);
        nr.getCell(1).font = { size: 9, italic: true, color: { argb: 'FF4B5563' } };
        nr.getCell(1).alignment = { wrapText: true, vertical: 'top' };
        var across = width.reduce(function (a, w) { return a + w; }, 0);
        nr.height = 13 * Math.max(1, Math.ceil(o.note.length / Math.max(30, across - 4))) + 4;
      }
    }
    width.forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
    hr.height = 13 * Math.max.apply(null, heads.map(function (h, i) {
      return xlLines(h, width[i] - 1); })) + 5;
    return ws;
  }

  /* The whole workbook: five sheets, in tab order, from one spec each. Both portals call
     this and nothing else, so a column added to a spec above reaches both files with no
     edit in either page. `o.desk` is the ONLY difference between the two workbooks.

     o = { XL, basket, trades, sites, necRows, ctx, name, stamp, note, desk }           */
  function xlWorkbook(o) {
    var bk = o.basket, desk = !!o.desk;
    var keep = function (table, cols) {
      return desk ? cols : clientCols('sheet', table, cols);
    };
    var months = (bk.months || []).slice();
    var nm = necMap(bk, o.necRows || []);
    var stamp = o.stamp || '';
    var ctx = o.ctx || {};
    var wb = new o.XL.Workbook();
    wb.creator = 'CES flex portal';
    wb.created = new Date();
    wb.title = o.name + ' - portfolio';

    xlSheet(wb, 'Positions', keep('positions', POSITIONS(bk)), months, ctx, {
      dates: { month: { get: function (m) { return m.month; }, fmt: 'mmm-yy' } },
      totals: positionsTotals(months, bk, nm),
      mark: function (m) { return m.month === nowMonth(); },
      note: (o.note ? o.note + ' ' : '') + XL_ROUND_NOTE,
      empty: 'No position data for this basket.',
      title: o.name + ' - positions', stamp: stamp });

    /* Through keep() like the rest, so adding a rule for it later is a one-line change
       to CLIENT_HIDE rather than a change here. CLIENT_HIDE.sheet has no `trades` entry,
       so today this drops nothing and both workbooks still carry trade Cost. */
    xlSheet(wb, 'Trades', keep('trades', TRADES(bk)), o.trades || [], {}, {
      dates: { date: { get: function (t) { return t.date; }, fmt: 'dd mmm yy' } },
      empty: 'No trades recorded for this basket.',
      title: o.name + ' - trades', stamp: stamp });

    xlSheet(wb, 'Seasons', SEASONS(bk), seasonGroups(months, bk), ctx, {
      empty: 'No seasons to summarise for this basket.',
      title: o.name + ' - seasons', stamp: stamp });

    // visibleTargets, so the file shows the tradable months the tab shows rather than
    // reintroducing the settled ones the tab deliberately drops.
    xlSheet(wb, 'Targets', keep('targets', TARGETS(bk)), visibleTargets(bk), ctx, {
      dates: { month: { get: function (t) { return t.month; }, fmt: 'mmm-yy' } },
      mark: function (t) { return t.month === nowMonth(); },
      empty: 'No targets set for this basket.',
      title: o.name + ' - targets', stamp: stamp });

    xlSheet(wb, 'Sites', keep('sites', SITES(bk)), o.sites || [], {}, {
      dates: { start: { get: function (s) { return s.contract_start; }, fmt: 'dd mmm yy' },
               end:   { get: function (s) { return s.contract_end;   }, fmt: 'dd mmm yy' } },
      empty: 'No sites recorded against this basket.',
      title: o.name + ' - sites', stamp: stamp });

    return wb;
  }

  /* ── TABS ─────────────────────────────────────────────────────────────────────────
     The shared tab list. `client:true` means the customer sees it too — so adding a tab
     here with client:true is all it takes for it to appear on both portals. Desk-only
     tabs (notes, admin, curves, the market-price source picker) stay client:false and
     are never rendered by flexclient.html.                                             */

  var TABS = [
    { key: 'positions', label: 'Positions', client: true  },
    { key: 'trades',    label: 'Trades',    client: true  },
    { key: 'seasons',   label: 'Seasons',   client: true  },
    { key: 'targets',   label: 'Targets',   client: true  },
    { key: 'graphs',    label: 'Graphs',    client: true  },
    { key: 'sites',     label: 'Sites',     client: true  },
    { key: 'notes',     label: 'Notes',     client: false },
    { key: 'admin',     label: 'Admin',     client: false }
  ];

  function clientTabs() { return TABS.filter(function (t) { return t.client; }); }

  // Styling hook for the Targets table on both portals. A basket can carry eight tiers
  // with custom names; on one line each they push the table far wider than the screen and
  // the reader scrolls sideways forever to reach Upper Alert. Both stylesheets wrap the
  // headings against this class. Named here so neither page can drift off it.
  var TARGETS_TABLE_CLASS = 'fx-targets-table';

  /* ── GENERIC TABLE BUILDER ────────────────────────────────────────────────────────
     Both portals call this so a column added to a spec above needs no edit anywhere
     else. `opts.rowClass`, `opts.cellClass` and `opts.cellHtml` are the desk's hooks
     for alert colouring and tooltips; the client passes none and gets the plain table. */

  var ALIGN = { left: '', right: 'td-right', center: 'td-center' };

  function buildTable(cols, rows, ctx, opts) {
    opts = opts || {};
    // scope="col" always: the client portal is the one a customer with a screen reader
    // will open, and it costs the desk nothing. opts.caption is likewise the client's —
    // it explains the units below the headings without changing them.
    /* data-k on the HEADING as well as the cell (round 47a). The cells have carried it
       since round 18 for exactly this reason — see the note below — but the headings
       did not, which left a stylesheet no way to name a column except by counting.
       flex.html hid the trades Cost column with `th:nth-child(9)`, and when round 47
       removed the Product column Cost became the eighth, the rule stopped matching,
       and a column the desk had deliberately hidden appeared. A selector that counts
       is a selector that breaks the next time a spec changes. */
    var head = cols.map(function (c) {
      return '<th scope="col" class="' + (ALIGN[c.align] || '')
           + '" data-k="' + esc(c.key) + '">' + c.head + '</th>';
    }).join('');

    var body = rows.map(function (r) {
      var tds = cols.map(function (c) {
        var cls = [ALIGN[c.align] || ''];
        if (c.sign) cls.push('mtm-' + c.sign(r));
        if (opts.cellClass) { var x = opts.cellClass(c, r, ctx); if (x) cls.push(x); }
        var html = (opts.cellHtml && opts.cellHtml(c, r, ctx));
        if (html == null) html = c.value(r, ctx);
        var attr = (opts.cellAttr && opts.cellAttr(c, r, ctx)) || '';
        // data-k is how a page finds a cell. The desk used to reach for tr.cells[8] and
        // tr.cells[2] by position, so inserting a column silently moved its Mkt tooltip
        // onto another column and made the wrong cell editable. Address cells by name.
        return '<td class="' + cls.join(' ').trim() + '" data-k="' + esc(c.key) + '"' + attr + '>' + html + '</td>';
      }).join('');
      var rc = opts.rowClass ? (opts.rowClass(r, ctx) || '') : '';
      var ra = opts.rowAttr  ? (opts.rowAttr(r, ctx)  || '') : '';
      return '<tr' + (rc ? ' class="' + rc + '"' : '') + ra + '>' + tds + '</tr>';
    }).join('');

    var foot = '';
    if (opts.totals) {
      foot = '<tr class="totals-row">' + cols.map(function (c) {
        var cls = [ALIGN[c.align] || ''];
        if (c.totalSign) cls.push('mtm-' + c.totalSign(opts.totals));
        var v = c.total ? c.total(opts.totals, ctx) : '';
        return '<td class="' + cls.join(' ').trim() + '">' + v + '</td>';
      }).join('') + '</tr>';
    }

    var cap = opts.caption ? '<caption>' + opts.caption + '</caption>' : '';
    // opts.tableClass is the styling hook both portals key off, so a layout rule for a
    // given table is written against the same selector on both rather than one page
    // using an id the other does not have.
    var tc = opts.tableClass ? ' class="' + opts.tableClass + '"' : '';
    return '<div class="table-wrap"><table' + tc + '>' + cap + '<thead><tr>' + head + '</tr></thead>'
         + '<tbody>' + body + foot + '</tbody></table></div>';
  }

  /* ── DAY AHEAD WORKBOOK (round 48) ────────────────────────────────────────────
     The eight-tab Day Ahead export, replacing the three-tab one both portals used
     up to round 47. It lives here rather than in either page because the desk and
     the client portal now download the SAME workbook, and two copies of 300 lines
     of spreadsheet geometry is two copies to keep in step.

     The design is not ours. Every colour, border weight, row height, merge, number
     format and banding rule was read out of a reference workbook a colleague built
     and is reproduced, not reinterpreted. The constants below are named after what
     they are in HIS file. Two things only are ours: the note wording (the portal is
     the source, not a spreadsheet exported from somewhere else), and the units line,
     which the portal can state rather than hedge.

     EVERY FIGURE IS A LIVE FORMULA **AND** A CACHED RESULT. The formula is what lets
     the book recalculate when somebody pastes extra days onto a Daily Data tab; the
     cached result is what lets the figures show in Preview, Google Sheets and the
     browser, none of which calculate a formula they were handed.

     The workbook is a SNAPSHOT. It is built from whatever the portal holds at the
     moment Export is pressed, and the charts are redrawn from that same data in the
     same breath, so a file always agrees with itself. It does not then track the
     portal: new prices appear in the next export, not in a file already downloaded. */

  var DA_BANNER = 'FF1F3864';   // banner fill, rows 1-2 of every sheet
  var DA_HEAD   = 'FF2F5597';   // table heading fill
  var DA_CARD   = 'FFD9E1F2';   // dashboard KPI cards, and the Monthly total row
  var DA_BAND   = 'FFF2F5FA';   // zebra banding on data rows
  var DA_NAVY   = 'FF1F3864';   // heading ink
  var DA_GREY   = 'FF595959';   // note ink
  var DA_BLUE   = 'FF0000FF';   // a source reading
  var DA_GREEN  = 'FF008000';   // a figure linked from another tab
  /* Banner and heading navy are the same on BOTH fuels in his book. Only the tab
     colour tells gas from power; tinting the headings per fuel looks deliberate and
     is wrong. */
  var DA_TAB = { Gas: 'FF2F5597', Power: 'FFC55A11', data: 'FFA6A6A6' };

  /* Border weights and colours, straight from his borders table. */
  var DA_B_HEAD  = { bottom: { style: 'medium', color: { argb: DA_NAVY } } };
  var DA_B_HAIR  = { bottom: { style: 'hair',   color: { argb: 'FFD9D9D9' } } };
  var DA_B_CARD  = { bottom: { style: 'thick',  color: { argb: DA_HEAD } } };
  var DA_B_TOTAL = { top:    { style: 'medium', color: { argb: DA_NAVY } },
                     bottom: { style: 'medium', color: { argb: DA_NAVY } } };

  /* Number formats, written with HIS backslash escaping. Excel renders #,##0.0\p and
     #,##0.0"p" identically, but writing them his way keeps the stored format codes
     byte-identical to his file. mm-dd-yy is Excel's BUILT-IN short date (numFmtId 14),
     which renders to the reader's own locale — dd/mm/yyyy on a UK machine. */
  var DA_NF_PRICE = '#,##0.00';
  var DA_NF_PCT   = '\\+0.0%;[Red]\\-0.0%;0.0%';
  var DA_NF_MON   = 'mmm-yy';
  var DA_NF_DAY   = 'mm-dd-yy';

  /* Chart geometry, recovered from the drawing anchors in his workbook and converted
     at 96dpi (9,525 EMU to the pixel, 75px to a width-10 column, 20px to a default
     15pt row):   line  B7  -> R26 + 62,280 EMU = 1206 x 397 px
                  bar   B29 -> I43 + 32,760 EMU =  574 x 283 px
     `scale` is how much bigger the bitmap is drawn than it is placed, so it stays
     sharp on a high-dpi screen. These are the single source of truth: the renderer
     draws at w*scale and the sheet places at w, so the two cannot drift apart. */
  var DA_CHART = { line: { w: 1206, h: 397 }, bar: { w: 574, h: 283 }, scale: 2 };

  var DA_MONN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var DA_COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* MIDNIGHT UTC, built from an explicit Z string so there is no local-timezone slip.
     It has to be midnight rather than midday for two reasons, both of which produce
     wrong numbers in silence:
       - the Month helper on Daily Data is =DATE(YEAR(..),MONTH(..),1), which Excel
         returns at midnight. AVERAGEIFS matches it against the Month column on the
         Monthly tab, so a midday month there matches NOTHING and every average comes
         back #DIV/0!.
       - the Annual Summary bounds a year with <=DATE(y,12,31). A midday 31 December
         is greater than a midnight one, so every 31 December drops out of its own
         year.
     The old three-tab export used midday for the opposite reason — it wrote dates for
     display only, and a local midnight under BST landed at 23:00 the day before. That
     file had no formulas to match against; this one does. */
  function daDate(iso) { return new Date(iso + 'T00:00:00Z'); }
  function daHuman(iso) {
    return (+iso.slice(8, 10)) + ' ' + DA_MONN[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4);
  }
  function daShort(iso) { return DA_MONN[+iso.slice(5, 7) - 1] + '-' + iso.slice(2, 4); }
  function daMean(a) {
    var s = 0, i;
    for (i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : null;
  }
  function daMin(a) { return Math.min.apply(null, a); }
  function daMax(a) { return Math.max.apply(null, a); }
  function daR6(v) { return v == null ? null : Math.round(v * 1e6) / 1e6; }

  /* Whether the record stops mid-month. The two fuels do not end on the same day —
     power normally runs a day ahead of gas — so a note that simply declares the last
     month partial is wrong for one of them about half the time. */
  function daPartialEnd(iso) {
    var d = daDate(iso),
        eom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return d.getUTCDate() !== eom.getUTCDate();
  }

  function daMonths(rows) {
    var by = {}, keys = [], i, mk, out = [], v;
    for (i = 0; i < rows.length; i++) {
      mk = rows[i].d.slice(0, 7);
      if (!by[mk]) { by[mk] = []; keys.push(mk); }
      by[mk].push(rows[i].p);
    }
    keys.sort();
    for (i = 0; i < keys.length; i++) {
      v = by[keys[i]];
      out.push({ mk: keys[i], first: keys[i] + '-01', n: v.length,
                 avg: daMean(v), min: daMin(v), max: daMax(v) });
    }
    return out;
  }
  function daYears(rows) {
    var by = {}, keys = [], i, y, out = [], v;
    for (i = 0; i < rows.length; i++) {
      y = rows[i].d.slice(0, 4);
      if (!by[y]) { by[y] = []; keys.push(y); }
      by[y].push(rows[i].p);
    }
    keys.sort();
    for (i = 0; i < keys.length; i++) {
      v = by[keys[i]];
      out.push({ y: keys[i], n: v.length, avg: daMean(v), min: daMin(v), max: daMax(v) });
    }
    return out;
  }

  function daFont(o) {
    /* No colour unless one is asked for: these cells use Excel's automatic ink, as his
       do. Handing them an explicit near-black instead reads flatter even where the
       layout matches. */
    var f = { name: 'Arial', size: 10 }, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) f[k] = o[k];
    return f;
  }
  function daFill(c) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: c } }; }

  /* Two merged bars of navy across the table width: 16pt white title on a 30pt row,
     9pt white italic subtitle on an 18pt row, both vertically centred. Excel paints a
     merged range from its top-left cell, so the fill goes on the master only. */
  function daBanner(ws, lastCol, title, sub) {
    var L = DA_COLS.charAt(lastCol - 1);
    ws.getCell('B1').value = title;
    ws.getCell('B1').font = daFont({ bold: true, size: 16, color: { argb: 'FFFFFFFF' } });
    ws.getCell('B1').fill = daFill(DA_BANNER);
    ws.getCell('B1').alignment = { vertical: 'middle' };
    ws.mergeCells('B1:' + L + '1');
    ws.getRow(1).height = 30;

    ws.getCell('B2').value = sub;
    ws.getCell('B2').font = daFont({ size: 9, italic: true, color: { argb: 'FFFFFFFF' } });
    ws.getCell('B2').fill = daFill(DA_BANNER);
    ws.getCell('B2').alignment = { vertical: 'middle' };
    ws.mergeCells('B2:' + L + '2');
    ws.getRow(2).height = 18;

    ws.views = [{ showGridLines: false }];
    ws.getColumn(1).width = 2;
  }

  /* Navy fill, white bold, wrapped and centred on a 30pt row, closed with a medium
     rule underneath. */
  function daHeadRow(ws, rowNo, labels) {
    var r = ws.getRow(rowNo), i, c;
    for (i = 0; i < labels.length; i++) {
      c = r.getCell(2 + i);
      c.value = labels[i];
      c.font = daFont({ bold: true, color: { argb: 'FFFFFFFF' } });
      c.fill = daFill(DA_HEAD);
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = DA_B_HEAD;
    }
    r.height = 30;
  }

  /* One data row dressed his way: centred, hair rule beneath, banded on every second
     row counting from the first of the block. `bold` names the emphasised column —
     the Average, on every tab that has one. */
  function daDress(row, c0, c1, banded, bold, ink) {
    var c, cell, o;
    for (c = c0; c <= c1; c++) {
      cell = row.getCell(c);
      o = {};
      if (c === bold) o.bold = true;
      if (ink) o.color = { argb: ink };
      cell.font = daFont(o);
      cell.alignment = { horizontal: 'center' };
      cell.border = DA_B_HAIR;
      if (banded) cell.fill = daFill(DA_BAND);
    }
  }

  /* His book uses TWO note styles and the difference is deliberate, so it is carried
     rather than tidied into one: on a dashboard the block is furniture beside the
     charts — 10pt bold navy label over upright grey text; on a table tab it is a
     footnote under the grid — 9pt bold grey label over italic grey text. */
  function daNotes(ws, cell, lines, variant) {
    var col = cell.charAt(0), r0 = +cell.slice(1), dash = variant === 'dashboard', i, c;
    ws.getCell(col + r0).value = 'Notes';
    ws.getCell(col + r0).font = dash
      ? daFont({ bold: true, size: 10, color: { argb: DA_NAVY } })
      : daFont({ bold: true, size: 9,  color: { argb: DA_GREY } });
    for (i = 0; i < lines.length; i++) {
      c = ws.getCell(col + (r0 + 1 + i));
      c.value = '• ' + lines[i];
      c.font = dash ? daFont({ size: 9, color: { argb: DA_GREY } })
                    : daFont({ size: 9, italic: true, color: { argb: DA_GREY } });
    }
  }

  function daFooter(ws) {
    ws.headerFooter = { oddFooter: '&LCES — Commercial Energy Solutions&RPage &P of &N' };
  }

  function daDailySheet(wb, fuel) {
    var ws = wb.addWorksheet(fuel.name + ' Daily Data',
          { properties: { tabColor: { argb: DA_TAB.data } } }),
        i, n, row;
    daBanner(ws, 4, fuel.name + ' Day-Ahead Cash-Out Price — Daily',
      'Source: CES Flex Portal, Day Ahead tab · ' + fuel.unit);
    daHeadRow(ws, 4, ['Date', 'DA Cash-Out\n(' + fuel.unit + ')', 'Month']);
    for (i = 0; i < fuel.rows.length; i++) {
      n = 5 + i; row = ws.getRow(n);
      row.getCell(2).value = daDate(fuel.rows[i].d);
      row.getCell(3).value = fuel.rows[i].p;
      row.getCell(4).value = { formula: 'DATE(YEAR(B' + n + '),MONTH(B' + n + '),1)',
                               result: daDate(fuel.rows[i].d.slice(0, 7) + '-01') };
      daDress(row, 2, 4, i % 2 === 1, null);
      row.getCell(2).numFmt = DA_NF_DAY;
      row.getCell(3).numFmt = DA_NF_PRICE;
      row.getCell(4).numFmt = DA_NF_MON;
      // Blue ink marks a source reading, the convention his book uses.
      row.getCell(3).font = daFont({ color: { argb: DA_BLUE } });
    }
    ws.getColumn(2).width = 14; ws.getColumn(3).width = 16; ws.getColumn(4).width = 12;
    ws.views = [{ showGridLines: false, state: 'frozen', xSplit: 1, ySplit: 4,
                  topLeftCell: 'B5' }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1,
                     fitToHeight: 0, printTitlesRow: '4:4' };
    daFooter(ws);
    return ws;
  }

  function daMonthlySheet(wb, fuel, dailyName, lastDataRow) {
    var ws = wb.addWorksheet(fuel.name + ' Monthly Averages',
          { properties: { tabColor: { argb: DA_TAB[fuel.name] } } }),
        d0 = fuel.rows[0].d, d1 = fuel.rows[fuel.rows.length - 1].d,
        U = '\n(' + fuel.unit + ')',
        D = "'" + dailyName + "'!",
        C = D + '$C$5:$C$' + lastDataRow,
        M = D + '$D$5:$D$' + lastDataRow,
        ms = fuel.months, i, n, row, tot, tr, all = [], c;

    daBanner(ws, 9, fuel.name + ' Day-Ahead Cash-Out Price — Monthly Averages',
      'All figures ' + fuel.unit + ' · ' + daHuman(d0) + ' to ' + daHuman(d1)
      + ' · calculated live from the ' + dailyName + ' tab');
    daHeadRow(ws, 4, ['Month', 'Average' + U, 'Min' + U, 'Max' + U, 'Range' + U,
                      'Days in\nData', 'MoM\nChange', 'YoY\nChange']);

    for (i = 0; i < ms.length; i++) {
      n = 5 + i; row = ws.getRow(n);
      row.getCell(2).value = daDate(ms[i].first);
      row.getCell(3).value = { formula: 'AVERAGEIFS(' + C + ',' + M + ',$B' + n + ')',
                               result: daR6(ms[i].avg) };
      /* _xlfn. prefix: MINIFS and MAXIFS are post-2007 and Excel stores them prefixed.
         Written bare they come back #NAME?. */
      row.getCell(4).value = { formula: '_xlfn.MINIFS(' + C + ',' + M + ',$B' + n + ')',
                               result: daR6(ms[i].min) };
      row.getCell(5).value = { formula: '_xlfn.MAXIFS(' + C + ',' + M + ',$B' + n + ')',
                               result: daR6(ms[i].max) };
      row.getCell(6).value = { formula: 'E' + n + '-D' + n,
                               result: daR6(ms[i].max - ms[i].min) };
      row.getCell(7).value = { formula: 'COUNTIFS(' + M + ',$B' + n + ')', result: ms[i].n };
      if (i > 0)
        row.getCell(8).value = { formula: 'C' + n + '/C' + (n - 1) + '-1',
                                 result: daR6(ms[i].avg / ms[i - 1].avg - 1) };
      if (i >= 12)
        row.getCell(9).value = { formula: 'C' + n + '/C' + (n - 12) + '-1',
                                 result: daR6(ms[i].avg / ms[i - 12].avg - 1) };
      daDress(row, 2, 9, i % 2 === 1, 3);
      row.getCell(2).numFmt = DA_NF_MON;
      for (c = 3; c <= 6; c++) row.getCell(c).numFmt = DA_NF_PRICE;
      row.getCell(7).numFmt = '0';
      row.getCell(8).numFmt = DA_NF_PCT;
      row.getCell(9).numFmt = DA_NF_PCT;
    }

    /* The full-period row: card fill, bold, ruled above and below in medium — the one
       row on the tab that is a total rather than a month. */
    tot = 5 + ms.length; tr = ws.getRow(tot);
    for (i = 0; i < fuel.rows.length; i++) all.push(fuel.rows[i].p);
    tr.getCell(2).value = 'Full period';
    tr.getCell(3).value = { formula: 'AVERAGE(' + C + ')', result: daR6(daMean(all)) };
    tr.getCell(4).value = { formula: 'MIN(' + C + ')',     result: daR6(daMin(all)) };
    tr.getCell(5).value = { formula: 'MAX(' + C + ')',     result: daR6(daMax(all)) };
    tr.getCell(6).value = { formula: 'E' + tot + '-D' + tot,
                            result: daR6(daMax(all) - daMin(all)) };
    tr.getCell(7).value = { formula: 'COUNT(' + C + ')', result: all.length };
    for (c = 2; c <= 9; c++) {
      tr.getCell(c).font = daFont({ bold: true });
      tr.getCell(c).alignment = { horizontal: 'center' };
      tr.getCell(c).fill = daFill(DA_CARD);
      tr.getCell(c).border = DA_B_TOTAL;
    }
    for (c = 3; c <= 6; c++) tr.getCell(c).numFmt = DA_NF_PRICE;

    ws.addConditionalFormatting({ ref: 'C5:C' + (tot - 1), rules: [{
      type: 'colorScale', priority: 1,
      cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
      color: [{ argb: 'FF63BE7B' }, { argb: 'FFFFEB84' }, { argb: 'FFF8696B' }] }] });

    daNotes(ws, 'B' + (tot + 2), [
      daShort(d0) + ' covers ' + daHuman(d0).replace(/ \d{4}$/, '') + ' onward only; '
        + daShort(d1) + ' runs to ' + daHuman(d1)
        + (daPartialEnd(d1) ? '. Partial months are not full-month averages.'
                            : ', a complete month. The opening month is not a full-month average.'),
      'Average is the simple arithmetic mean of daily day-ahead cash-out prices in the '
        + 'month (all calendar days present in the portal).',
      'Colour scale on Average: green = lowest, red = highest. Blue figures on Daily '
        + 'Data are source readings.'
    ]);

    ws.getColumn(2).width = 13; ws.getColumn(3).width = 13;
    for (c = 4; c <= 6; c++) ws.getColumn(c).width = 12;
    ws.getColumn(7).width = 10; ws.getColumn(8).width = 11; ws.getColumn(9).width = 11;
    ws.views = [{ showGridLines: false, state: 'frozen', xSplit: 2, ySplit: 4,
                  topLeftCell: 'C5' }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1,
                     fitToHeight: 0, printTitlesRow: '4:4' };
    daFooter(ws);
    return ws;
  }

  function daAnnualSheet(wb, fuel, dailyName, lastDataRow, monthlyName) {
    var ws = wb.addWorksheet(fuel.name + ' Annual Summary',
          { properties: { tabColor: { argb: DA_TAB[fuel.name] } } }),
        d0 = fuel.rows[0].d, d1 = fuel.rows[fuel.rows.length - 1].d,
        U = '\n(' + fuel.unit + ')',
        D = "'" + dailyName + "'!",
        C = D + '$C$5:$C$' + lastDataRow,
        B = D + '$B$5:$B$' + lastDataRow,
        ys = fuel.years, i, n, row, w, c, open, cap, openMonths = [], src, L, end;

    daBanner(ws, 7, fuel.name + ' Day-Ahead Cash-Out Price — Annual Summary',
      fuel.unit + ' · calendar-year figures from Daily Data (' + d0.slice(0, 4)
      + ' from ' + daHuman(d0).replace(/ \d{4}$/, '') + '; latest year to date)');
    daHeadRow(ws, 4, ['Year', 'Average' + U, 'Min' + U, 'Max' + U, 'Days in\nData',
                      'YoY\nChange']);

    for (i = 0; i < ys.length; i++) {
      n = 5 + i; row = ws.getRow(n);
      w = ',' + B + ',">="&DATE(' + ys[i].y + ',1,1),' + B + ',"<="&DATE(' + ys[i].y + ',12,31))';
      row.getCell(2).value = ys[i].y;
      row.getCell(3).value = { formula: 'AVERAGEIFS(' + C + w,    result: daR6(ys[i].avg) };
      row.getCell(4).value = { formula: '_xlfn.MINIFS(' + C + w,  result: daR6(ys[i].min) };
      row.getCell(5).value = { formula: '_xlfn.MAXIFS(' + C + w,  result: daR6(ys[i].max) };
      row.getCell(6).value = { formula: 'COUNTIFS(' + B + ',">="&DATE(' + ys[i].y + ',1,1),'
                                        + B + ',"<="&DATE(' + ys[i].y + ',12,31))',
                               result: ys[i].n };
      if (i > 0)
        row.getCell(7).value = { formula: 'C' + n + '/C' + (n - 1) + '-1',
                                 result: daR6(ys[i].avg / ys[i - 1].avg - 1) };
      daDress(row, 2, 7, i % 2 === 1, 3);
      for (c = 3; c <= 5; c++) row.getCell(c).numFmt = DA_NF_PRICE;
      row.getCell(7).numFmt = DA_NF_PCT;
    }

    /* The opening part-year, month by month. It is the one annual row that cannot be
       read at face value, so his book spells its months out underneath, linked from
       the Monthly tab in green rather than recomputed. Two clear rows, a ruled
       caption, then its own heading. */
    open = ys[0].y; cap = 4 + ys.length + 3;
    for (c = 2; c <= 7; c++) ws.getRow(cap).getCell(c).border = DA_B_HEAD;
    ws.getCell('B' + cap).value = open + ' Monthly Averages — ' + fuel.name;
    ws.getCell('B' + cap).font = daFont({ bold: true, size: 12, color: { argb: DA_NAVY } });
    ws.mergeCells('B' + cap + ':G' + cap);
    ws.getRow(cap).height = 15.75;
    daHeadRow(ws, cap + 1, ['Month', 'Average' + U, 'Min' + U, 'Max' + U, 'Days in\nData']);

    for (i = 0; i < fuel.months.length; i++)
      if (fuel.months[i].mk.slice(0, 4) === open) openMonths.push(i);
    L = "'" + monthlyName + "'!";
    for (i = 0; i < openMonths.length; i++) {
      n = cap + 2 + i; src = 5 + openMonths[i]; row = ws.getRow(n);
      row.getCell(2).value = { formula: L + 'B' + src,
                               result: daDate(fuel.months[openMonths[i]].first) };
      row.getCell(3).value = { formula: L + 'C' + src,
                               result: daR6(fuel.months[openMonths[i]].avg) };
      row.getCell(4).value = { formula: L + 'D' + src,
                               result: daR6(fuel.months[openMonths[i]].min) };
      row.getCell(5).value = { formula: L + 'E' + src,
                               result: daR6(fuel.months[openMonths[i]].max) };
      row.getCell(6).value = { formula: L + 'G' + src, result: fuel.months[openMonths[i]].n };
      daDress(row, 2, 6, i % 2 === 1, 3, DA_GREEN);
      row.getCell(2).numFmt = DA_NF_MON;
      for (c = 3; c <= 5; c++) row.getCell(c).numFmt = DA_NF_PRICE;
      row.getCell(6).numFmt = '0';
    }

    /* His closing line here is a single italic note, not a bulleted block. */
    end = cap + 2 + openMonths.length + 1;
    ws.getCell('B' + end).value = daShort(d0) + ' = from '
      + daHuman(d0).replace(/ \d{4}$/, '') + ' only; no earlier ' + open
      + ' data on the portal. Green = linked from the ' + monthlyName + ' tab.';
    ws.getCell('B' + end).font = daFont({ size: 9, italic: true, color: { argb: DA_GREY } });

    ws.getColumn(2).width = 10; ws.getColumn(3).width = 13;
    for (c = 4; c <= 5; c++) ws.getColumn(c).width = 12;
    ws.getColumn(6).width = 10; ws.getColumn(7).width = 11;
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1,
                     fitToHeight: 0 };
    daFooter(ws);
    return ws;
  }

  function daDashboardSheet(wb, fuel, monthlyName, lastMonthRow, totRow, images) {
    var ws = wb.addWorksheet(fuel.name + ' Dashboard',
          { properties: { tabColor: { argb: DA_TAB[fuel.name] } } }),
        d0 = fuel.rows[0].d, d1 = fuel.rows[fuel.rows.length - 1].d,
        L = "'" + monthlyName + "'!", ms = fuel.months, last = ms[ms.length - 1],
        peak = ms[0], low = ms[0], tail = ms.slice(-12), R = lastMonthRow,
        NFK = fuel.unit === 'p/therm' ? '#,##0.0\\p' : '\\£#,##0.0',
        all = [], tailAvg = [], kpis, i, col, a, b, h, v;

    for (i = 0; i < ms.length; i++) {
      if (ms[i].avg > peak.avg) peak = ms[i];
      if (ms[i].avg < low.avg)  low  = ms[i];
    }
    for (i = 0; i < fuel.rows.length; i++) all.push(fuel.rows[i].p);
    for (i = 0; i < tail.length; i++) tailAvg.push(tail[i].avg);

    daBanner(ws, 17, fuel.name + ' Day-Ahead Cash-Out Price — Dashboard',
      'Monthly averages, ' + fuel.unit + ' · ' + daShort(d0) + ' – '
      + daShort(d1) + ' · Prepared by CES');
    /* Sixteen narrow columns of equal width, so the eight KPI cards each span a pair
       and the charts measure out against a predictable grid. */
    for (i = 2; i <= 17; i++) ws.getColumn(i).width = 10;

    kpis = [
      ['Latest month avg', { formula: L + 'C' + R, result: daR6(last.avg) }, NFK],
      ['Latest month',     { formula: L + 'B' + R, result: daDate(last.first) }, DA_NF_MON],
      ['Peak month avg',   { formula: 'MAX(' + L + 'C5:C' + R + ')', result: daR6(peak.avg) }, NFK],
      ['Peak month',       { formula: 'INDEX(' + L + 'B5:B' + R + ',MATCH(MAX(' + L + 'C5:C'
                                        + R + '),' + L + 'C5:C' + R + ',0))',
                             result: daDate(peak.first) }, DA_NF_MON],
      ['Lowest month avg', { formula: 'MIN(' + L + 'C5:C' + R + ')', result: daR6(low.avg) }, NFK],
      ['Lowest month',     { formula: 'INDEX(' + L + 'B5:B' + R + ',MATCH(MIN(' + L + 'C5:C'
                                        + R + '),' + L + 'C5:C' + R + ',0))',
                             result: daDate(low.first) }, DA_NF_MON],
      ['Full-period avg',  { formula: L + 'C' + totRow, result: daR6(daMean(all)) }, NFK],
      ['Latest 12m avg',   { formula: 'AVERAGE(' + L + 'C' + (R - 11) + ':C' + R + ')',
                             result: daR6(daMean(tailAvg)) }, NFK]
    ];
    for (i = 0; i < kpis.length; i++) {
      col = 2 + i * 2; a = DA_COLS.charAt(col - 1); b = DA_COLS.charAt(col);
      h = ws.getRow(4).getCell(col);
      h.value = kpis[i][0];
      h.font = daFont({ bold: true, size: 8, color: { argb: DA_GREY } });
      h.fill = daFill(DA_CARD);
      h.alignment = { horizontal: 'center' };
      ws.mergeCells(a + '4:' + b + '4');

      v = ws.getRow(5).getCell(col);
      v.value = kpis[i][1]; v.numFmt = kpis[i][2];
      v.font = daFont({ bold: true, size: 15, color: { argb: DA_NAVY } });
      v.fill = daFill(DA_CARD);
      v.alignment = { horizontal: 'center', vertical: 'middle' };
      /* The thick underline is drawn per cell, not per merge, so BOTH halves of the
         card need it or the rule stops halfway across. */
      ws.getRow(5).getCell(col).border = DA_B_CARD;
      ws.getRow(5).getCell(col + 1).border = DA_B_CARD;
      ws.mergeCells(a + '5:' + b + '5');
    }
    ws.getRow(4).height = 18;
    ws.getRow(5).height = 30;

    /* THE CHARTS. Pictures, because ExcelJS cannot write a native Excel chart — there
       is no addChart in the library at all. They are redrawn from the current figures
       at every export, so a file always matches the tabs beside it; what they will not
       do is redraw if somebody edits a cell afterwards. */
    daAddImage(wb, ws, images.line, 7,  DA_CHART.line.w, DA_CHART.line.h);
    daAddImage(wb, ws, images.bar, 29,  DA_CHART.bar.w,  DA_CHART.bar.h);

    /* Notes sit to the RIGHT of the bar chart. His are in column J; these start two
       columns further over, at L, and the reason is a difference between his charts
       and these.

       HIS bar chart is a native Excel chart on a twoCellAnchor: it is pinned to end at
       column I plus a fixed offset, so it ends there whatever a column measures. THESE
       are pictures on a oneCellAnchor — placed at B29 and given a width in PIXELS — so
       where the right edge lands depends on what a width-10 column actually renders as,
       and that is not the same everywhere. Excel puts it near 70px, LibreOffice near
       75px. At 75 the 574px bar stops short of column J and every render check passes;
       at 70 it runs about 14px into J and covers the left edge of the notes.

       Column L clears the bar by a full column on either metric. Anchoring by cell
       instead would track his file more exactly, but it would let the bitmap stretch if
       a width ever changed, and a distorted chart is the worse failure. */
    daNotes(ws, 'L29', [
      'Monthly average = mean of daily DA cash-out prices in the month.',
      daPartialEnd(d1) ? daShort(d0) + ' and ' + daShort(d1) + ' are partial months.'
                       : daShort(d0) + ' is a partial month; ' + daShort(d1) + ' is complete.',
      d0.slice(0, 4) + ' annual figure covers ' + daHuman(d0).replace(/ \d{4}$/, '')
        + ' – 31 Dec only.',
      'All figures recalculate from the ' + fuel.name + ' Daily Data tab.',
      /* His workbook carried "source file does not state units; power shown as £/MWh"
         — a caveat belonging to a spreadsheet exported from somewhere else. The portal
         holds the unit against the reading, so it is stated rather than assumed. */
      'Units are ' + fuel.unit + ', as held against every reading on the portal.',
      'Source: CES Flex Portal, Day Ahead tab.'
    ], 'dashboard');

    /* Landscape as his is. fitToPage is print-only and changes nothing on screen; it
       keeps the dashboard on one sheet of paper, which his geometry alone does not do
       at 1206px wide. Out to S, not Q: on the narrower column metric the line chart
       reaches past R, and a print area stopping at Q would clip its right edge on
       paper while looking perfectly fine on screen. */
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1,
      fitToHeight: 1,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      printArea: 'B1:S44' };
    daFooter(ws);
    return ws;
  }

  /* ExcelJS takes an image as base64 WITHOUT the data: prefix. The browser hands us a
     data URL and the test harness hands us the same shape, so the prefix is stripped
     here in one place rather than at each call site. */
  function daAddImage(wb, ws, dataUrl, tlRow, w, h) {
    var b64 = String(dataUrl || ''), comma = b64.indexOf(',');
    if (b64.slice(0, 5) === 'data:' && comma > -1) b64 = b64.slice(comma + 1);
    if (!b64) return;
    var id = wb.addImage({ base64: b64, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: tlRow - 1 }, ext: { width: w, height: h } });
  }

  /* The workbook. `o.XL` is the ExcelJS namespace — passed in rather than reached for,
     because the client portal loads it lazily and the desk has it on the page.
     `o.images` is { Gas: {line, bar}, Power: {line, bar} } of PNG data URLs. */
  function daWorkbook(o) {
    var wb = new o.XL.Workbook(),
        all = [
          { name: 'Gas',   unit: 'p/therm', rows: o.gas   || [] },
          { name: 'Power', unit: '£/MWh', rows: o.power || [] }
        ],
        fuels = [], geo = {}, i, f, imgs = o.images || {};

    /* A fuel with no readings gets no tabs at all. Every sheet below is built from
       rows[0] and rows[length-1] — the banner dates, the notes, the part-year block —
       so an empty series does not make an empty sheet, it throws. Four blank tabs
       would not be much better: the point of the book is the figures. The caller is
       handed both lists either way, so it can say a fuel was left out rather than
       letting somebody discover a missing tab. */
    for (i = 0; i < all.length; i++) if (all[i].rows.length) fuels.push(all[i]);

    wb.creator = 'CES Flex Portal';
    wb.created = new Date();

    for (i = 0; i < fuels.length; i++) {
      f = fuels[i];
      f.months = daMonths(f.rows);
      f.years  = daYears(f.rows);
      /* The dashboards reference the monthly tabs by cell ADDRESS, and those addresses
         are arithmetic: month rows start at 5, so the last is 4 + months.length and the
         full-period row the one after. Working the geometry out up front means the
         sheets can be created in their final display order — an earlier draft built
         them in dependency order and re-sorted afterwards, which quietly dropped one. */
      geo[f.name] = { lastData: 4 + f.rows.length,
                      lastMonthRow: 4 + f.months.length,
                      totRow: 5 + f.months.length };
    }

    for (i = 0; i < fuels.length; i++)
      daDashboardSheet(wb, fuels[i], fuels[i].name + ' Monthly Averages',
        geo[fuels[i].name].lastMonthRow, geo[fuels[i].name].totRow,
        imgs[fuels[i].name] || {});
    for (i = 0; i < fuels.length; i++)
      daMonthlySheet(wb, fuels[i], fuels[i].name + ' Daily Data',
        geo[fuels[i].name].lastData);
    for (i = 0; i < fuels.length; i++)
      daAnnualSheet(wb, fuels[i], fuels[i].name + ' Daily Data',
        geo[fuels[i].name].lastData, fuels[i].name + ' Monthly Averages');
    for (i = 0; i < fuels.length; i++)
      daDailySheet(wb, fuels[i]);

    return { wb: wb, fuels: fuels, geo: geo,
             included: fuels.map(function (x) { return x.name; }),
             skipped: all.filter(function (x) { return !x.rows.length; })
                         .map(function (x) { return x.name; }) };
  }

  /* ── THE CHARTS ───────────────────────────────────────────────────────────────
     Four pictures, drawn with the Chart.js already on both pages. Each is rendered
     into a detached canvas sized to the box the sheet will place it in, at `scale`
     times that in the backing store so it stays sharp.

     The size matters more than it looks. A first draft left the canvas at Chart.js's
     default 300x150 and stretched a 2:1 bitmap into a 3.5:1 box; the charts came out
     visibly flattened and nothing in the workbook said why. daChartPng therefore sets
     the canvas explicitly and the caller can check what it got. */
  function daChartCfg(kind, fuel, colour) {
    var labels = [], data = [], i, title;
    if (kind === 'line') {
      for (i = 0; i < fuel.months.length; i++) {
        labels.push(DA_MONN[+fuel.months[i].mk.slice(5, 7) - 1] + '-'
                    + fuel.months[i].mk.slice(2, 4));
        data.push(Math.round(fuel.months[i].avg * 100) / 100);
      }
      title = fuel.name + ' Day-Ahead Cash-Out Price — Monthly Average ('
              + fuel.unit + ')';
      return { type: 'line',
        plugins: [daFramePlugin()],
        data: { labels: labels, datasets: [{ label: title, data: data,
          borderColor: colour, backgroundColor: colour, borderWidth: 1.6,
          pointRadius: 2, pointStyle: 'circle', pointBackgroundColor: colour,
          tension: 0, fill: false }] },
        options: { responsive: false, animation: false, maintainAspectRatio: false,
          devicePixelRatio: DA_CHART.scale,
          layout: { padding: { top: 6, right: 14, bottom: 4, left: 6 } },
          plugins: { title: { display: true, text: title,
                       font: { size: 15, weight: 'bold' }, color: '#1f3864',
                       padding: { top: 4, bottom: 10 } },
                     legend: { display: false } },
          scales: {
            /* Every second month at 45 degrees — his labels run Feb-22, Apr-22, Jun-22
               and all of them are legible, which a plain autoSkip does not guarantee
               at this width. */
            x: { ticks: { font: { size: 9 }, color: '#595959', maxRotation: 45,
                          minRotation: 45, autoSkip: false,
                          callback: function (v, idx) {
                            return idx % 2 === 0 ? this.getLabelForValue(v) : '';
                          } },
                 grid: { color: 'rgba(31,56,100,0.07)' } },
            y: { title: { display: true, text: fuel.unit, font: { size: 10 },
                          color: '#595959' },
                 ticks: { font: { size: 9 }, color: '#595959' },
                 grid: { color: 'rgba(31,56,100,0.14)' } } } } };
    }
    for (i = 0; i < fuel.years.length; i++) {
      labels.push(fuel.years[i].y);
      data.push(Math.round(fuel.years[i].avg * 100) / 100);
    }
    title = 'Annual Average (' + fuel.unit + ')';
    return { type: 'bar',
      plugins: [daFramePlugin(), daBarLabelPlugin(2)],
      data: { labels: labels, datasets: [{ label: title, data: data,
        backgroundColor: colour, borderWidth: 0 }] },
      options: { responsive: false, animation: false, maintainAspectRatio: false,
        devicePixelRatio: DA_CHART.scale,
        layout: { padding: { top: 6, right: 12, bottom: 4, left: 6 } },
        plugins: { title: { display: true, text: title,
                     font: { size: 15, weight: 'bold' }, color: '#1f3864',
                     padding: { top: 4, bottom: 10 } },
                   legend: { display: false } },
        scales: { x: { ticks: { font: { size: 10 }, color: '#595959' },
                       grid: { display: false } },
                  y: { beginAtZero: true, grace: '12%',
                       ticks: { font: { size: 9 }, color: '#595959' },
                       grid: { color: 'rgba(31,56,100,0.14)' } } } } };
  }

  /* White behind the plot and the thin grey frame Excel draws round a chart. Without
     the fill the PNG is transparent and the picture reads as a smear on a coloured
     row. */
  function daFramePlugin() {
    return { id: 'daFrame', beforeDraw: function (ch) {
      var x = ch.ctx;
      x.save();
      x.fillStyle = '#fff'; x.fillRect(0, 0, ch.width, ch.height);
      x.strokeStyle = '#d9d9d9'; x.lineWidth = 1;
      x.strokeRect(0.5, 0.5, ch.width - 1, ch.height - 1);
      x.restore();
    } };
  }
  /* Chart.js 4 has no data labels of its own, so the bar values are drawn here. */
  function daBarLabelPlugin(dp) {
    return { id: 'daBarLabels', afterDatasetsDraw: function (ch) {
      var x = ch.ctx, meta = ch.getDatasetMeta(0), i, v;
      x.save();
      x.fillStyle = '#404040'; x.textAlign = 'center'; x.textBaseline = 'bottom';
      x.font = '10px Arial, Helvetica, sans-serif';
      for (i = 0; i < meta.data.length; i++) {
        v = Number(ch.data.datasets[0].data[i]);
        x.fillText(v.toFixed(dp), meta.data[i].x, meta.data[i].y - 3);
      }
      x.restore();
    } };
  }

  /* Render one chart to a PNG data URL. ChartLib is passed in for the same reason XL
     is: so the caller owns how the library got there, and so a test can hand in a
     double. Returns null rather than throwing if there is nothing to draw — a fuel
     with no readings should cost the export a picture, not the whole workbook. */
  function daChartPng(ChartLib, cfg, w, h) {
    if (!ChartLib || typeof document === 'undefined') return null;
    var cv = document.createElement('canvas'), ch, url;
    /* Attribute size is the CSS box; Chart.js multiplies it by devicePixelRatio for
       the backing store, which is what toDataURL reads. Fonts are specified against
       the CSS box, so they scale with it and the picture is sharp rather than tiny. */
    cv.width = w; cv.height = h;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    try {
      ch = new ChartLib(cv.getContext('2d'), cfg);
      /* Draw explicitly before reading the bitmap. With animation off Chart.js paints
         in the constructor, but "paints in the constructor" is an implementation
         detail and toDataURL on an unpainted canvas returns a blank picture with no
         error — the kind of failure that ships. One cheap call removes the question. */
      try { ch.draw(); } catch (e) {}
      url = cv.toDataURL('image/png');
    } finally {
      if (ch) { try { ch.destroy(); } catch (e) {} }
    }
    return url;
  }

  /* All four, keyed the way daWorkbook wants them. */
  function daCharts(ChartLib, gasRows, powerRows) {
    var out = {}, defs = [
          { name: 'Gas',   unit: 'p/therm',   rows: gasRows   || [], colour: '#2f5597' },
          { name: 'Power', unit: '£/MWh', rows: powerRows || [], colour: '#c55a11' }
        ], i, f;
    for (i = 0; i < defs.length; i++) {
      f = defs[i];
      f.months = daMonths(f.rows);
      f.years  = daYears(f.rows);
      out[f.name] = f.rows.length ? {
        line: daChartPng(ChartLib, daChartCfg('line', f, f.colour),
                         DA_CHART.line.w, DA_CHART.line.h),
        bar:  daChartPng(ChartLib, daChartCfg('bar', f, f.colour),
                         DA_CHART.bar.w, DA_CHART.bar.h)
      } : {};
    }
    return out;
  }

  /* The sentence under the Day Ahead tab. It exists because the tab shows daily prices
     for one year and the workbook now carries a great deal more than that, and nobody
     opens an export to find out what is in it. */
  var DA_EXPORT_CAPTION = 'The Excel export carries more than this tab shows — '
    + 'monthly and annual statistics for both fuels, with the highs, lows and ranges '
    + 'behind each average.';

  /* ── EXPORT ───────────────────────────────────────────────────────────────────── */
  root.FlexCore = {
    // units & precision
    isPower: isPower, costToPrice: costToPrice, convPkwh: convPkwh,
    volDisp: volDisp, fmtVolC: fmtVolC, fmtNum: fmtNum, fmtVol: fmtVol,
    fmtFull: fmtFull, fmtTyped: fmtTyped, esc: esc, signOf: signOf,
    // calendar
    monthKey: monthKey, nowMonth: nowMonth, nextMonth: nextMonth,
    seasonKey: seasonKey, fmtMonth: fmtMonth,
    // derived
    necMap: necMap, deliveredRate: deliveredRate,
    energyKwh: energyKwh, securedKwh: securedKwh, openKwh: openKwh, toKwh: toKwh,
    deliveredCost: deliveredCost, THERM_KWH: THERM_KWH,
    firstPricedTier: firstPricedTier,
    stats: stats, positionsTotals: positionsTotals, seasonGroups: seasonGroups,
    // targets
    tierCount: tierCount, targetRule: targetRule, requiredRaw: requiredRaw,
    requiredSecured: requiredSecured, volMeets: volMeets, autoAchieved: autoAchieved,
    isAchieved: isAchieved, allTargetsHit: allTargetsHit, targetKind: targetKind,
    ruleLabel: ruleLabel, visibleTargets: visibleTargets,
    nextTargetForMonth: nextTargetForMonth, upperAlertForMonth: upperAlertForMonth,
    // specs
    POSITIONS: POSITIONS, SEASONS: SEASONS, TARGETS: TARGETS, TRADES: TRADES,
    SITES: SITES,
    // spreadsheet — both portals build their workbook from xlWorkbook and nothing else
    xlWorkbook: xlWorkbook, xlSheet: xlSheet, xlText: xlText, xlNum: xlNum,
    CLIENT_HIDE: CLIENT_HIDE, clientCols: clientCols, XL_ROUND_NOTE: XL_ROUND_NOTE,
    normTrade: normTrade, fmtDate: fmtDate,
    TABS: TABS, clientTabs: clientTabs, TARGETS_TABLE_CLASS: TARGETS_TABLE_CLASS,
    pctCell: pctCell, buildTable: buildTable,
    // day-ahead workbook (round 48) — both portals export the SAME file from here
    daWorkbook: daWorkbook, daCharts: daCharts, daChartCfg: daChartCfg,
    daChartPng: daChartPng, daMonths: daMonths, daYears: daYears,
    daPartialEnd: daPartialEnd, DA_CHART: DA_CHART,
    DA_EXPORT_CAPTION: DA_EXPORT_CAPTION,
    // BUMP THIS on every change to this file. It is how anyone tells which build a
    // browser actually has — the desk shows it, and it is the first thing to check when
    // the two portals disagree or a change appears not to have landed.
    VERSION: '2026-11-04'
  };
})(typeof window !== 'undefined' ? window : globalThis);
