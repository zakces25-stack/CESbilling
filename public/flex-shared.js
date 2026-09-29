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

  // Cumulative requirement for column `i` BEFORE the baseload cap.
  //
  // `t` is the target row for the month under test, and it decides which columns count.
  // A column that carries no price for THIS month asks nothing of it and is skipped
  // entirely. Baskets routinely stagger their columns — the first two authorised for
  // Oct-28 onwards, the next two advisory for the years before it — and billing a month
  // for rungs it was never given is how a 100 th/d ladder came to demand 300 th/d in the
  // first column a month actually uses. Each column keeps its own rule; blank columns
  // contribute nothing. Omit `t` and the old month-agnostic sum is returned, which is
  // what a caller asking "what would this column ask of a full row" wants.
  function requiredRaw(basket, i, base, t) {
    if (targetRule(basket, i).type === 'none') return null;
    if (t && t['lower_t' + i] == null) return null;
    var cum = 0;
    for (var n = 1; n <= i; n++) {
      var r = targetRule(basket, n);
      if (r.type === 'none') continue;
      if (t && t['lower_t' + n] == null) continue;
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
      { key: 'prod', head: 'Product', align: 'left', value: function (t) { return esc(t.product || ''); } },
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

     The last two columns are the commercial terms. They are on the desk's Sites tab and
     not on the customer's, so both portals get the same spec and each drops what its own
     screen does not show — the same arrangement as Next Target and Upper Alert.        */

  function SITES(basket) {
    var power = isPower(basket);
    return [
      { key: 'mpxn',  head: power ? 'MPAN' : 'MPRN', align: 'left',
        value: function (s) { return esc(s.mpxn || '-'); } },
      { key: 'site',  head: 'Site', align: 'left',
        value: function (s) { return esc(s.customer || '-'); } },
      { key: 'start', head: 'Contract Start', align: 'left',
        value: function (s) { return fmtDate(s.contract_start); } },
      { key: 'end',   head: 'Contract End', align: 'left',
        value: function (s) { return fmtDate(s.contract_end); } },
      { key: 'nec',   head: 'NEC Unit Rate (p/kWh)', align: 'right',
        value: function (s) { return s.nec_unit_rate != null ? (+s.nec_unit_rate).toFixed(3) : '-'; } },
      { key: 'necsc', head: 'NEC Standing Charge (p/day)', align: 'right',
        value: function (s) { return s.nec_standing_charge != null ? (+s.nec_standing_charge).toFixed(3) : '-'; } }
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
       · What the two portals drop differs, and only that: see XL_DESK_ONLY.            */

  // Desk-only columns, by spec key. The customer's workbook drops these four and is
  // otherwise identical to the desk's — Dan's 17 Sep decision for the target columns,
  // and the customer's own Sites tab has never shown the NEC terms.
  //   nt / ua  Next Target, Upper Alert  (POSITIONS, and ua on TARGETS)
  //   nec      NEC unit rate             (SITES)
  //   necsc    NEC standing charge       (SITES)
  var XL_DESK_ONLY = { nt: 1, ua: 1, nec: 1, necsc: 1 };

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
    var keep = function (cols) {
      return desk ? cols : cols.filter(function (c) { return !XL_DESK_ONLY[c.key]; });
    };
    var months = (bk.months || []).slice();
    var nm = necMap(bk, o.necRows || []);
    var stamp = o.stamp || '';
    var ctx = o.ctx || {};
    var wb = new o.XL.Workbook();
    wb.creator = 'CES flex portal';
    wb.created = new Date();
    wb.title = o.name + ' - portfolio';

    xlSheet(wb, 'Positions', keep(POSITIONS(bk)), months, ctx, {
      dates: { month: { get: function (m) { return m.month; }, fmt: 'mmm-yy' } },
      totals: positionsTotals(months, bk, nm),
      mark: function (m) { return m.month === nowMonth(); },
      note: (o.note ? o.note + ' ' : '') + XL_ROUND_NOTE,
      empty: 'No position data for this basket.',
      title: o.name + ' - positions', stamp: stamp });

    xlSheet(wb, 'Trades', TRADES(bk), o.trades || [], {}, {
      dates: { date: { get: function (t) { return t.date; }, fmt: 'dd mmm yy' } },
      empty: 'No trades recorded for this basket.',
      title: o.name + ' - trades', stamp: stamp });

    xlSheet(wb, 'Seasons', SEASONS(bk), seasonGroups(months, bk), ctx, {
      empty: 'No seasons to summarise for this basket.',
      title: o.name + ' - seasons', stamp: stamp });

    // visibleTargets, so the file shows the tradable months the tab shows rather than
    // reintroducing the settled ones the tab deliberately drops.
    xlSheet(wb, 'Targets', keep(TARGETS(bk)), visibleTargets(bk), ctx, {
      dates: { month: { get: function (t) { return t.month; }, fmt: 'mmm-yy' } },
      mark: function (t) { return t.month === nowMonth(); },
      empty: 'No targets set for this basket.',
      title: o.name + ' - targets', stamp: stamp });

    xlSheet(wb, 'Sites', keep(SITES(bk)), o.sites || [], {}, {
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
    var head = cols.map(function (c) {
      return '<th scope="col" class="' + (ALIGN[c.align] || '') + '">' + c.head + '</th>';
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
    XL_DESK_ONLY: XL_DESK_ONLY, XL_ROUND_NOTE: XL_ROUND_NOTE,
    normTrade: normTrade, fmtDate: fmtDate,
    TABS: TABS, clientTabs: clientTabs, TARGETS_TABLE_CLASS: TARGETS_TABLE_CLASS,
    pctCell: pctCell, buildTable: buildTable,
    // BUMP THIS on every change to this file. It is how anyone tells which build a
    // browser actually has — the desk shows it, and it is the first thing to check when
    // the two portals disagree or a change appears not to have landed.
    VERSION: '2026-09-29'
  };
})(typeof window !== 'undefined' ? window : globalThis);
