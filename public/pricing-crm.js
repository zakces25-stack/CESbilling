/*
 * pricing-crm.js - the Customers section of the pricing desk: everything UtilityClick held about
 * CES's customers, sites, meters, contracts, tenders, contacts, notes and readings.
 *
 * Mounted by pricing.html:
 *   CrmDesk.mount(host, { sb, esc, who, onPriceMeter, XLSX, docs, nav: false, onView })
 *     nav: false   the page's own top tabs drive the views (4 Nov 2026 redesign); without it the
 *                  module draws its own menu, as before
 *     onView(v)    told which view is showing, so the page can light the right tab
 *     docs         CrmDocs (pricing-docs.js): the signed contract on each contract row
 *
 * WHAT IT READS (all security_invoker views over the crm_* tables, pricing team + admin only):
 *   crm_overview()       the landing figures, one call
 *   crm_customers_v      one row per customer with its meter / contract counts
 *   crm_meters_v         one row per meter with its contract position TODAY, the profile class
 *                        rule (pc_rule), the desk's correction if any, and its MOP and DC/DA
 *   crm_contracts_v      one row per meter contract; lifecycle is computed at read time:
 *                        live / upcoming / ended / pipeline / stale / lost / service; and the
 *                        service split (service_group supply / meter_services / other_services)
 *   crm_tenders_v        open / stale / won / lost
 *   crm_issues           what the import found wrong with the UC data
 *
 * Nothing here is cached between views and every list is paged with .range(): the biggest
 * customer has 3,762 contracts, which a plain select would silently cut at 1,000 rows.
 *
 * 6 Nov 2026 (CES: "everything has to fit fully to screen", "cleaner, organised, more
 * efficient"):
 *   - every list is a card that fills the window (the page sets main.fill): filters on one row,
 *     the table scrolling inside its own box with its header pinned, the pager always in sight;
 *   - the signed contract cell is the FIRST column of every table (View, or Upload);
 *   - contract rows are 8 columns, not 13, so nothing scrolls sideways at 1280 px;
 *   - the customer page is a company page: a header, then one tab at a time (Sites and meters,
 *     Supply contracts, Meter services, Contacts, Tenders, Notes, Readings, Problems);
 *   - new view 'nocontract': the No contract uploaded page, from crm_no_contract() (_61b).
 *   opts.scroller()      the element that scrolls (main), so a view opens at its top
 *   opts.onCompany(c)    told which company is open ({ id, name }), for the tab along the top
 *   opts.openNoContract(q)  open the No contract uploaded page (it is its own section)
 *   opts.onDocsChanged() a file was stored or removed (the side menu count)
 *
 * ASCII only. Special characters are HTML entities, never literal.
 */
(function (root) {
  'use strict';

  var VERSION = '2026-11-06.1';
  var PAGE = 50, BIG_PAGE = 100;

  var LIFE = {
    live: ['Live', 'p-ok'], upcoming: ['Upcoming', 'p-warn'], ended: ['Ended', 'p-mute'],
    pipeline: ['In progress', 'p-warn'], stale: ['Never progressed', 'p-mute'], lost: ['Lost', 'p-fail'],
    service: ['Service', 'p-mute'], unknown: ['Unknown status', 'p-fail'], undated: ['No dates', 'p-mute'],
    open: ['Open', 'p-warn'], won: ['Won', 'p-ok'],
  };
  // Supply contracts by lifecycle; MOP, DC/DA and the rest by their dates alone (UC gives them
  // no deal status worth reading). 4 Nov 2026: they used to share one register.
  var CONTRACT_TABS = ['live', 'upcoming', 'pipeline', 'ended', 'stale', 'lost'];
  var SERVICE_TABS = ['live', 'upcoming', 'ended', 'undated'];
  var GROUPS = { supply: 'Supply', meter_services: 'Meter services', other_services: 'Other services' };
  var KIND = {
    mop: 'MOP', dcda: 'DC / DA', mop_dcda: 'MOP + DC / DA', data: 'Data and AMR', metering_works: 'Meter works',
    meter_services: 'Meter services', compliance: 'ESOS / SECR', green: 'REGO / green', water: 'Water',
    solar: 'Solar', ces_service: 'CES service', consultancy: 'Consultancy', other: 'Other', supply: 'Supply',
  };
  var TENDER_TABS = ['open', 'stale', 'won', 'lost'];
  var ISSUE_LABEL = {
    out_of_contract: 'No contract after the last one ended', contract_gap: 'Gap between contracts',
    contract_overlap: 'Contracts overlap', ced_before_csd: 'Ends before it starts',
    csd_placeholder: 'Placeholder start date', dates_missing: 'No dates',
    rate_implausible: 'Unit rate not believable', capacity_implausible: 'Capacity charge not believable',
    capacity_kva_implausible: 'kVA not believable', standing_charge_unit: 'Standing charge unit unknown',
    meter_id_invalid: 'Meter number problem', mpan_on_several_customers: 'Meter on several customers',
    customer_duplicate_name: 'Same name, several customers', aq_placeholder: 'Placeholder consumption',
    stale_pipeline: 'Deal that never progressed', llfc_letter_o: 'LLFC typo (O for 0)',
    postcode_missing: 'Site without a postcode', status_unknown: 'Unknown deal status',
  };
  var SEV = { high: ['High', 'p-fail'], medium: ['Medium', 'p-warn'], low: ['Low', 'p-mute'], info: ['Info', 'p-mute'], pc: ['Profile class', 'p-fail'] };

  // ------------------------------------------------------------------ rate types and the PC rule
  var RATE = { single: 'Single rate', day_night: 'Day / Night', eve_weekend: 'Day + Evening/Weekend',
               day_night_ew: 'Day / Night + Evening/Weekend', off_peak: 'Off-peak' };
  var RATE_CLASS = { single: 'rt-1', day_night: 'rt-dn', eve_weekend: 'rt-ew', day_night_ew: 'rt-dnew', off_peak: 'rt-op' };
  function pc2(pc) { return pc == null || pc === '' ? '' : ('0' + Number(pc)).slice(-2); }
  function mcLetter(mc) { var m = /class\s*([a-g])/i.exec(String(mc || '')); return m ? m[1].toUpperCase() : ''; }
  /**
   * The same rule as crm_pc_rule in the database (_59), so the desk can say "that will be
   * refused" before it asks. The database is the one that refuses.
   *   00 half-hourly: any rate type (priced by the half hour)
   *   01 / 03 unrestricted: single rate (or day + evening/weekend)
   *   02 / 04 Economy 7 type: a night or off-peak register
   *   05 - 08 maximum demand: any non-half-hourly rate type
   */
  function pcRule(pc, reg, supply, mc) {
    if (pc == null || pc === '') return 'missing';
    pc = Number(pc);
    if (!(pc >= 0 && pc <= 8)) return 'check';
    var s = String(supply || '').toUpperCase(), l = mcLetter(mc);
    if (s === 'HH' && pc >= 1) return 'check';
    if (s === 'NHH' && pc === 0) return 'check';
    if ((l === 'A' || l === 'B') && pc === 0) return 'check';
    if ('CEFG'.indexOf(l) >= 0 && l && pc >= 1) return 'check';
    if (pc === 0) return 'ok';
    if (!reg) return 'missing';
    if (pc >= 5) return 'ok';
    if (reg === 'single') return pc === 1 || pc === 3 ? 'ok' : 'check';
    if (reg === 'day_night' || reg === 'off_peak' || reg === 'day_night_ew') return pc === 2 || pc === 4 ? 'ok' : 'check';
    if (reg === 'eve_weekend') return 'ok';
    return 'check';
  }
  function pcReason(pc, reg, supply, mc) {
    if (pc == null || pc === '') return 'No profile class on file. It is the first two digits of the MPAN top line on the bill.';
    pc = Number(pc);
    var s = String(supply || '').toUpperCase(), l = mcLetter(mc), label = RATE[reg] ? RATE[reg].toLowerCase() : 'unknown';
    if (!(pc >= 0 && pc <= 8)) return 'Profile class ' + pc + ' does not exist: they run 00 to 08.';
    if (s === 'HH' && pc >= 1) return 'UC says this supply is half-hourly, so the profile class should be 00, not ' + pc2(pc) + '.';
    if (s === 'NHH' && pc === 0) return 'UC says this supply is non-half-hourly, but the profile class is 00 (half-hourly).';
    if ((l === 'A' || l === 'B') && pc === 0) return 'Measurement class ' + l + ' is non-half-hourly, but the profile class is 00.';
    if ('CEFG'.indexOf(l) >= 0 && l && pc >= 1) return 'Measurement class ' + l + ' is half-hourly, but the profile class is ' + pc2(pc) + '.';
    if (pc === 0 || pc >= 5) return '';
    if (!reg) return 'No rate type on file (single rate, day/night, evening/weekend...).';
    if (reg === 'single' && (pc === 2 || pc === 4)) return 'Profile class ' + pc2(pc) + ' is the Economy 7 type, which needs a night or off-peak register, but this meter is single rate. Either the profile class is ' + pc2(pc - 1) + ' or the meter is day/night.';
    if ((reg === 'day_night' || reg === 'off_peak' || reg === 'day_night_ew') && (pc === 1 || pc === 3)) return 'A ' + label + ' meter has a night or off-peak register, which makes it profile class ' + pc2(pc + 1) + ', not ' + pc2(pc) + '.';
    return '';
  }

  // ------------------------------------------------------------------ helpers
  function uk(iso) {
    if (!iso) return '';
    var s = String(iso).slice(0, 10).split('-');
    return s.length === 3 ? s[2] + '/' + s[1] + '/' + s[0] : String(iso);
  }
  function n0(v) { return v == null || v === '' ? '' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
  function n2(v, dp) {
    if (v == null || v === '') return '';
    return Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 3 : dp });
  }
  function pill(map, key) { var p = map[key] || [key || '', 'p-mute']; return '<span class="pill ' + p[1] + '">' + p[0] + '</span>'; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function plusDays(iso, n) { var t = Date.parse(iso + 'T00:00:00Z') + n * 864e5; return new Date(t).toISOString().slice(0, 10); }
  // Commas and brackets would end a PostgREST .or() early, so they (and the LIKE wildcards
  // themselves) become %: "Acme (UK) Ltd" still finds "Acme (UK) Ltd".
  function likeTerm(s) { return '%' + String(s || '').trim().replace(/[%_,()]/g, '%') + '%'; }

  var STYLES = [
    '.crm-sub{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 16px}',
    '.crm-sub button{background:none;border:1px solid transparent;color:var(--text-2);font:inherit;font-size:12.5px;font-weight:700;padding:6px 12px;border-radius:8px;cursor:pointer}',
    '.crm-sub button:hover{background:var(--panel-2);color:var(--text)}',
    '.crm-sub button.on{color:var(--cyan);background:var(--cyan-glow);border-color:var(--cyan-dim)}',
    '.crm-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:6px}',
    '.crm-kpi{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px}',
    '.crm-kpi .k{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}',
    '.crm-kpi .v{font-size:22px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}',
    '.crm-kpi .s{font-size:11.5px;color:var(--text-2);margin-top:2px}',
    '.crm-kpi.link{cursor:pointer}.crm-kpi.link:hover{border-color:var(--cyan-dim);background:var(--cyan-glow)}',
    '.crm-kpi.alert .v{color:var(--fail)}',
    '.crm-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px}',
    '.crm-tabs button{background:var(--panel-2);border:1px solid var(--line-2);color:var(--text-2);font:inherit;font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;cursor:pointer}',
    '.crm-tabs button.on{background:var(--cyan-glow);border-color:var(--cyan-dim);color:var(--cyan)}',
    '.crm-tabs .c{font-weight:600;opacity:.75;margin-left:4px}',
    // The three contract groups: a segmented switch, so Supply and MOP / DC / DA can never be
    // mistaken for one list again.
    '.crm-seg{display:inline-flex;border:1px solid var(--line-2);border-radius:10px;overflow:hidden;margin:2px 0 12px;background:var(--panel)}',
    '.crm-seg button{background:none;border:0;border-right:1px solid var(--line-2);color:var(--text-2);font:inherit;font-size:12.5px;font-weight:700;padding:8px 14px;cursor:pointer}',
    '.crm-seg button:last-child{border-right:0}',
    '.crm-seg button.on{background:var(--cyan);color:#fff}',
    '.crm-seg .c{font-weight:600;opacity:.85;margin-left:6px}',
    '.crm-pager{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px;color:var(--muted)}',
    '.crm-click{cursor:pointer}.crm-click:hover td:first-child{color:var(--cyan);text-decoration:underline}',
    '.crm-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 18px;font-size:12.5px}',
    '.crm-kv div span{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:2px}',
    '.crm-small{font-size:11px;color:var(--muted)}',
    '.crm-bad{font-size:11px;color:var(--fail);line-height:1.45;max-width:300px;white-space:normal}',
    '.crm-wrap{white-space:normal;overflow-wrap:anywhere;max-width:340px}',
    '.crm-back{background:none;border:none;color:var(--cyan);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;padding:0;margin-bottom:10px}',
    '.crm-drop{border:2px dashed var(--line-2);border-radius:12px;padding:22px 18px;text-align:center;cursor:pointer}',
    '.crm-drop.over{border-color:var(--cyan-dim);background:var(--cyan-glow)}',
    '.crm-h3{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);margin:18px 0 8px}',
    // Rate type badges: the register layout in words, readable at a glance (CES, 4 Nov 2026:
    // "a clearer way to show if a meter is Day/Night, One Rate, Evening/Weekend").
    '.rt{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;white-space:nowrap;border:1px solid transparent}',
    '.rt-1{background:#e9eef7;color:#2b3a55;border-color:#cfd9ea}',
    '.rt-dn{background:#e6ecfb;color:#21408f;border-color:#c3d0f0}',
    '.rt-ew{background:#e3f2ef;color:#0f5e55;border-color:#bfe0da}',
    '.rt-dnew{background:#efe9fb;color:#4b2f8f;border-color:#d8ccf2}',
    '.rt-op{background:#fbf1de;color:#6e4b05;border-color:#ecd5a6}',
    '.rt-hh{background:#1f2d55;color:#fff;border-color:#1f2d55}',
    '.rt-x{background:var(--panel-2);color:var(--muted);border-color:var(--line-2)}',
    '.pcb{display:inline-block;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:600;color:var(--text-2);margin-left:6px;white-space:nowrap}',
    '.svc{font-size:12px;line-height:1.45}.svc b{font-weight:700}',
    '.fixrow td{background:var(--panel-2)}',
    '.fixbox{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}',
    '.fixbox>div{min-width:150px}',
    '.fixbox select,.fixbox input{height:32px;font-size:12.5px;padding:4px 8px}',
    // Portfolios (4 Nov 2026): one tile per account manager instead of 900 customers in a list.
    '.pf-top{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}',
    '.pf-top>div:first-child{flex:1;min-width:240px}',
    '.pf-strip{display:flex;flex-wrap:wrap;gap:18px;font-size:12px;color:var(--text-2);margin:0 0 16px}',
    '.pf-strip b{font-size:15px;color:var(--text);font-variant-numeric:tabular-nums;margin-right:4px}',
    '.pf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
    // A <button> centres its content vertically; in a grid row next to a taller tile that left
    // the name floating halfway down (seen in the screenshot, 4 Nov). Column flex keeps it top.
    '.pf-tile{text-align:left;background:var(--panel);border:1px solid var(--line-2);border-radius:12px;padding:14px 16px;cursor:pointer;font:inherit;color:var(--text);display:flex;flex-direction:column;justify-content:flex-start}',
    '.pf-tile:hover,.pf-tile:focus-visible{border-color:var(--cyan-dim);background:var(--cyan-glow);outline:none}',
    '.pf-tile.me{border-color:var(--cyan);box-shadow:0 0 0 2px var(--cyan-glow)}',
    '.pf-tile .n{font-size:14.5px;font-weight:800;margin-bottom:6px}',
    '.pf-tile .l{font-size:12px;color:var(--text-2);line-height:1.7}',
    '.pf-tile .l b{color:var(--text);font-variant-numeric:tabular-nums}',
    '.pf-tile .due{color:var(--warn)} .pf-tile .gap{color:var(--fail)}',
    '.pf-sub{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:20px 0 8px}',
    '.pf-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}',
    '.pf-head h2{margin:0}',
    // ---- 6 Nov 2026: lists that fit the window. The card fills what is left under the tabs
    // (main.fill, set by the page); its table scrolls inside .grid with the header pinned.
    '.fillcard{display:flex;flex-direction:column}',
    '.fc-head{flex:0 0 auto}',
    '.fc-title{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;margin-bottom:10px}',
    '.fc-title h2{margin:0}',
    '.fc-count{font-size:12.5px;color:var(--text-2)}',
    '.fc-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.fc-foot{flex:0 0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:10px}',
    '.fc-foot .crm-pager{margin-top:0}',
    '.fc-sub{font-size:12px;color:var(--muted);margin:-4px 0 10px;line-height:1.5}',
    '.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}',
    '.toolbar input,.toolbar select{height:32px;font-size:12.5px;padding:4px 9px;width:auto;min-width:0}',
    '.toolbar .tb-q{flex:1 1 220px;max-width:340px}',
    '.toolbar select{flex:0 1 auto;max-width:180px}',
    '.toolbar .tb-btn{background:none;border:1px dashed var(--line-2);border-radius:8px;height:32px;padding:0 11px;font:inherit;font-size:12px;font-weight:700;color:var(--text-2);cursor:pointer;white-space:nowrap}',
    '.toolbar .tb-btn:hover{border-color:var(--cyan-dim);color:var(--cyan)}',
    '.toolbar .act{height:32px;padding:0 14px}',
    '.toolbar .tb-check{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-2);text-transform:none;letter-spacing:0;margin:0;font-weight:600;white-space:nowrap}',
    '.toolbar .tb-check input{width:auto;height:auto}',
    '.grid{overflow:auto;position:relative;border:1px solid var(--line);border-radius:10px;background:#fff}',
    '.grid table{border-collapse:separate;border-spacing:0}',
    '.grid thead th{position:sticky;top:0;z-index:2;background:#f5f7fb;border-bottom:1px solid var(--line-2)}',
    '.grid td{border-bottom:1px solid var(--line)}',
    '.grid tbody tr:last-child td{border-bottom:0}',
    '.grid .note{margin:10px}',
    '.nowrap{white-space:nowrap}',
    '.crm-link{color:var(--text);font-weight:700;cursor:pointer;text-decoration:none;background:none;border:0;padding:0;font:inherit;text-align:left}',
    '.crm-link:hover{color:var(--cyan);text-decoration:underline}',
    '.site-row td{background:var(--panel-2);font-size:12.5px;font-weight:800;color:var(--text);padding:7px 10px;border-bottom:1px solid var(--line-2)}',
    '.site-row .crm-small{display:inline;margin-left:8px;font-weight:500}',
    '.rates{font-size:12px;line-height:1.5}',
    '.rates .u{color:var(--muted);font-size:11px}',
    // Optional columns go first when the window is narrow, so nothing scrolls sideways.
    '@media (max-width:1439px){.c-opt{display:none}}',
    // ---- the company page
    '.co-head{display:flex;gap:10px 18px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}',
    '.card .co-name{font-size:19px;font-weight:800;color:var(--text);margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;text-transform:none;letter-spacing:0}',
    '.co-head .crm-back{margin:2px 0 0;white-space:nowrap}',
    '.ell{display:block;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tb-more{display:contents}',
    '.tb-more.hide{display:none!important}',
    '.co-facts{font-size:12px;color:var(--text-2);margin-top:5px;line-height:1.6}',
    '.co-facts b{color:var(--text);font-weight:700}',
    '.co-stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
    '.co-stat{background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:5px 11px;font-size:11.5px;color:var(--text-2);font:inherit;font-size:11.5px;text-align:left}',
    '.co-stat b{display:block;font-size:15px;color:var(--text);font-variant-numeric:tabular-nums}',
    '.co-stat.warn{border-color:#ecd5a6;background:#fbf4e4;color:#5c4104;cursor:pointer}',
    '.co-stat.warn:hover{border-color:#c28100}',
    '.co-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:12px 0 10px;overflow-x:auto;scrollbar-width:thin}',
    '.co-tabs button{background:none;border:0;border-bottom:3px solid transparent;color:var(--text-2);font:inherit;font-size:13px;font-weight:700;padding:7px 12px 8px;cursor:pointer;white-space:nowrap;flex:0 0 auto}',
    '.co-tabs button:hover{color:var(--text)}',
    '.co-tabs button.on{color:var(--cyan);border-bottom-color:var(--cyan)}',
    '.co-tabs .c{font-weight:600;opacity:.8;margin-left:5px}',
    '.co-tabs .bad .c{color:var(--fail);opacity:1}',
    '.co-body{display:flex;flex-direction:column}',
    '.co-body .crm-tabs{margin-top:0}',
    // ---- No contract uploaded
    '.nc-meters{font-size:12px;line-height:1.55}',
    '.nc-meters .mono{font-size:11.5px}',
    '.nc-more{background:none;border:0;padding:0;color:var(--cyan);font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}',
  ].join('\n');

  function injectStyles(doc) {
    if (doc.getElementById('crmStyles')) return;
    var s = doc.createElement('style');
    s.id = 'crmStyles';
    s.textContent = STYLES;
    doc.head.appendChild(s);
  }

  // ------------------------------------------------------------------ the desk
  function mount(host, opts) {
    var sb = opts.sb, esc = opts.esc, doc = host.ownerDocument;
    var who = opts.who || function () { return ''; };
    var docs = opts.docs || null;
    injectStyles(doc);

    var S = {
      view: 'portfolios', overview: null, portfolios: null,
      cust: { page: 0, q: '', status: 'customers', am: '', sort: 'name' },
      customer: null, ctab: 'live', cpage: 0,
      k: { group: 'supply', tab: 'live', page: 0, q: '', supplier: '', fuel: '', am: '', ces: '', within: '', notRenewed: false, docs: '', kind: '', provider: '' },
      t: { tab: 'open', page: 0, q: '', am: '' },
      iq: { sev: 'high', kind: '', page: 0 },
      nc: { kind: '', state: '', am: '', q: '', sort: 'customer', page: 0 },
      cview: 'sites', back: 'portfolios',
      lists: null, importFiles: [], importPlan: null, busy: false,
    };

    var MENU = [['portfolios', 'Portfolios'], ['contracts', 'Contracts'], ['services', 'Meter services'], ['documents', 'Signed contracts'],
                ['nocontract', 'No contract uploaded'], ['tenders', 'Tenders'], ['quality', 'Data checks'], ['overview', 'Figures'],
                ['import', 'Import from UC']];
    host.innerHTML = (opts.nav === false ? '' : '<div class="crm-sub" id="crmNav">' + MENU.map(function (v) {
      return '<button data-v="' + v[0] + '">' + v[1] + '</button>';
    }).join('') + '</div>') + '<div id="crmBody"></div>';
    var body = host.querySelector('#crmBody');
    if (opts.nav !== false) {
      host.querySelector('#crmNav').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-v]');
        if (b) go(b.getAttribute('data-v'));
      });
    }

    function q(builder, what) {
      return Promise.resolve(builder).then(function (r) {
        if (r.error) throw new Error(what + ': ' + r.error.message);
        return r;
      });
    }
    function fail(e) { body.insertAdjacentHTML('afterbegin', '<div class="note bad" style="margin-bottom:12px">' + esc(e.message || String(e)) + '</div>'); }
    function menuKey() {
      if (S.view === 'customers') return 'portfolios';
      return S.view;
    }
    function setNav() {
      var v = menuKey();
      [].forEach.call(host.querySelectorAll('#crmNav button'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-v') === v);
      });
      if (opts.onView) { try { opts.onView(v); } catch (_) { /* the page's business */ } }
    }
    // What scrolls: the page's main box (6 Nov 2026: the window itself no longer scrolls on the
    // desk), or the window when the module is used on an ordinary page or on a phone.
    function scroller() {
      var sc = opts.scroller ? opts.scroller() : null;
      if (!sc) return null;
      var oy = (doc.defaultView || root).getComputedStyle(sc).overflowY;
      return oy === 'auto' || oy === 'scroll' || oy === 'hidden' ? sc : null;
    }
    function scrollTopOf() {
      var sc = scroller(), win = doc.defaultView || root;
      return sc ? sc.scrollTop : (win.scrollY || 0);
    }
    function gridTop() { var g = body.querySelector('.grid'); return g ? g.scrollTop : 0; }
    function go(view, arg, opt) {
      var win = doc.defaultView || root;
      var keep = opt && opt.keepScroll ? scrollTopOf() : null;
      // Working down a list (an upload, a Fix, a Done): the table's own scroll is kept too.
      var keepGrid = opt && opt.keepScroll ? gridTop() : 0;
      if (view === 'services') { S.k.group = 'meter_services'; if (SERVICE_TABS.indexOf(S.k.tab) < 0) S.k.tab = 'live'; }
      else if (view === 'contracts' && S.k.group === 'meter_services' && !(opt && opt.keepGroup)) { S.k.group = 'supply'; S.k.tab = 'live'; }
      if (view === 'customer' && S.view !== 'customer' && S.view) S.back = S.view;
      if (view === 'customer' && !arg && !S.customer) view = 'portfolios';
      S.view = view; setNav();
      if (keep == null) {
        body.innerHTML = '<div class="note">Loading&hellip;</div>';
        // A new view starts with its own top in sight.
        var sc = scroller();
        if (sc) sc.scrollTop = 0;
        else {
          var hdr = doc.querySelector('header');
          var cover = hdr && win.getComputedStyle(hdr).position === 'sticky' ? hdr.getBoundingClientRect().height : 0;
          var top = host.getBoundingClientRect().top;
          if (top < cover && win.scrollBy) win.scrollBy(0, top - cover - 8);
        }
      }
      var f = { portfolios: renderPortfolios, overview: renderOverview, customers: renderCustomers, customer: renderCustomer,
                contracts: renderContracts, services: renderContracts, documents: renderDocuments, tenders: renderTenders,
                quality: renderQuality, import: renderImport, nocontract: renderNoContract }[view];
      return Promise.resolve().then(function () { return f(arg); })
        .then(function () {
          if (keep == null) return;
          var sc = scroller();
          if (sc) sc.scrollTop = keep; else win.scrollTo(0, keep);
          var g = body.querySelector('.grid'); if (g && keepGrid) g.scrollTop = keepGrid;
        })
        .catch(function (e) { body.innerHTML = ''; fail(e); });
    }
    function docsChanged() { if (opts.onDocsChanged) { try { opts.onDocsChanged(); } catch (_) { /* the page's business */ } } }

    function lists() {
      if (S.lists) return Promise.resolve(S.lists);
      return Promise.all([
        q(sb.from('crm_contract_suppliers_v').select('supplier, contracts').order('supplier'), 'supplier list'),
        q(sb.from('crm_account_managers_v').select('account_manager, customers').order('account_manager'), 'account manager list'),
      ]).then(function (r) {
        S.lists = { suppliers: r[0].data || [], ams: r[1].data || [] };
        return S.lists;
      });
    }
    function options(list, value, all, label) {
      return '<option value="">' + all + '</option>' + list.map(function (x) {
        var v = x[label];
        return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('');
    }
    function pager(page, size, count) {
      var from = count ? page * size + 1 : 0, to = Math.min(count, (page + 1) * size);
      return '<div class="crm-pager"><button class="act ghost sm" data-pg="' + (page - 1) + '"' + (page > 0 ? '' : ' disabled') + '>Previous</button>' +
        '<span>' + n0(from) + '&ndash;' + n0(to) + ' of ' + n0(count) + '</span>' +
        '<button class="act ghost sm" data-pg="' + (page + 1) + '"' + (to < count ? '' : ' disabled') + '>Next</button></div>';
    }
    function wirePager(el, on) {
      [].forEach.call(el.querySelectorAll('[data-pg]'), function (b) {
        b.addEventListener('click', function () { on(Number(b.getAttribute('data-pg'))); });
      });
    }

    // ---------------------------------------------------------------- rate type and the fix
    function rateCell(m) {
      if (m.fuel !== 'electricity') {
        return '<span class="rt rt-x">' + esc(m.fuel === 'gas' ? 'Gas' : m.fuel === 'water' ? (m.supply_type === 'water_waste' ? 'Waste water' : 'Water')
          : (m.supply_type || m.utility || '')) + '</span>';
      }
      var pc = m.pc_effective != null ? m.pc_effective : m.profile_class;
      var hh = Number(pc) === 0 && pc !== null && pc !== '';
      var badge = hh ? '<span class="rt rt-hh">Half-hourly</span>'
        : m.registers ? '<span class="rt ' + (RATE_CLASS[m.registers] || 'rt-x') + '">' + esc(RATE[m.registers] || m.registers) + '</span>'
        : '<span class="rt rt-x">Rate type unknown</span>';
      var pcTxt = pc == null || pc === '' ? '<span class="pcb">PC ?</span>' : '<span class="pcb">PC ' + pc2(pc) + '</span>';
      var note = '';
      if (m.pc_source === 'hh_supply') note = '<div class="crm-small">00 from the HH supply type</div>';
      if (m.pc_source === 'desk' || m.override_by) {
        note += '<div class="crm-small" title="' + esc('UC holds PC ' + pc2(m.uc_profile_class) + ', ' + (RATE[m.uc_registers] || m.uc_registers || 'no rate type') +
          (m.override_reason ? '. Why: ' + m.override_reason : '')) + '">checked by ' + esc(m.override_by || 'the desk') + (m.override_at ? ' ' + uk(m.override_at) : '') + '</div>';
      }
      if (m.pc_rule === 'check' || m.pc_rule === 'missing') {
        note += '<div class="crm-bad"><span class="pill p-fail">' + (m.pc_rule === 'missing' ? 'missing' : 'check') + '</span> ' + esc(m.pc_rule_reason || '') + '</div>';
      }
      return badge + pcTxt + note;
    }
    function svcCell(prov, until) {
      if (!prov) return '<span class="crm-small">none on file</span>';
      return '<div class="svc"><b>' + esc(prov) + '</b>' + (until ? '<div class="crm-small">' + (until < today() ? 'ended ' : 'to ') + uk(until) + '</div>' : '') + '</div>';
    }
    /** The correction editor, as a row under the meter's own row. The database applies the rule. */
    function openFix(tr, m, done) {
      var nx = tr.nextElementSibling;
      if (nx && nx.classList.contains('fixrow')) { nx.remove(); return; }
      var cols = tr.children.length;
      var pc = m.pc_effective != null ? m.pc_effective : m.profile_class;
      var row = doc.createElement('tr');
      row.className = 'fixrow';
      row.innerHTML = '<td colspan="' + cols + '"><div class="fixbox">' +
        '<div><label>Profile class</label><select data-f="pc">' + ['', 0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (x) {
          return '<option value="' + x + '"' + (String(x) === String(pc == null ? '' : pc) ? ' selected' : '') + '>' + (x === '' ? 'choose' : pc2(x) + (x === 0 ? ' half-hourly' : '')) + '</option>';
        }).join('') + '</select></div>' +
        '<div><label>Rate type</label><select data-f="reg">' + [''].concat(Object.keys(RATE)).map(function (x) {
          return '<option value="' + x + '"' + (x === (m.registers || '') ? ' selected' : '') + '>' + (x ? RATE[x] : 'choose') + '</option>';
        }).join('') + '</select></div>' +
        '<div style="flex:1;min-width:220px"><label>How you know</label><input data-f="why" placeholder="e.g. the bill top line shows 04, two registers"></div>' +
        '<div style="display:flex;gap:6px"><button class="act sm" data-f="save">Save</button>' +
        (m.override_by || m.pc_source === 'desk' ? '<button class="act ghost sm" data-f="undo">Back to UC&rsquo;s values</button>' : '') +
        '<button class="act ghost sm" data-f="cancel">Cancel</button></div></div>' +
        '<div data-f="msg" class="crm-small" style="margin-top:8px">The profile class is the first two digits of the MPAN top line; the rate type is how many registers the meter has. ' +
        'Kept on the desk: a UC import never overwrites it.</div></td>';
      tr.parentNode.insertBefore(row, tr.nextSibling);
      var $f = function (k) { return row.querySelector('[data-f="' + k + '"]'); };
      var msg = $f('msg');
      var check = function () {
        var p = $f('pc').value, r = $f('reg').value;
        var supply = p === '' ? m.supply_type : (Number(p) === 0 ? 'HH' : 'NHH');
        var verdict = pcRule(p === '' ? null : Number(p), r || null, supply, null);
        msg.innerHTML = verdict === 'ok' ? '<span style="color:var(--ok);font-weight:700">Those fit together.</span>'
          : '<span style="color:var(--fail);font-weight:700">' + esc(pcReason(p === '' ? null : Number(p), r || null, supply, null) || 'Pick both.') + '</span>';
        return verdict === 'ok';
      };
      $f('pc').addEventListener('change', check); $f('reg').addEventListener('change', check);
      $f('cancel').addEventListener('click', function () { row.remove(); });
      var send = function (p, r, why, btn) {
        btn.disabled = true;
        return q(sb.rpc('crm_meter_override_set', { p_uc_meter_id: m.uc_meter_id, p_profile_class: p, p_registers: r,
                                                     p_reason: why || null, p_by: who() || 'pricing desk' }), 'save')
          .then(function () { row.remove(); if (done) done(); })
          .catch(function (e) { btn.disabled = false; msg.innerHTML = '<span style="color:var(--fail);font-weight:700">' + esc(String(e.message).replace(/^save: /, '')) + '</span>'; });
      };
      $f('save').addEventListener('click', function () {
        if (!check()) return;
        send(Number($f('pc').value), $f('reg').value, $f('why').value.trim(), this);
      });
      if ($f('undo')) $f('undo').addEventListener('click', function () { send(null, null, null, this); });
    }

    // ---------------------------------------------------------------- portfolios
    // The landing view. CES, 4 Nov 2026: "I don't want a list of all customers with hundreds,
    // I want them split by portfolio." One tile per account manager as UC holds it on the
    // customer; the pools UC uses for unassigned business sit apart, and the portfolios of
    // people not on the team are folded away.
    //
    // "On the team" is pricing_team_v: the brokers with a sales portal login (pricing_managers)
    // plus account manager names added in Settings. Without that list, a book with 10 or more
    // live contracts counts.
    var POOLS = { 'Unassigned': 1, '. Opportunity': 1, 'Pool Open to Brokers': 1 };
    function pfName(am) { return am === '. Opportunity' ? 'Opportunity pool' : am; }
    function isMine(am) {
      var w = String(who() || '').trim().toLowerCase();
      if (!w || !am || POOLS[am]) return false;
      var a = String(am).toLowerCase();
      if (a === w) return true;
      // "Adam" on the desk is Adam Carter's portfolio; "Adam Smith" is not.
      return w.indexOf(' ') < 0 && a.split(' ')[0] === w;
    }
    function teamNames() {
      return Promise.resolve(sb.from('pricing_team_v').select('manager_name, active'))
        .then(function (r) {
          if (r && !r.error && r.data && r.data.length) return r.data.filter(function (x) { return x.active !== false; });
          // An older database without the view: the brokers with a login.
          return Promise.resolve(sb.from('pricing_managers').select('manager_name')).then(function (x) { return (x && !x.error && x.data) || []; });
        }, function () { return []; });
    }
    function renderPortfolios() {
      return Promise.all([q(sb.rpc('crm_portfolios'), 'portfolios'), q(sb.rpc('crm_overview'), 'overview'), teamNames()]).then(function (r) {
        var list = (r[0].data || []).slice(), o = r[1].data || {};
        S.overview = o; S.portfolios = list;
        var team = {};
        r[2].forEach(function (m) { if (m.manager_name) team[String(m.manager_name).trim().toLowerCase()] = 1; });
        var hasTeam = Object.keys(team).length > 0;
        var tdue = 0, tout = 0, tlive = 0, tcust = 0;
        list.forEach(function (p) {
          tdue += Number(p.renewals_90) || 0; tout += Number(p.out_of_contract) || 0;
          tlive += Number(p.live_contracts) || 0; tcust += Number(p.customers) || 0;
        });
        var big = function (p) {
          if (isMine(p.account_manager)) return true;
          return hasTeam ? !!team[String(p.account_manager || '').trim().toLowerCase()] : Number(p.live_contracts) >= 10;
        };
        var main = list.filter(function (p) { return !POOLS[p.account_manager] && big(p); }).sort(function (a, b) {
          return (isMine(b.account_manager) - isMine(a.account_manager)) || (Number(b.customers) - Number(a.customers));
        });
        var pools = list.filter(function (p) { return POOLS[p.account_manager]; });
        var other = list.filter(function (p) { return !POOLS[p.account_manager] && !big(p); }).sort(function (a, b) {
          return (Number(b.customers) + Number(b.leads)) - (Number(a.customers) + Number(a.leads));
        });
        function tile(p) {
          var due = Number(p.renewals_90) || 0, gap = Number(p.out_of_contract) || 0, leads = Number(p.leads) || 0;
          return '<button class="pf-tile' + (isMine(p.account_manager) ? ' me' : '') + '" data-am="' + esc(p.account_manager) + '">' +
            '<div class="n">' + esc(pfName(p.account_manager)) + (isMine(p.account_manager) ? ' <span class="pill p-ok">you</span>' : '') + '</div>' +
            '<div class="l"><b>' + n0(p.customers) + '</b> customer' + (Number(p.customers) === 1 ? '' : 's') +
            ' &middot; <b>' + n0(p.live_contracts) + '</b> live contract' + (Number(p.live_contracts) === 1 ? '' : 's') + '</div>' +
            '<div class="l' + (due ? ' due' : '') + '"><b>' + n0(due) + '</b> renewal' + (due === 1 ? '' : 's') + ' due in 90 days</div>' +
            (gap ? '<div class="l gap"><b>' + n0(gap) + '</b> meter' + (gap === 1 ? '' : 's') + ' with no contract</div>' : '') +
            (p.next_ced ? '<div class="l">Next contract end ' + uk(p.next_ced) + '</div>' : '') +
            (leads ? '<div class="l">' + n0(leads) + ' lead' + (leads === 1 ? '' : 's') + '</div>' : '') +
            '</button>';
        }
        body.innerHTML = '<div class="card">' +
          '<div class="pf-top"><div><h2>Portfolios</h2><div class="sub" style="margin-bottom:0">Every customer UtilityClick held, ' +
          'by account manager. Open one for its customers, renewals and meters.</div></div>' +
          '<div style="flex:1;min-width:260px;max-width:460px"><label for="pfQ">Find a customer in any portfolio</label>' +
          '<input id="pfQ" placeholder="Name, postcode, company number or MPAN"></div></div>' +
          '<div class="pf-strip"><span><b>' + n0(tcust) + '</b>customers</span><span><b>' + n0(tlive) + '</b>live contracts</span>' +
          '<span><b>' + n0(tdue) + '</b>renewals due in 90 days</span><span><b>' + n0(tout) + '</b>meters with no contract</span>' +
          (o.tenders ? '<span><b>' + n0(o.tenders.open) + '</b>open tenders</span>' : '') + '</div>' +
          '<div class="pf-grid">' + main.map(tile).join('') + '</div>' +
          (pools.length ? '<div class="pf-sub">Unassigned and pools</div><div class="pf-grid">' + pools.map(tile).join('') + '</div>' : '') +
          (other.length ? '<details style="margin-top:18px"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--text-2)">' +
            other.length + ' other portfolio' + (other.length === 1 ? '' : 's') + ' (people no longer on the team)</summary>' +
            '<div class="pf-grid" style="margin-top:10px">' + other.map(tile).join('') + '</div></details>' : '') +
          '</div>';
        [].forEach.call(body.querySelectorAll('.pf-tile'), function (b) {
          b.addEventListener('click', function () { openPortfolio(b.getAttribute('data-am')); });
        });
        var inp = body.querySelector('#pfQ');
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && inp.value.trim()) {
            S.cust = { page: 0, q: inp.value.trim(), status: 'all', am: '', sort: 'name' };
            go('customers');
          }
        });
      });
    }
    function openPortfolio(am) {
      // Open on what the portfolio actually holds: a leaver's book of only inactive customers,
      // or a pool of only leads, would otherwise open on "Nothing matched".
      var p = (S.portfolios || []).filter(function (x) { return x.account_manager === am; })[0] || {};
      var status = Number(p.customers) > 0 ? 'customers' : Number(p.leads) > 0 ? 'leads'
        : Number(p.inactive) > 0 ? 'inactive' : 'all';
      S.cust = { page: 0, q: '', status: status, am: am, sort: 'ced' };
      return go('customers');
    }

    // ---------------------------------------------------------------- overview
    function renderOverview() {
      return q(sb.rpc('crm_overview'), 'overview').then(function (r) {
        var o = r.data || {}; S.overview = o;
        var c = o.contracts || {}, iss = o.issues || {}, rd = o.renewals_due || {}, t = o.tenders || {};
        var li = o.last_import;
        function kpi(k, v, s, link, cls) {
          return '<div class="crm-kpi' + (link ? ' link' : '') + (cls ? ' ' + cls : '') + '"' + (link ? ' data-go="' + link + '"' : '') +
            '><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
        }
        body.innerHTML =
          '<div class="card"><h2>UtilityClick data on the desk</h2>' +
          '<div class="sub">Every customer, site, meter, contract and tender UC held. Whether a contract is live, ' +
          'upcoming or ended is worked out from its dates every time you look, so nothing here goes stale on its own. ' +
          (li ? 'Last import ' + uk(li.started_at) + (li.by_name ? ' (' + esc(li.by_name) + ')' : '') + ', ' + esc(li.status) + '.' : 'Nothing imported yet.') +
          '</div><div class="crm-kpis">' +
          kpi('Customers', n0(o.customers_active), n0(o.customers) + ' on file, ' + n0(o.customers - o.customers_active) + ' inactive', 'customers') +
          kpi('Leads', n0(o.leads), 'prospects with no CES contract', 'customers:leads') +
          kpi('Meters', n0(o.meters_active), n0(o.meters) + ' on file', null) +
          kpi('Live contracts', n0(c.live), n0(o.live_via_ces) + ' placed by CES, ' + n0(o.live_other_broker) + ' by others', 'contracts:live') +
          kpi('Upcoming', n0(c.upcoming), 'locked in, not started yet', 'contracts:upcoming') +
          kpi('No contract now', n0(o.out_of_contract), 'active meters whose last contract ended with nothing after it', 'quality:out', o.out_of_contract ? 'alert' : '') +
          kpi('Renewals due in 30 days', n0(rd.d30), n0(rd.d60) + ' in 60, ' + n0(rd.d90) + ' in 90, ' + n0(rd.d180) + ' in 180', 'contracts:due30') +
          kpi('Meter services', n0(c.service), 'MOP, DC / DA and other service contracts', 'services') +
          kpi('Open tenders', n0(t.open), n0(t.stale) + ' stale, ' + n0(t.lost) + ' lost', 'tenders') +
          kpi('Data problems', n0((iss.high || 0) + (iss.medium || 0)), n0(iss.high) + ' high, ' + n0(iss.medium) + ' medium', 'quality', iss.high ? 'alert' : '') +
          kpi('Ended contracts', n0(c.ended), 'history, kept for reference', 'contracts:ended') +
          '</div></div>';
        [].forEach.call(body.querySelectorAll('[data-go]'), function (el) {
          el.addEventListener('click', function () {
            var g = el.getAttribute('data-go').split(':');
            if (g[0] === 'customers') { S.cust = { page: 0, q: '', status: g[1] === 'leads' ? 'leads' : 'customers', am: '' }; return go('customers'); }
            if (g[0] === 'contracts') {
              S.k = { group: 'supply', tab: g[1] === 'due30' ? 'live' : g[1], page: 0, q: '', supplier: '', fuel: '', am: '', ces: '',
                      within: g[1] === 'due30' ? '30' : '', notRenewed: g[1] === 'due30', docs: '', kind: '', provider: '' };
              return go('contracts');
            }
            if (g[0] === 'quality') { S.iq = { sev: 'high', kind: g[1] === 'out' ? 'out_of_contract' : '', page: 0 }; return go('quality'); }
            return go(g[0]);
          });
        });
      });
    }

    // ---------------------------------------------------------------- customers
    function renderCustomers() {
      var f = S.cust;
      return lists().then(function (L) {
        var term = f.q.trim();
        var idsP = Promise.resolve(null);
        // MPANs are written with spaces ("19 0001 2345 678"), so test the term without them.
        var compact = term.replace(/\s/g, '');
        if (/^[0-9A-Za-z]{6,}$/.test(compact) && /\d{5}/.test(compact)) {
          // Looks like a meter number: find the customers who have it.
          idsP = q(sb.from('crm_meters').select('uc_customer_id').ilike('mpan', likeTerm(term.replace(/\s/g, ''))).limit(200), 'meter search')
            .then(function (r) { return (r.data || []).map(function (x) { return x.uc_customer_id; }); });
        }
        return idsP.then(function (ids) {
          var b = sb.from('crm_customers_v').select('uc_customer_id,name,is_lead,active,account_manager,meter_count,active_meter_count,live_contracts,next_ced,open_issues,registered_postcode,source', { count: 'exact' });
          if (ids) b = b.in('uc_customer_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
          else if (term) b = b.or('name.ilike.' + likeTerm(term) + ',registered_postcode.ilike.' + likeTerm(term) + ',company_reg_number.ilike.' + likeTerm(term));
          // not.is.false, not neq.false: neq drops a NULL, and a NULL here means "UC did not say".
          if (f.status === 'customers') b = b.eq('is_lead', false).not('active', 'is', false);
          else if (f.status === 'inactive') b = b.eq('is_lead', false).eq('active', false);
          else if (f.status === 'leads') b = b.eq('is_lead', true);
          if (f.am === 'Unassigned') b = b.or('account_manager.is.null,account_manager.eq.');
          else if (f.am) b = b.eq('account_manager', f.am);
          b = f.sort === 'ced' ? b.order('next_ced', { ascending: true, nullsFirst: false }).order('name') : b.order('name');
          return q(b.range(f.page * PAGE, f.page * PAGE + PAGE - 1), 'customer list');
        }).then(function (r) {
          var rows = r.data || [];
          var pf = f.am && S.portfolios ? S.portfolios.filter(function (p) { return p.account_manager === f.am; })[0] : null;
          var title = f.am ? 'Portfolio: ' + esc(pfName(f.am)) : (f.q ? 'Search' : 'Customers');
          var sel = function (id, label, list, value) {
            return '<select id="' + id + '" aria-label="' + label + '" title="' + label + '">' + list.map(function (o) {
              return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
          };
          body.innerHTML = '<div class="card fillcard"><div class="fc-head">' +
            '<button class="crm-back" id="crmPfBack">&larr; All portfolios</button>' +
            '<div class="fc-title pf-head"><h2>' + title + '</h2>' +
            (pf ? '<div class="pf-strip" style="margin:0"><span><b>' + n0(pf.customers) + '</b>customers</span><span><b>' + n0(pf.live_contracts) + '</b>live contracts</span>' +
              '<span><b>' + n0(pf.renewals_90) + '</b>renewals due in 90 days</span><span><b>' + n0(pf.out_of_contract) + '</b>meters with no contract</span>' +
              (Number(pf.leads) ? '<span><b>' + n0(pf.leads) + '</b>leads</span>' : '') + '</div>' : '') + '</div>' +
            '<div class="toolbar">' +
            '<input id="crmCq" class="tb-q" value="' + esc(f.q) + '" placeholder="' + (f.am ? 'Find in this portfolio' : 'Name, postcode, company number or MPAN') + '" aria-label="Search">' +
            sel('crmCs', 'Show', [['customers', 'Active customers'], ['inactive', 'Inactive customers'], ['leads', 'Leads'], ['all', 'Everyone']], f.status) +
            '<select id="crmCam" aria-label="Portfolio" title="Portfolio">' + options(L.ams.concat([{ account_manager: 'Unassigned' }]), f.am, 'All portfolios', 'account_manager') + '</select>' +
            sel('crmCso', 'Order', [['ced', 'Next contract end first'], ['name', 'By name']], f.sort || 'name') +
            '<button class="act" id="crmCgo">Search</button></div></div>' +
            (rows.length ? '<div class="grid"><table><thead><tr><th>Customer</th>' + (f.am ? '' : '<th>Account manager</th>') + '<th class="num">Meters</th>' +
              '<th class="num">Live contracts</th><th>Next contract end</th><th class="num">Problems</th><th>Status</th></tr></thead><tbody>' +
              rows.map(function (c) {
                var soon = c.next_ced && c.next_ced <= plusDays(today(), 90);
                return '<tr class="crm-click" data-c="' + esc(c.uc_customer_id) + '"><td class="crm-wrap">' + esc(c.name) +
                  (c.registered_postcode ? '<div class="crm-small">' + esc(c.registered_postcode) + '</div>' : '') + '</td>' +
                  // Inside one portfolio every row has the same account manager: no column for it.
                  (f.am ? '' : '<td>' + esc(c.account_manager || '') + '</td>') + '<td class="num">' + n0(c.active_meter_count) +
                  (c.meter_count !== c.active_meter_count ? '<span class="crm-small"> / ' + n0(c.meter_count) + '</span>' : '') + '</td>' +
                  '<td class="num">' + n0(c.live_contracts) + '</td><td>' + (c.next_ced ? (soon ? '<b>' + uk(c.next_ced) + '</b>' : uk(c.next_ced)) : '<span class="crm-small">none live</span>') + '</td>' +
                  '<td class="num">' + (c.open_issues ? '<span class="pill p-warn">' + n0(c.open_issues) + '</span>' : '') + '</td>' +
                  '<td>' + (c.is_lead ? '<span class="pill p-mute">Lead</span>' : c.active === false ? '<span class="pill p-mute">Inactive</span>' : '<span class="pill p-ok">Active</span>') +
                  (c.source === 'desk' ? ' <span class="pill p-warn" title="Added on the desk, not yet in UtilityClick">desk</span>' : '') + '</td></tr>';
              }).join('') + '</tbody></table></div><div class="fc-foot">' + pager(f.page, PAGE, r.count || 0) + '</div>'
              : '<div class="note">Nothing matched.</div>') + '</div>';
          var run = function () {
            f.q = body.querySelector('#crmCq').value; f.status = body.querySelector('#crmCs').value;
            f.am = body.querySelector('#crmCam').value; f.sort = body.querySelector('#crmCso').value; f.page = 0; go('customers');
          };
          body.querySelector('#crmCgo').addEventListener('click', run);
          body.querySelector('#crmCq').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
          body.querySelector('#crmCs').addEventListener('change', run);
          body.querySelector('#crmCam').addEventListener('change', run);
          body.querySelector('#crmCso').addEventListener('change', run);
          body.querySelector('#crmPfBack').addEventListener('click', function () { go('portfolios'); });
          wirePager(body, function (p) { f.page = p; go('customers'); });
          [].forEach.call(body.querySelectorAll('tr[data-c]'), function (tr) {
            tr.addEventListener('click', function () { go('customer', tr.getAttribute('data-c')); });
          });
        });
      });
    }

    // ---------------------------------------------------------------- one company
    // 6 Nov 2026: a company page. A header that says who they are and where their contracts
    // stand, then ONE tab at a time (it was eight cards stacked down one long page), the tab's
    // table filling the rest of the window. Every meter row carries the contract in force on it.
    var CTABS = [['sites', 'Sites and meters'], ['contracts', 'Supply contracts'], ['services', 'Meter services'],
                 ['contacts', 'Contacts'], ['tenders', 'Tenders'], ['notes', 'Notes'], ['reads', 'Readings'], ['problems', 'Problems']];
    function svcBoth(m) {
      if (m.fuel !== 'electricity') return '<span class="crm-small">&ndash;</span>';
      var one = function (label, prov, until) {
        return '<div class="svc"><span class="crm-small">' + label + '</span> ' + (prov ? '<b>' + esc(prov) + '</b>' +
          (until ? ' <span class="crm-small">' + (until < today() ? 'ended ' : 'to ') + uk(until) + '</span>' : '') : '<span class="crm-small">none on file</span>') + '</div>';
      };
      return one('MOP', m.mop_provider, m.mop_until) + one('DC/DA', m.dcda_provider, m.dcda_until);
    }
    function renderCustomer(id) {
      if (id && (!S.customer || S.customer.id !== id)) { S.customer = { id: id }; S.ctab = 'live'; S.cpage = 0; S.cview = 'sites'; }
      id = S.customer.id;
      return Promise.all([
        q(sb.from('crm_customers_v').select('*').eq('uc_customer_id', id).maybeSingle(), 'customer'),
        q(sb.from('crm_contacts').select('*').eq('uc_customer_id', id).is('uc_removed_at', null).order('primary_contact', { ascending: false }).order('last_name'), 'contacts'),
        q(sb.from('crm_meters_v').select('*').eq('uc_customer_id', id).order('site_name').order('mpan').range(0, 999), 'meters'),
        q(sb.from('crm_tenders_v').select('*').eq('uc_customer_id', id).order('contract_start', { ascending: false }).range(0, 199), 'tenders'),
        q(sb.from('crm_notes').select('*').eq('uc_customer_id', id).order('added_at', { ascending: false }).range(0, 199), 'notes'),
        q(sb.from('crm_meter_reads').select('*').eq('uc_customer_id', id).order('read_date', { ascending: false }).range(0, 199), 'readings'),
        q(sb.from('crm_issues').select('*').eq('uc_customer_id', id).is('cleared_at', null).is('resolved_at', null).order('severity').range(0, 199), 'problems'),
        q(sb.from('crm_contracts_v').select('*').eq('uc_customer_id', id).eq('is_service', true).order('meter_end', { ascending: false, nullsFirst: false }).range(0, 499), 'service contracts'),
        // The supply deals in force or lined up: the contract on each meter, and the on-file count.
        q(sb.from('crm_contracts_v').select('id,uc_tender_id,uc_customer_id,mpan,site_name,supplier,product,meter_start,meter_end,lifecycle,term_state,service_group,signed_docs,meter_deal_status')
          .eq('uc_customer_id', id).eq('service_group', 'supply').in('lifecycle', ['live', 'upcoming', 'pipeline'])
          .order('meter_start', { ascending: true, nullsFirst: false }).range(0, 999), 'contracts in force'),
        q(sb.from('crm_contracts_v').select('id', { count: 'exact', head: true }).eq('uc_customer_id', id).eq('service_group', 'supply'), 'contract count'),
      ]).then(function (r) {
        var c = r[0].data;
        if (!c) { body.innerHTML = '<div class="note bad">That company is not on the desk.</div>'; return; }
        var contacts = r[1].data || [], meters = r[2].data || [], tenders = r[3].data || [], notes = r[4].data || [], reads = r[5].data || [], issues = r[6].data || [];
        var services = r[7].data || [], cur = r[8].data || [], nSupply = r[9].count || 0;
        S.customer.name = c.name;
        if (opts.onCompany) { try { opts.onCompany({ id: id, name: c.name }); } catch (_) { /* the page's business */ } }

        // The contract on each meter: the one in force today (the latest to start, if two
        // overlap), else the locked-in one, else the next to start.
        var rank = function (z) { return z.lifecycle === 'live' ? 0 : z.lifecycle === 'pipeline' ? 1 : 2; };
        var byMpan = {};
        cur.forEach(function (k) {
          var x = byMpan[k.mpan];
          if (!x || rank(k) < rank(x) || (rank(k) === rank(x) && k.lifecycle === 'live')) byMpan[k.mpan] = k;
        });
        var deals = {};
        cur.forEach(function (k) { deals[k.uc_tender_id] = k; });
        var dealList = Object.keys(deals).map(function (t) { return deals[t]; });
        var onFile = dealList.filter(function (k) { return Number(k.signed_docs) > 0; }).length;
        var missing = dealList.length - onFile;
        var siteKeys = {};
        meters.forEach(function (m) { siteKeys[m.uc_site_id || ((m.site_name || '') + '|' + (m.postcode || ''))] = 1; });
        var nSites = Object.keys(siteKeys).length;

        var addr = function (a, pc) { return [a, pc].filter(Boolean).join(', '); };
        var facts = [
          c.account_manager ? 'Account manager <b>' + esc(c.account_manager) + '</b>' : 'No account manager',
          c.company_reg_number ? 'Company no. <b>' + esc(c.company_reg_number) + '</b>' : '',
          c.loa_status ? 'LOA <b>' + esc(c.loa_status) + '</b>' + (c.loa_end ? ' to ' + uk(c.loa_end) : '') : '',
          c.vat_status ? 'VAT ' + esc(c.vat_status) : '',
          c.legal_status ? esc(c.legal_status) : '',
          c.parent_name ? 'Part of <b>' + esc(c.parent_name) + '</b>' : '',
        ].filter(Boolean).join(' &middot; ');
        var where = addr(c.registered_address, c.registered_postcode);
        var comm = [c.preferred_nhh_commission && 'NHH ' + esc(c.preferred_nhh_commission), c.preferred_hh_commission && 'HH ' + esc(c.preferred_hh_commission),
                    c.preferred_gas_commission && 'Gas ' + esc(c.preferred_gas_commission)].filter(Boolean).join(', ');
        var stat = function (v, label, cls, attr) {
          var tag = attr ? 'button' : 'div';
          return '<' + tag + ' class="co-stat' + (cls ? ' ' + cls : '') + '"' + (attr || '') + '><b>' + v + '</b>' + label + '</' + tag + '>';
        };
        var counts = { sites: meters.length, contracts: nSupply, services: services.length, contacts: contacts.length, tenders: tenders.length,
                       notes: notes.length + (c.customer_notes ? 1 : 0), reads: reads.length, problems: issues.length };
        var tabs = CTABS.filter(function (t) { return t[0] === 'sites' || t[0] === 'contracts' || counts[t[0]] > 0; });
        if (!tabs.some(function (t) { return t[0] === S.cview; })) S.cview = 'sites';

        body.innerHTML = '<div class="card fillcard co">' +
          '<div class="fc-head">' +
          '<div class="co-head"><div style="min-width:0">' +
          '<h2 class="co-name">' + esc(c.name) + ' ' +
          (c.is_lead ? '<span class="pill p-mute">Lead</span>' : c.active === false ? '<span class="pill p-mute">Inactive</span>' : '<span class="pill p-ok">Active</span>') +
          (c.source === 'desk' ? ' <span class="pill p-warn" title="Added on the desk, not yet in UtilityClick">added on the desk</span>' : '') + '</h2>' +
          '<div class="co-facts">' + facts + (where ? '<br>' + esc(where) : '') + (comm ? ' &middot; Preferred commission ' + comm : '') + '</div>' +
          (c.customer_notes ? '<div class="sub clamp" style="margin:6px 0 0">' + esc(c.customer_notes) + '</div>' : '') +
          '</div><button class="crm-back" id="crmBack">&larr; Back</button></div>' +
          '<div class="co-stats">' +
          stat(n0(nSites), nSites === 1 ? 'site' : 'sites') +
          stat(n0(c.active_meter_count), 'active meter' + (Number(c.active_meter_count) === 1 ? '' : 's') + (c.meter_count !== c.active_meter_count ? ' of ' + n0(c.meter_count) : '')) +
          stat(n0(c.live_contracts), 'live contract' + (Number(c.live_contracts) === 1 ? '' : 's')) +
          stat(c.next_ced ? uk(c.next_ced) : 'none', 'next contract end') +
          (docs && dealList.length ? stat(n0(onFile) + ' of ' + n0(dealList.length), 'signed contracts on file') : '') +
          (docs && missing ? stat(n0(missing), 'with no contract uploaded &rarr;', 'warn', ' id="coMissing" title="Open them on No contract uploaded"') : '') +
          '</div>' +
          '<div class="co-tabs" id="coTabs" role="tablist">' + tabs.map(function (t) {
            var cls = (t[0] === S.cview ? 'on' : '') + (t[0] === 'problems' ? ' bad' : '');
            return '<button role="tab" data-ct="' + t[0] + '"' + (cls.trim() ? ' class="' + cls.trim() + '"' : '') +
              ' aria-selected="' + (t[0] === S.cview ? 'true' : 'false') + '">' + t[1] + '<span class="c">' + n0(counts[t[0]]) + '</span></button>';
          }).join('') + '</div></div>' +
          '<div class="co-body" id="crmCbody"></div></div>';

        body.querySelector('#crmBack').addEventListener('click', function () { go(S.back && S.back !== 'customer' ? S.back : 'portfolios'); });
        if (body.querySelector('#coMissing')) body.querySelector('#coMissing').addEventListener('click', function () {
          if (opts.openNoContract) opts.openNoContract(c.name);
          else { S.nc = { kind: '', state: '', am: '', q: c.name, sort: 'customer', page: 0 }; go('nocontract'); }
        });
        [].forEach.call(body.querySelectorAll('#coTabs [data-ct]'), function (b) {
          b.addEventListener('click', function () {
            S.cview = b.getAttribute('data-ct');
            [].forEach.call(body.querySelectorAll('#coTabs [data-ct]'), function (x) {
              x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false');
            });
            paintCompanyTab();
          });
        });

        S.customer.ctx = { c: c, contacts: contacts, meters: meters, tenders: tenders, notes: notes, reads: reads, issues: issues, services: services, byMpan: byMpan };
        return paintCompanyTab();
      });
    }

    function paintCompanyTab() {
      var box = body.querySelector('#crmCbody'), ctx = S.customer && S.customer.ctx;
      if (!box || !ctx) return Promise.resolve();
      var id = S.customer.id, c = ctx.c;
      var again = function () { go('customer', id, { keepScroll: true }); };
      var grid = function (inner) { return '<div class="grid">' + inner + '</div>'; };
      var v = S.cview;
      if (v === 'contracts') { box.innerHTML = ''; return customerContracts(id); }
      if (v === 'sites') {
        var meters = ctx.meters;
        var elec = meters.some(function (m) { return m.fuel === 'electricity'; });
        var pcFlags = meters.filter(function (m) { return m.pc_rule === 'check' || m.pc_rule === 'missing'; }).length;
        var dealRows = meters.map(function (m) { return ctx.byMpan[m.mpan] || null; });
        var cols = (docs ? 1 : 0) + 5 + (elec ? 1 : 0) + 1;
        var keyOf = function (x) { return x.uc_site_id || ((x.site_name || '') + '|' + (x.postcode || '')); };
        var lastSite = null, rows = [];
        meters.forEach(function (m, i) {
          var sk = keyOf(m);
          if (sk !== lastSite) {
            lastSite = sk;
            var n = meters.filter(function (x) { return keyOf(x) === sk; }).length;
            rows.push('<tr class="site-row"><td colspan="' + cols + '">' + esc(m.site_name || 'Site with no name') +
              '<span class="crm-small">' + esc([m.address_1, m.postcode].filter(Boolean).join(', ')) + (n > 1 ? ' &middot; ' + n + ' meters' : '') + '</span></td></tr>');
          }
          var state = m.contract_state === 'live' ? '<span class="pill p-ok">Live</span>'
            : m.contract_state === 'upcoming' ? '<span class="pill p-warn">Starts ' + uk(m.next_start) + '</span>'
            : m.contract_state === 'ended' ? '<span class="pill p-fail">Ended ' + uk(m.last_end) + '</span>'
            : '<span class="pill p-mute">No contract</span>';
          var priceable = (m.fuel === 'electricity' || m.fuel === 'gas') && m.mpan_valid;
          var fixable = m.fuel === 'electricity';
          var flagged = m.pc_rule === 'check' || m.pc_rule === 'missing';
          var endOn = m.cur_end || m.last_end;
          rows.push('<tr data-m="' + i + '">' + (docs ? (dealRows[i] ? docs.cell(dealRows[i], i) : '<td class="dc-cell"><span class="crm-small">no contract</span></td>') : '') +
            '<td class="nowrap"><span class="mono">' + esc(m.mpan) + '</span>' + (m.active === false ? '<div class="crm-small">meter inactive</div>' : '') + '</td>' +
            '<td>' + rateCell(m) + '</td>' +
            '<td>' + esc(m.cur_supplier || m.last_supplier || '') + (endOn ? '<div class="crm-small">' + (m.cur_end ? 'to ' : 'ended ') + uk(endOn) + '</div>' : '') +
            (m.cur_supplier && m.cur_via_ces === false ? '<div class="crm-small">not via CES</div>' : '') +
            (m.next_supplier ? '<div class="crm-small">then <b>' + esc(m.next_supplier) + '</b> from ' + uk(m.next_start) + '</div>' : '') + '</td>' +
            '<td>' + state + '</td>' +
            '<td class="num">' + n0(m.aq) + (m.aq_unit === 'm3' ? ' m&sup3;' : '') + '</td>' +
            (elec ? '<td>' + svcBoth(m) + '</td>' : '') +
            '<td class="nowrap">' + (priceable ? '<button class="act sm" data-price="' + i + '">Price</button> ' : '') +
            (fixable ? '<button class="act ' + (flagged ? '' : 'ghost ') + 'sm" data-fix="' + i + '">' + (flagged ? 'Fix' : 'Edit') + '</button>' : '') + '</td></tr>');
        });
        box.innerHTML = (pcFlags ? '<div class="note bad" style="margin:0 0 10px;padding:7px 12px">' + pcFlags + ' meter' + (pcFlags === 1 ? '' : 's') +
            ' with a profile class to check: press <b>Fix</b> on the row.</div>' : '') +
          (meters.length ? grid('<table id="crmMeters"><thead><tr>' + (docs ? '<th class="dc-cell">Contract</th>' : '') +
            '<th>MPAN / MPRN</th><th>Rate type</th><th>Supplier now</th><th>State</th><th class="num">AQ</th>' +
            (elec ? '<th>MOP and DC / DA</th>' : '') + '<th></th></tr></thead><tbody>' + rows.join('') + '</tbody></table>')
            : '<div class="note">No meters on file.</div>');
        [].forEach.call(box.querySelectorAll('[data-price]'), function (b) {
          b.addEventListener('click', function () {
            var m = meters[Number(b.getAttribute('data-price'))];
            if (opts.onPriceMeter) opts.onPriceMeter(Object.assign({}, m, { customer_name: c.name, account_manager: c.account_manager }));
          });
        });
        [].forEach.call(box.querySelectorAll('[data-fix]'), function (b) {
          b.addEventListener('click', function () { openFix(b.closest('tr'), meters[Number(b.getAttribute('data-fix'))], again); });
        });
        if (docs && box.querySelector('#crmMeters')) docs.wire(box.querySelector('#crmMeters'), dealRows, function () { docsChanged(); again(); });
        return Promise.resolve();
      }
      if (v === 'services') {
        var meterSvc = ctx.services.filter(function (k) { return k.service_group === 'meter_services'; });
        var otherSvc = ctx.services.filter(function (k) { return k.service_group !== 'meter_services'; });
        box.innerHTML = '<div class="grid">' +
          '<div class="crm-h3" style="margin:10px 10px 6px">Meter services (' + meterSvc.length + ')</div><div id="crmSvcM">' + serviceTable(meterSvc, false) + '</div>' +
          (otherSvc.length ? '<div class="crm-h3" style="margin:14px 10px 6px">Other services (' + otherSvc.length + ')</div><div id="crmSvcO">' + serviceTable(otherSvc, false) + '</div>' : '') +
          '</div>';
        if (docs) {
          docs.wire(box.querySelector('#crmSvcM'), meterSvc, function () { docsChanged(); again(); });
          if (box.querySelector('#crmSvcO')) docs.wire(box.querySelector('#crmSvcO'), otherSvc, function () { docsChanged(); again(); });
        }
        return Promise.resolve();
      }
      if (v === 'contacts') {
        box.innerHTML = grid('<table><thead><tr><th>Name</th><th>Job title</th><th>Phone</th><th>Mobile</th><th>Email</th><th></th></tr></thead><tbody>' +
          ctx.contacts.map(function (p) {
            return '<tr><td>' + esc([p.title && p.title !== 'Not Specified' ? p.title : '', p.first_name, p.last_name].filter(Boolean).join(' ')) + '</td><td>' + esc(p.job_title || '') + '</td>' +
              '<td class="mono">' + esc(p.telephone || '') + (p.telephone_ext ? ' x' + esc(p.telephone_ext) : '') + '</td><td class="mono">' + esc(p.mobile || '') + '</td>' +
              '<td class="crm-wrap">' + (p.email ? '<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' : '') + '</td>' +
              '<td>' + (p.primary_contact ? '<span class="pill p-ok">Primary</span> ' : '') + (p.tps ? '<span class="pill p-warn">TPS</span> ' : '') + (p.active === false ? '<span class="pill p-mute">Inactive</span>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>');
        return Promise.resolve();
      }
      if (v === 'tenders') {
        box.innerHTML = grid('<table><thead><tr><th>Ref</th><th>Utility</th><th>Wanted start</th><th>Status</th><th class="num">Meters</th><th class="num">Consumption</th><th>Account manager</th><th>Last updated</th></tr></thead><tbody>' +
          ctx.tenders.map(function (t) {
            return '<tr><td class="mono">' + esc(t.reference || '') + '</td><td>' + esc(t.utility || '') + '</td><td>' + uk(t.contract_start) + '</td>' +
              '<td>' + pill(LIFE, t.lifecycle) + '<div class="crm-small">' + esc(t.deal_status || '') + '</div></td><td class="num">' + n0(t.meters) + '</td>' +
              '<td class="num">' + n0(t.total_consumption) + '</td><td>' + esc(t.account_manager || '') + '</td><td>' + uk(t.uc_last_updated) + '</td></tr>';
          }).join('') + '</tbody></table>');
        return Promise.resolve();
      }
      if (v === 'notes') {
        box.innerHTML = '<div class="grid" style="padding:10px">' + (c.customer_notes ? '<div class="note" style="margin:0 0 8px;white-space:pre-wrap"><b>On the customer record</b><br>' + esc(c.customer_notes) + '</div>' : '') +
          ctx.notes.map(function (n) {
            return '<div class="note" style="margin:0 0 8px;white-space:pre-wrap"><b>' + uk(n.added_at) + '</b> ' + esc(n.added_by || '') +
              (n.linked_entity ? ' <span class="crm-small">on ' + esc(n.linked_to || '') + ' ' + esc(n.linked_entity) + '</span>' : '') + '<br>' + esc(n.note) + '</div>';
          }).join('') + '</div>';
        return Promise.resolve();
      }
      if (v === 'reads') {
        box.innerHTML = grid('<table><thead><tr><th>Date</th><th>MPAN / MPRN</th><th>Serial</th><th>Type</th><th class="num">Reading</th><th class="num">Day</th><th class="num">Night</th><th class="num">E/W</th></tr></thead><tbody>' +
          ctx.reads.map(function (x) {
            return '<tr><td>' + uk(x.read_date) + '</td><td class="mono">' + esc(x.mpan || '') + '</td><td class="mono">' + esc(x.serial || '') + '</td><td>' + esc(x.reading_type || '') + '</td>' +
              '<td class="num">' + n0(x.reading) + '</td><td class="num">' + n0(x.reading_day) + '</td><td class="num">' + n0(x.reading_night) + '</td><td class="num">' + n0(x.reading_ew) + '</td></tr>';
          }).join('') + '</tbody></table>');
        return Promise.resolve();
      }
      if (v === 'problems') {
        box.innerHTML = grid('<table><thead><tr><th>Severity</th><th>What</th><th>Meter</th><th>Detail</th></tr></thead><tbody>' +
          ctx.issues.map(function (i) { return '<tr><td>' + pill(SEV, i.severity) + '</td><td>' + esc(ISSUE_LABEL[i.kind] || i.kind) + '</td><td class="mono">' + esc(i.mpan || '') + '</td><td class="crm-wrap">' + esc(i.message) + '</td></tr>'; }).join('') +
          '</tbody></table>');
        return Promise.resolve();
      }
      return Promise.resolve();
    }

    function customerContracts(id) {
      var box = body.querySelector('#crmCbody');
      if (!box) return Promise.resolve();
      if (!box.querySelector('#crmClist')) {
        box.innerHTML = '<div class="crm-tabs" id="crmCtabs"></div><div class="grid" id="crmClist"><div class="note">Loading&hellip;</div></div><div class="fc-foot" id="crmCfoot"></div>';
      }
      var tabs = box.querySelector('#crmCtabs'), list = box.querySelector('#crmClist'), foot = box.querySelector('#crmCfoot');
      return Promise.all(CONTRACT_TABS.map(function (l) {
        return q(sb.from('crm_contracts_v').select('id', { count: 'exact', head: true }).eq('uc_customer_id', id).eq('service_group', 'supply').eq('lifecycle', l), 'contract count')
          .then(function (r) { return [l, r.count || 0]; });
      })).then(function (counts) {
        if (!counts.some(function (x) { return x[0] === S.ctab && x[1]; })) {
          var first = counts.find(function (x) { return x[1]; });
          if (first) S.ctab = first[0];
        }
        tabs.innerHTML = counts.map(function (x) {
          return '<button data-t="' + x[0] + '"' + (x[0] === S.ctab ? ' class="on"' : '') + '>' + LIFE[x[0]][0] + '<span class="c">' + n0(x[1]) + '</span></button>';
        }).join('');
        [].forEach.call(tabs.querySelectorAll('[data-t]'), function (b) {
          b.addEventListener('click', function () { S.ctab = b.getAttribute('data-t'); S.cpage = 0; customerContracts(id); });
        });
        var total = (counts.find(function (x) { return x[0] === S.ctab; }) || [0, 0])[1];
        return q(sb.from('crm_contracts_v').select('*').eq('uc_customer_id', id).eq('service_group', 'supply').eq('lifecycle', S.ctab)
          .order(S.ctab === 'ended' || S.ctab === 'lost' ? 'meter_end' : 'meter_start', { ascending: S.ctab === 'upcoming' })
          .range(S.cpage * BIG_PAGE, S.cpage * BIG_PAGE + BIG_PAGE - 1), 'contracts').then(function (r) {
          var rows = r.data || [];
          list.innerHTML = contractTable(rows, false);
          list.scrollTop = 0;
          foot.innerHTML = total > BIG_PAGE ? pager(S.cpage, BIG_PAGE, total) : '';
          wirePager(foot, function (p) { S.cpage = p; customerContracts(id); });
          if (docs) docs.wire(list, rows, function () { docsChanged(); customerContracts(id); });
        });
      });
    }

    // Each figure keeps its unit beside it (never broken apart); a narrow window wraps between
    // figures, not inside one. Capacity is per kVA per month, never per day.
    function ratesCell(k) {
      var lines = [], p3 = function (v) { return n2(v, 3); };
      var fig = function (s) { return '<span class="nowrap">' + s + '</span>'; };
      if (k.unit_rate_p_kwh != null) lines.push(fig(p3(k.unit_rate_p_kwh) + ' <span class="u">p/kWh</span>'));
      var dn = [];
      if (k.day_rate_p_kwh != null) dn.push('D ' + p3(k.day_rate_p_kwh));
      if (k.night_rate_p_kwh != null) dn.push('N ' + p3(k.night_rate_p_kwh));
      if (k.ew_rate_p_kwh != null) dn.push('E/W ' + p3(k.ew_rate_p_kwh));
      if (dn.length) lines.push(dn.map(function (x, j) { return fig(x + (j === dn.length - 1 ? ' <span class="u">p/kWh</span>' : '')); }).join(' &middot; '));
      if (k.water_rate_gbp_m3 != null) lines.push(fig('&pound;' + p3(k.water_rate_gbp_m3) + ' <span class="u">per m&sup3;</span>'));
      if (k.standing_charge_p_day != null) lines.push(fig('SC ' + n2(k.standing_charge_p_day, 2) + ' <span class="u">p/day</span>'));
      if (k.capacity_p_kva_month != null) lines.push(fig('Capacity ' + n2(k.capacity_p_kva_month, 2) + ' <span class="u">p/kVA/month</span>'));
      else if (k.capacity_raw) lines.push('<span title="The UC figure is not believable: see Data checks">capacity: check UC</span>');
      return lines.length ? '<div class="rates">' + lines.join('<br>') + '</div>' : '<span class="crm-small">none in UC</span>';
    }
    function docCell(k, i) { return docs ? docs.cell(k, i) : ''; }
    // Customer and site on two short lines; the site is cut with an ellipsis, in full on hover.
    function custCell(k) {
      return '<td class="crm-wrap"><button class="crm-link" data-cust="' + esc(k.uc_customer_id) + '">' + esc(k.customer_name || '') + '</button>' +
        (k.site_name ? '<span class="crm-small ell" title="' + esc(k.site_name) + '">' + esc(k.site_name) + '</span>' : '') + '</td>';
    }
    // Start and end on one line, the days left under it while it is live.
    function termCell(start, end, days, live) {
      return '<span class="nowrap">' + uk(start) + ' &ndash;</span> <span class="nowrap">' + uk(end) + '</span>' +
        (live && days != null ? '<div class="crm-small">' + (days === 0 ? 'ends today' : n0(days) + ' days left') + '</div>' : '');
    }
    // The status pill, and UC's own words only when they say something the pill does not.
    function statusCell(map, key, ucStatus) {
      var p = map[key] || [key || '', 'p-mute'];
      return pill(map, key) + (ucStatus && String(ucStatus).trim().toLowerCase() !== String(p[0]).toLowerCase()
        ? '<div class="crm-small">' + esc(ucStatus) + '</div>' : '');
    }

    /**
     * Supply contracts: eight columns, the signed contract first (6 Nov 2026; it was the 13th of
     * 13, past the right edge of the screen). Units stay on every figure: p/kWh, p/day, and
     * capacity in p/kVA/month, never per day.
     */
    function contractTable(rows, withCustomer) {
      if (!rows.length) return '<div class="note">None.</div>';
      return '<table><thead><tr>' + (docs ? '<th class="dc-cell">Contract</th>' : '') + (withCustomer ? '<th>Customer</th>' : '') +
        '<th>Meter</th><th>Supplier</th><th>Term</th><th>Status</th><th>Rates</th><th class="num c-opt">AQ and commission</th></tr></thead><tbody>' +
        rows.map(function (k, i) {
          return '<tr>' + docCell(k, i) + (withCustomer ? custCell(k) : '') +
            '<td class="nowrap"><span class="mono">' + esc(k.mpan) + '</span><div class="crm-small">' + esc(k.supply_type || k.utility || '') + '</div>' +
            (!withCustomer && k.site_name ? '<span class="crm-small ell" title="' + esc(k.site_name) + '">' + esc(k.site_name) + '</span>' : '') + '</td>' +
            '<td>' + esc(k.supplier || '') + '<span class="crm-small ell" style="max-width:140px" title="' + esc(k.product || '') + '">' + esc(k.product || '') + '</span>' +
            (k.via_ces === false ? '<div class="crm-small">not via CES</div>' : '') + '</td>' +
            '<td>' + termCell(k.meter_start, k.meter_end, k.days_to_end, k.lifecycle === 'live') + '</td>' +
            '<td>' + statusCell(LIFE, k.lifecycle, k.meter_deal_status) +
            (k.next_supplier ? '<div class="crm-small">then <b>' + esc(k.next_supplier) + '</b> ' + uk(k.next_start) + (k.next_status ? ', ' + esc(k.next_status) : '') + '</div>' : '') + '</td>' +
            '<td>' + ratesCell(k) + '</td>' +
            '<td class="num c-opt">' + n0(k.aq) + (k.aq != null ? ' <span class="crm-small">' + (k.aq_unit === 'm3' ? 'm&sup3;' : 'kWh') + '</span>' : '') +
            (k.commission_rate != null ? '<div class="crm-small">' + n2(k.commission_rate, 2) + ' ' + esc(k.commission_uom || '') + '</div>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    /** MOP, DC / DA and the other services: who provides it and for how long, not rates. */
    function serviceTable(rows, withCustomer) {
      if (!rows.length) return '<div class="note">None.</div>';
      return '<table><thead><tr>' + (docs ? '<th class="dc-cell">Contract</th>' : '') + (withCustomer ? '<th>Customer</th>' : '') +
        '<th>Meter</th><th>Service</th><th>Provider</th><th>Term</th><th>Status</th><th class="num">Charge</th></tr></thead><tbody>' +
        rows.map(function (k, i) {
          var days = k.days_to_end;
          var charge = k.standing_charge_p_day != null ? n2(k.standing_charge_p_day, 2) + '<div class="crm-small">p/day</div>'
            : k.total_contract_cost_gbp != null ? '&pound;' + n2(k.total_contract_cost_gbp, 2) + '<div class="crm-small">contract</div>' : '';
          return '<tr>' + docCell(k, i) + (withCustomer ? custCell(k) : '') +
            '<td class="nowrap"><span class="mono">' + esc(k.mpan) + '</span>' + (!withCustomer && k.site_name ? '<div class="crm-small" style="white-space:normal">' + esc(k.site_name) + '</div>' : '') + '</td>' +
            '<td><b>' + esc(KIND[k.service_kind] || k.service_kind || '') + '</b><div class="crm-small">' + esc(k.product || '') + '</div></td>' +
            '<td>' + (k.service_provider ? esc(k.service_provider) : '<span class="crm-small">not named in UC</span>') + '</td>' +
            '<td>' + termCell(k.meter_start, k.meter_end, days, k.term_state === 'live') + '</td>' +
            '<td>' + pill(LIFE, k.term_state) + '</td><td class="num">' + charge + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    // ---------------------------------------------------------------- contracts register
    // Three groups that never mix (CES, 4 Nov 2026: "clearly separate MOP/DCDA contracts from
    // utility contracts"): Supply by lifecycle; Meter services and Other services by their
    // dates, with the provider pulled out of UC's "Supplier X" product names.
    function contractQuery(f, head, tabOverride) {
      var tab = tabOverride || f.tab;
      var b = sb.from('crm_contracts_v').select(head ? 'id' : '*', head ? { count: 'exact', head: true } : { count: 'exact' });
      b = b.eq('service_group', f.group || 'supply');
      b = (f.group || 'supply') === 'supply' ? b.eq('lifecycle', tab) : b.eq('term_state', tab);
      if (f.supplier) b = b.eq('supplier', f.supplier);
      if (f.fuel) b = b.eq('fuel', f.fuel);
      if (f.am) b = b.eq('account_manager', f.am);
      if (f.kind) b = b.eq('service_kind', f.kind);
      if (f.provider) b = b.eq('service_provider', f.provider);
      if (f.ces === 'ces') b = b.eq('via_ces', true); else if (f.ces === 'other') b = b.eq('via_ces', false);
      if (f.within) b = b.gte('days_to_end', 0).lte('days_to_end', Number(f.within));
      if (f.notRenewed) b = b.is('next_supplier', null);
      if (f.docs === 'missing') b = b.eq('signed_docs', 0); else if (f.docs === 'on_file') b = b.gt('signed_docs', 0);
      var term = (f.q || '').trim();
      if (term) b = /\d{6,}/.test(term.replace(/\s/g, '')) ? b.ilike('mpan', likeTerm(term.replace(/\s/g, ''))) : b.or('customer_name.ilike.' + likeTerm(term) + ',site_name.ilike.' + likeTerm(term));
      return b;
    }
    function providers(group) {
      S.providers = S.providers || {};
      if (S.providers[group]) return Promise.resolve(S.providers[group]);
      return q(sb.from('crm_contracts_v').select('service_provider').eq('service_group', group).range(0, 999), 'providers').then(function (r) {
        var seen = {};
        (r.data || []).forEach(function (x) { if (x.service_provider) seen[x.service_provider] = (seen[x.service_provider] || 0) + 1; });
        return (S.providers[group] = Object.keys(seen).sort().map(function (p) { return { provider: p, n: seen[p] }; }));
      });
    }
    function renderContracts() {
      var f = S.k;
      var group = f.group || 'supply', supply = group === 'supply';
      var TABS = supply ? CONTRACT_TABS : SERVICE_TABS;
      if (TABS.indexOf(f.tab) < 0) f.tab = 'live';
      return Promise.all([lists(), supply ? Promise.resolve([]) : providers(group)]).then(function (pre) {
        var L = pre[0], provs = pre[1];
        var groupCounts = Promise.all(Object.keys(GROUPS).map(function (g) {
          return q(sb.from('crm_contracts_v').select('id', { count: 'exact', head: true }).eq('service_group', g)
            .eq(g === 'supply' ? 'lifecycle' : 'term_state', 'live'), 'group count').then(function (r) { return [g, r.count || 0]; });
        }));
        return Promise.all([groupCounts, Promise.all(TABS.map(function (l) {
          return q(contractQuery(f, true, l), 'count').then(function (r) { return [l, r.count || 0]; });
        }))]).then(function (cc) {
          var gcounts = cc[0], counts = cc[1];
          var order = f.tab === 'live' ? ['meter_end', true] : f.tab === 'upcoming' ? ['meter_start', true] : ['meter_end', false];
          return q(contractQuery(f, false).order(order[0], { ascending: order[1], nullsFirst: false }).range(f.page * BIG_PAGE, f.page * BIG_PAGE + BIG_PAGE - 1), 'contracts')
            .then(function (r) {
              var rows = r.data || [];
              var total = (counts.find(function (x) { return x[0] === f.tab; }) || [0, 0])[1];
              var more = !!(f.more || f.fuel || f.ces || f.notRenewed);
              // Filters on one row, labelled by their first option (6 Nov 2026: the labelled grid
              // of boxes took a third of a laptop screen before the first contract).
              var sel = function (id, label, list, value) {
                return '<select id="' + id + '" aria-label="' + label + '" title="' + label + '">' + list.map(function (o) {
                  return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
              };
              body.innerHTML = '<div class="card fillcard"><div class="fc-head">' +
                '<div class="fc-title"><h2>' + (group === 'meter_services' ? 'Meter services: MOP and DC / DA' : 'Contracts') + '</h2>' +
                '<div class="crm-seg" id="crmGroups" style="margin:0">' + gcounts.map(function (x) {
                  return '<button data-g="' + x[0] + '"' + (x[0] === group ? ' class="on"' : '') + '>' + GROUPS[x[0]] + '<span class="c">' + n0(x[1]) + ' live</span></button>';
                }).join('') + '</div>' +
                '<span class="fc-actions"><button class="act ghost sm" id="crmKx">Download (Excel)</button></span></div>' +
                '<div class="toolbar">' +
                '<input id="crmKq" class="tb-q" value="' + esc(f.q) + '" placeholder="Customer, site or MPAN" aria-label="Customer, site or MPAN">' +
                (supply
                  ? '<select id="crmKs" aria-label="Supplier" title="Supplier">' + options(L.suppliers, f.supplier, 'Any supplier', 'supplier') + '</select>'
                  : sel('crmKk', 'Service', [['', 'Any service']].concat(Object.keys(KIND).filter(function (k) {
                      return group === 'meter_services' ? ['mop', 'dcda', 'mop_dcda', 'data', 'metering_works', 'meter_services'].indexOf(k) >= 0
                        : ['compliance', 'green', 'water', 'solar', 'ces_service', 'consultancy', 'other'].indexOf(k) >= 0;
                    }).map(function (k) { return [k, KIND[k]]; })), f.kind) +
                    sel('crmKp', 'Provider', [['', 'Any provider']].concat(provs.map(function (p) { return [p.provider, p.provider]; })), f.provider)) +
                '<select id="crmKa" aria-label="Account manager" title="Account manager">' + options(L.ams, f.am, 'Any account manager', 'account_manager') + '</select>' +
                sel('crmKw', 'Ends within', [['', 'Ends any time'], ['30', 'Ends within 30 days'], ['60', 'Ends within 60 days'], ['90', 'Ends within 90 days'],
                  ['180', 'Ends within 6 months'], ['365', 'Ends within 12 months']], f.within) +
                (docs ? sel('crmKd', 'Signed contract', [['', 'Contract: either'], ['missing', 'Contract not on file'], ['on_file', 'Contract on file']], f.docs) : '') +
                // The filters used least sit behind "More filters", open whenever one is in use.
                (supply ? '<button type="button" class="tb-btn" id="crmKmore" aria-expanded="' + (more ? 'true' : 'false') + '">' + (more ? 'Fewer filters' : 'More filters') + '</button>' +
                  '<span class="tb-more' + (more ? '' : ' hide') + '" id="crmKmoreBox">' +
                  sel('crmKf', 'Fuel', [['', 'Any fuel'], ['electricity', 'Electricity'], ['gas', 'Gas'], ['water', 'Water']], f.fuel) +
                  sel('crmKc', 'Placed by', [['', 'Placed by anyone'], ['ces', 'Placed by CES'], ['other', 'Placed by someone else']], f.ces) +
                  '<label class="tb-check"><input type="checkbox" id="crmKn"' + (f.notRenewed ? ' checked' : '') + '> nothing lined up after it</label></span>' : '') +
                '<button class="act" id="crmKgo">Search</button></div>' +
                '<div class="crm-tabs">' + counts.map(function (x) { return '<button data-t="' + x[0] + '"' + (x[0] === f.tab ? ' class="on"' : '') + '>' + LIFE[x[0]][0] + '<span class="c">' + n0(x[1]) + '</span></button>'; }).join('') + '</div>' +
                '</div>' +
                '<div class="grid" id="crmKlist">' + (supply ? contractTable(rows, true) : serviceTable(rows, true)) + '</div>' +
                '<div class="fc-foot">' + pager(f.page, BIG_PAGE, total) + '<div id="crmKmsg"></div></div></div>';
              var val = function (id) { var e = body.querySelector('#' + id); return e ? e.value : ''; };
              var read = function () {
                f.q = val('crmKq'); f.supplier = supply ? val('crmKs') : ''; f.fuel = supply ? val('crmKf') : '';
                f.kind = supply ? '' : val('crmKk'); f.provider = supply ? '' : val('crmKp');
                f.am = val('crmKa'); f.ces = supply ? val('crmKc') : ''; f.within = val('crmKw'); f.docs = val('crmKd');
                f.notRenewed = supply && body.querySelector('#crmKn') ? body.querySelector('#crmKn').checked : false; f.page = 0;
              };
              var again = function () { go(group === 'meter_services' ? 'services' : 'contracts', null, { keepGroup: true }); };
              body.querySelector('#crmKgo').addEventListener('click', function () { read(); again(); });
              body.querySelector('#crmKq').addEventListener('keydown', function (e) { if (e.key === 'Enter') { read(); again(); } });
              // A pick in a filter applies at once: no Apply to remember.
              [].forEach.call(body.querySelectorAll('.toolbar select, .toolbar input[type=checkbox]'), function (s) {
                s.addEventListener('change', function () { read(); again(); });
              });
              body.querySelector('#crmKx').addEventListener('click', function () { read(); exportContracts(f, total); });
              if (body.querySelector('#crmKmore')) body.querySelector('#crmKmore').addEventListener('click', function () {
                var box = body.querySelector('#crmKmoreBox'), open = box.classList.toggle('hide') === false;
                f.more = open; this.textContent = open ? 'Fewer filters' : 'More filters'; this.setAttribute('aria-expanded', open ? 'true' : 'false');
              });
              [].forEach.call(body.querySelectorAll('#crmGroups [data-g]'), function (b) {
                b.addEventListener('click', function () {
                  var g = b.getAttribute('data-g');
                  S.k = { group: g, tab: 'live', page: 0, q: f.q, supplier: '', fuel: '', am: f.am, ces: '', within: '', notRenewed: false, docs: f.docs, kind: '', provider: '' };
                  go(g === 'meter_services' ? 'services' : 'contracts', null, { keepGroup: true });
                });
              });
              [].forEach.call(body.querySelectorAll('.crm-tabs [data-t]'), function (b) {
                b.addEventListener('click', function () { read(); f.tab = b.getAttribute('data-t'); again(); });
              });
              [].forEach.call(body.querySelectorAll('[data-cust]'), function (el) {
                el.addEventListener('click', function () { go('customer', el.getAttribute('data-cust')); });
              });
              wirePager(body, function (p) { f.page = p; again(); });
              if (docs) docs.wire(body.querySelector('#crmKlist'), rows, function () { docsChanged(); go(group === 'meter_services' ? 'services' : 'contracts', null, { keepScroll: true, keepGroup: true }); });
            });
        });
      });
    }

    function exportContracts(f, total) {
      var msg = body.querySelector('#crmKmsg');
      var X = opts.XLSX || root.XLSX;
      if (!X) { msg.innerHTML = '<div class="note bad">The spreadsheet library did not load.</div>'; return; }
      if (total > 30000) { msg.innerHTML = '<div class="note warn">That is ' + n0(total) + ' rows. Narrow the filters first.</div>'; return; }
      var rows = [], page = 0, size = 1000;
      msg.innerHTML = '<div class="note">Reading ' + n0(total) + ' rows&hellip;</div>';
      function next() {
        return q(contractQuery(f, false).order('id').range(page * size, page * size + size - 1), 'export').then(function (r) {
          rows = rows.concat(r.data || []);
          page++;
          if ((r.data || []).length === size && rows.length < total) return next();
        });
      }
      var supply = (f.group || 'supply') === 'supply';
      return next().then(function () {
        var out = rows.map(function (k) {
          return supply ? {
            Customer: k.customer_name, 'MPAN/MPRN': k.mpan, Fuel: k.fuel, Type: k.supply_type, Supplier: k.supplier, Product: k.product,
            'Contract start': k.meter_start, 'Contract end': k.meter_end, 'Days to end': k.days_to_end, Status: LIFE[k.lifecycle] ? LIFE[k.lifecycle][0] : k.lifecycle,
            'UC deal status': k.meter_deal_status, 'Placed by CES': k.via_ces ? 'Yes' : 'No', 'Next supplier': k.next_supplier, 'Next start': k.next_start,
            'AQ': k.aq, 'AQ unit': k.aq_unit, 'Unit rate p/kWh': k.unit_rate_p_kwh, 'Day p/kWh': k.day_rate_p_kwh, 'Night p/kWh': k.night_rate_p_kwh,
            'E/W p/kWh': k.ew_rate_p_kwh, 'Standing charge p/day': k.standing_charge_p_day, 'Capacity p/kVA/month': k.capacity_p_kva_month,
            'Commission': k.commission_rate, 'Commission unit': k.commission_uom, 'Account manager': k.account_manager, 'Site': k.site_name, 'UC reference': k.reference,
            'Signed contract on file': Number(k.signed_docs) ? 'Yes' : 'No',
          } : {
            Customer: k.customer_name, 'MPAN/MPRN': k.mpan, Service: KIND[k.service_kind] || k.service_kind, Provider: k.service_provider,
            'UC product': k.product, 'Start': k.meter_start, 'End': k.meter_end, 'Days to end': k.days_to_end,
            Status: LIFE[k.term_state] ? LIFE[k.term_state][0] : k.term_state, 'Standing charge p/day': k.standing_charge_p_day,
            'Account manager': k.account_manager, 'Site': k.site_name, 'UC reference': k.reference, 'Signed contract on file': Number(k.signed_docs) ? 'Yes' : 'No',
          };
        });
        var wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(out), supply ? 'Contracts' : 'Services');
        X.writeFile(wb, 'CES ' + (supply ? 'contracts' : GROUPS[f.group].toLowerCase()) + ' ' + (LIFE[f.tab] ? LIFE[f.tab][0] : f.tab) + ' ' + today() + '.xlsx');
        msg.innerHTML = '<div class="note good">' + n0(out.length) + ' rows downloaded.</div>';
      }).catch(function (e) { msg.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; });
    }

    // ---------------------------------------------------------------- signed contracts
    function renderDocuments() {
      if (!docs) { body.innerHTML = '<div class="note bad">The signed contracts module did not load (pricing-docs.js). Hold Shift and reload.</div>'; return Promise.resolve(); }
      return docs.renderLibrary(body, {
        openCustomer: function (id) { go('customer', id); },
        // The live contracts with nothing on file are their own page now (6 Nov 2026).
        openMissing: function () {
          if (opts.openNoContract) return opts.openNoContract('');
          S.nc = { kind: '', state: '', am: '', q: '', sort: 'customer', page: 0 };
          return go('nocontract');
        },
        onStored: function () { docsChanged(); },
      });
    }

    // ---------------------------------------------------------------- tenders
    function renderTenders() {
      var f = S.t;
      return lists().then(function (L) {
        var base = function (tab, head) {
          var b = sb.from('crm_tenders_v').select(head ? 'uc_tender_id' : '*', head ? { count: 'exact', head: true } : { count: 'exact' }).eq('lifecycle', tab);
          if (f.am) b = b.eq('account_manager', f.am);
          if (f.q.trim()) b = b.or('customer_name.ilike.' + likeTerm(f.q) + ',reference.ilike.' + likeTerm(f.q));
          return b;
        };
        return Promise.all(TENDER_TABS.map(function (l) { return q(base(l, true), 'count').then(function (r) { return [l, r.count || 0]; }); }))
          .then(function (counts) {
            return q(base(f.tab, false).order('contract_start', { ascending: f.tab === 'open', nullsFirst: false }).range(f.page * BIG_PAGE, f.page * BIG_PAGE + BIG_PAGE - 1), 'tenders')
              .then(function (r) {
                var rows = r.data || [], total = (counts.find(function (x) { return x[0] === f.tab; }) || [0, 0])[1];
                body.innerHTML = '<div class="card fillcard"><div class="fc-head"><div class="fc-title"><h2>Tenders</h2></div>' +
                  '<div class="sub">UC&rsquo;s opportunities that never became a contract row. ' +
                  'Most of the open ones are UC&rsquo;s automatic renewal backlog for 2027 to 2032. Stale means open but the wanted start date is more than 30 days gone.</div>' +
                  '<div class="toolbar"><input id="crmTq" class="tb-q" value="' + esc(f.q) + '" placeholder="Customer or reference" aria-label="Customer or reference">' +
                  '<select id="crmTa" aria-label="Account manager" title="Account manager">' + options(L.ams, f.am, 'Any account manager', 'account_manager') + '</select>' +
                  '<button class="act" id="crmTgo">Search</button></div>' +
                  '<div class="crm-tabs">' + counts.map(function (x) { return '<button data-t="' + x[0] + '"' + (x[0] === f.tab ? ' class="on"' : '') + '>' + LIFE[x[0]][0] + '<span class="c">' + n0(x[1]) + '</span></button>'; }).join('') + '</div></div>' +
                  (rows.length ? '<div class="grid"><table><thead><tr><th>Customer</th><th>Ref</th><th>Utility</th><th>Wanted start</th><th>UC status</th><th class="num">Days at status</th><th class="num">Meters</th><th class="num c-opt">Consumption</th><th>Account manager</th><th class="c-opt">Last updated</th></tr></thead><tbody>' +
                    rows.map(function (t) {
                      return '<tr><td class="crm-wrap crm-click" data-cust="' + esc(t.uc_customer_id || '') + '">' + esc(t.customer_name || '') + '</td><td class="mono">' + esc(t.reference || '') + '</td>' +
                        '<td>' + esc(t.utility || '') + '</td><td>' + uk(t.contract_start) + '</td><td>' + esc(t.deal_status || '') + (t.reason_for_loss ? '<div class="crm-small">' + esc(t.reason_for_loss) + '</div>' : '') + '</td>' +
                        '<td class="num">' + n0(t.days_at_status) + '</td><td class="num">' + n0(t.meters) + '</td><td class="num c-opt">' + n0(t.total_consumption) + '</td>' +
                        '<td>' + esc(t.account_manager || '') + '</td><td class="c-opt">' + uk(t.uc_last_updated) + '</td></tr>';
                    }).join('') + '</tbody></table></div><div class="fc-foot">' + pager(f.page, BIG_PAGE, total) + '</div>' : '<div class="note">None.</div>') + '</div>';
                var run = function () { f.q = body.querySelector('#crmTq').value; f.am = body.querySelector('#crmTa').value; f.page = 0; go('tenders'); };
                body.querySelector('#crmTgo').addEventListener('click', run);
                body.querySelector('#crmTq').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
                body.querySelector('#crmTa').addEventListener('change', run);
                [].forEach.call(body.querySelectorAll('.crm-tabs [data-t]'), function (b) { b.addEventListener('click', function () { f.tab = b.getAttribute('data-t'); f.page = 0; go('tenders'); }); });
                [].forEach.call(body.querySelectorAll('[data-cust]'), function (td) { if (td.getAttribute('data-cust')) td.addEventListener('click', function () { go('customer', td.getAttribute('data-cust')); }); });
                wirePager(body, function (p) { f.page = p; go('tenders'); });
              });
          });
      });
    }

    // ---------------------------------------------------------------- data checks
    function pcQuery(head) {
      return sb.from('crm_meters_v').select(head ? 'uc_meter_id' : '*', head ? { count: 'exact', head: true } : { count: 'exact' }).in('pc_rule', ['check', 'missing']);
    }
    function renderQuality() {
      var f = S.iq;
      var base = function (sev, head) {
        var b = sb.from('crm_issues').select(head ? 'id' : '*', head ? { count: 'exact', head: true } : { count: 'exact' })
          .is('cleared_at', null).is('resolved_at', null);
        if (sev) b = b.eq('severity', sev);
        if (f.kind) b = b.eq('kind', f.kind);
        return b;
      };
      return Promise.all(['high', 'medium', 'low', 'info'].map(function (s) { return q(base(s, true), 'count').then(function (r) { return [s, r.count || 0]; }); })
        .concat([q(pcQuery(true), 'profile class count').then(function (r) { return ['pc', r.count || 0]; })]))
        .then(function (counts) {
          var total = (counts.find(function (x) { return x[0] === f.sev; }) || [0, 0])[1];
          var head = '<div class="card fillcard"><div class="fc-head"><div class="fc-title"><h2>Data checks</h2></div>' +
            '<div class="sub">What the import found wrong or worth a look in the UC data. ' +
            'High: an active meter whose last contract ended with nothing after it (out of contract, or renewed without CES and UC was never told), a gap you are in right now, ' +
            'or a contract that ends before it starts. Profile class: an electricity meter whose profile class and rate type contradict each other, or that has none. ' +
            'Each one is re-checked on every import; mark one done (or fix it) when you have dealt with it.</div>' +
            (f.sev === 'pc' ? '' : '<div class="toolbar"><select id="crmIk" aria-label="What" title="What"><option value="">Every kind of problem</option>' +
              Object.keys(ISSUE_LABEL).map(function (k) { return '<option value="' + k + '"' + (k === f.kind ? ' selected' : '') + '>' + ISSUE_LABEL[k] + '</option>'; }).join('') + '</select></div>') +
            '<div class="crm-tabs">' + counts.map(function (x) { return '<button data-s="' + x[0] + '"' + (x[0] === f.sev ? ' class="on"' : '') + '>' + SEV[x[0]][0] + '<span class="c">' + n0(x[1]) + '</span></button>'; }).join('') + '</div></div>';
          var wireTabs = function () {
            [].forEach.call(body.querySelectorAll('.crm-tabs [data-s]'), function (b) { b.addEventListener('click', function () { f.sev = b.getAttribute('data-s'); f.page = 0; go('quality'); }); });
            [].forEach.call(body.querySelectorAll('[data-cust]'), function (td) { if (td.getAttribute('data-cust')) td.addEventListener('click', function () { go('customer', td.getAttribute('data-cust')); }); });
            if (body.querySelector('#crmIk')) body.querySelector('#crmIk').addEventListener('change', function () { f.kind = this.value; f.page = 0; go('quality'); });
            wirePager(body, function (p) { f.page = p; go('quality'); });
          };
          if (f.sev === 'pc') {
            return q(pcQuery(false).order('customer_name').order('mpan').range(f.page * BIG_PAGE, f.page * BIG_PAGE + BIG_PAGE - 1), 'profile class checks').then(function (r) {
              var rows = r.data || [];
              body.innerHTML = head + (rows.length ? '<div class="grid"><table><thead><tr><th>Customer</th><th>MPAN</th><th>Site</th><th>Rate type and profile class</th><th>UC says</th><th></th></tr></thead><tbody>' +
                rows.map(function (m, i) {
                  return '<tr><td class="crm-wrap crm-click" data-cust="' + esc(m.uc_customer_id) + '">' + esc(m.customer_name || '') + '</td>' +
                    '<td class="mono">' + esc(m.mpan) + '</td><td class="crm-wrap">' + esc(m.site_name || '') + '<div class="crm-small">' + esc(m.postcode || '') + '</div></td>' +
                    '<td>' + rateCell(m) + '</td><td class="crm-small">' + esc(m.supply_type || '') + (m.meter_type ? ', ' + esc(m.meter_type) : '') +
                    (m.measurement_class ? '<br>' + esc(m.measurement_class) : '') + '</td>' +
                    '<td><button class="act sm" data-fix="' + i + '">Fix</button></td></tr>';
                }).join('') + '</tbody></table></div><div class="fc-foot">' + pager(f.page, BIG_PAGE, total) + '</div>' : '<div class="note good">Every electricity meter&rsquo;s profile class fits its rate type.</div>') + '</div>';
              wireTabs();
              [].forEach.call(body.querySelectorAll('[data-fix]'), function (b) {
                b.addEventListener('click', function () {
                  openFix(b.closest('tr'), rows[Number(b.getAttribute('data-fix'))], function () { go('quality', null, { keepScroll: true }); });
                });
              });
            });
          }
          return q(base(f.sev, false).order('kind').order('customer_name').range(f.page * BIG_PAGE, f.page * BIG_PAGE + BIG_PAGE - 1), 'problems').then(function (r) {
            var rows = r.data || [];
            body.innerHTML = head +
              (rows.length ? '<div class="grid"><table><thead><tr><th></th><th>What</th><th>Customer</th><th>MPAN / MPRN</th><th>Detail</th><th class="c-opt">Found</th></tr></thead><tbody>' +
                rows.map(function (i, ix) {
                  return '<tr><td class="nowrap"><button class="act ghost sm" data-res="' + ix + '">Done</button></td><td>' + esc(ISSUE_LABEL[i.kind] || i.kind) + '</td>' +
                    '<td class="crm-wrap crm-click" data-cust="' + esc(i.uc_customer_id || '') + '">' + esc(i.customer_name || '') + '</td>' +
                    '<td class="mono">' + esc(i.mpan || '') + '</td><td class="crm-wrap">' + esc(i.message) + '</td><td class="c-opt">' + uk(i.first_seen_at) + '</td></tr>';
                }).join('') + '</tbody></table></div><div class="fc-foot">' + pager(f.page, BIG_PAGE, total) + '</div>' : '<div class="note good">Nothing here.</div>') + '</div>';
            wireTabs();
            [].forEach.call(body.querySelectorAll('[data-res]'), function (b) {
              b.addEventListener('click', function () {
                var i = rows[Number(b.getAttribute('data-res'))];
                var note = root.prompt ? root.prompt('What was done about it? (optional)', '') : '';
                if (note === null) return;
                b.disabled = true;
                q(sb.from('crm_issues').update({ resolved_at: new Date().toISOString(), resolved_by: who() || 'pricing desk', resolution_note: note || null }).eq('id', i.id).select('id'), 'mark done')
                  .then(function (res) {
                    if (!res.data || !res.data.length) throw new Error('mark done: nothing was saved (permissions?)');
                    go('quality', null, { keepScroll: true });     // working down a list: stay put
                  }).catch(function (e) { b.disabled = false; fail(e); });
              });
            });
          });
        });
    }

    // ---------------------------------------------------------------- no contract uploaded
    // CES, 6 Nov 2026: "a page called No contract uploaded, where we can see all the sites we
    // have with no contract". From crm_no_contract() (_61b): the deals CES placed that are live,
    // starting later, or locked in and not live yet, with no signed contract on the desk. One
    // row per contract as it was signed (customer, supplier, start date, kind), with every site
    // and meter it covers: one Upload on the row attaches the PDF to all of them.
    var NC_KINDS = [['', 'All'], ['electricity', 'Electricity'], ['gas', 'Gas'], ['water', 'Water'],
                    ['meter_services', 'Meter services'], ['other_services', 'Other services']];
    var NC_STATE = { live: ['Live', 'p-ok'], upcoming: ['Starts later', 'p-warn'], pipeline: ['Locked in, not live', 'p-warn'] };
    var NC_PAGE = 100;
    function ncArgs(f, limit, offset) {
      return { p_kind: f.kind || null, p_state: f.state || null, p_am: f.am || null, p_q: (f.q || '').trim() || null,
               p_sort: f.sort || 'customer', p_limit: limit, p_offset: offset };
    }
    function renderNoContract() {
      var f = S.nc;
      return Promise.all([lists(), q(sb.rpc('crm_no_contract', ncArgs(f, NC_PAGE, f.page * NC_PAGE)), 'no contract list')]).then(function (r) {
        var L = r[0], d = r[1].data || {};
        var groups = d.groups || [], tot = d.total || {}, kinds = d.kinds || {}, states = d.states || {};
        var allKinds = Object.keys(kinds).reduce(function (a, k) { return a + (Number(kinds[k]) || 0); }, 0);
        var sel = function (id, label, list, value) {
          return '<select id="' + id + '" aria-label="' + label + '" title="' + label + '">' + list.map(function (o) {
            return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
        };
        // The deal the Upload button stands on: the group's first, which is all the sibling
        // picker needs (customer, supplier, start date, kind) to tick every meter signed with it.
        var rows = groups.map(function (g) {
          var first = (g.rows || [])[0] || {};
          return { uc_tender_id: first.t, mpan: first.m, uc_customer_id: g.uc_customer_id, supplier: g.supplier, meter_start: g.meter_start,
                   service_group: g.service_group, signed_docs: 0, customer_name: g.customer_name };
        });
        var meterLine = function (x) {
          return '<div><span class="mono">' + esc(x.m) + '</span> ' + esc(x.s || '') + (x.f && x.f !== 'electricity' && x.f !== 'gas' ? ' <span class="crm-small">' + esc(x.f) + '</span>' : '') + '</div>';
        };
        var table = groups.length ? '<table id="ncTable"><thead><tr>' + (docs ? '<th class="dc-cell">Contract</th>' : '') +
          '<th>Customer</th><th>Supplier</th><th>Sites and meters</th><th>Term</th><th>Status</th></tr></thead><tbody>' +
          groups.map(function (g, i) {
            var list = g.rows || [], shown = list.slice(0, 2);
            var what = g.service_group === 'supply' ? (g.product || '') : (KIND[g.service_kind] || g.service_kind || '') + (g.product ? ', ' + g.product : '');
            var st = NC_STATE[g.state] || [g.state, 'p-mute'];
            var ucs = {};
            list.forEach(function (x) { if (x.u) ucs[x.u] = 1; });
            return '<tr data-g="' + i + '">' + (docs ? docs.cell(rows[i], i) : '') +
              '<td class="crm-wrap"><button class="crm-link" data-cust="' + esc(g.uc_customer_id) + '">' + esc(g.customer_name || '') + '</button>' +
              (g.account_manager ? '<div class="crm-small">' + esc(g.account_manager) + '</div>' : '') + '</td>' +
              '<td>' + esc(g.service_group === 'supply' ? (g.supplier || '') : (g.service_provider || g.supplier || '')) + '<div class="crm-small">' + esc(what) + '</div></td>' +
              '<td class="nc-meters">' + (Number(g.meters) > 1 ? '<b>' + n0(g.meters) + ' meters</b>' +
                (Number(g.sites) > 1 ? ' <span class="crm-small">at ' + n0(g.sites) + ' sites</span>' : '') : '') +
              shown.map(meterLine).join('') +
              (list.length > 2 ? '<div class="nc-rest hide">' + list.slice(2).map(meterLine).join('') + '</div>' +
                '<button class="nc-more" data-more="' + i + '">and ' + (list.length - 2) + ' more</button>' : '') + '</td>' +
              '<td>' + termCell(g.meter_start, g.meter_end, g.days_to_end, g.state === 'live') + '</td>' +
              '<td><span class="pill ' + st[1] + '">' + (g.state === 'upcoming' ? 'Starts ' + uk(g.meter_start) : st[0]) + '</span>' +
              (Object.keys(ucs).filter(function (u) { return u.toLowerCase() !== 'live'; }).length
                ? '<div class="crm-small">' + esc(Object.keys(ucs).join(', ')) + '</div>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>'
          : '<div class="note good" style="margin:10px">' + (f.q || f.kind || f.state || f.am ? 'Nothing matches those filters.' : 'Every live contract has its signed contract on the desk.') + '</div>';

        // The page title is in the bar above (the section's name), so the card starts with the count.
        body.innerHTML = '<div class="card fillcard nc"><div class="fc-head">' +
          '<div class="fc-title"><span class="fc-count" id="ncCount"><b>' + n0(tot.deals) + '</b> meter contract' + (Number(tot.deals) === 1 ? '' : 's') +
          ' (' + n0(tot.groups) + ' signed contract' + (Number(tot.groups) === 1 ? '' : 's') + ') at <b>' + n0(tot.customers) + '</b> customer' + (Number(tot.customers) === 1 ? '' : 's') + ' with no signed contract on the desk</span>' +
          '<span class="fc-actions"><button class="act ghost sm" id="ncX">Download (Excel)</button></span></div>' +
          '<div class="sub">Live, starting later, or locked in and not live yet; placed by CES. Upload the signed contract on a row and it covers every meter signed with it; the row then leaves this list.</div>' +
          '<div class="crm-seg" id="ncKinds" style="margin:0 0 10px">' + NC_KINDS.map(function (k) {
            var n = k[0] ? (Number(kinds[k[0]]) || 0) : allKinds;
            return '<button data-k="' + k[0] + '"' + (k[0] === (f.kind || '') ? ' class="on"' : '') + '>' + k[1] + '<span class="c">' + n0(n) + '</span></button>';
          }).join('') + '</div>' +
          '<div class="toolbar">' +
          '<input id="ncQ" class="tb-q" value="' + esc(f.q) + '" placeholder="Customer, site, supplier or MPAN" aria-label="Customer, site, supplier or MPAN">' +
          sel('ncState', 'Status', [['', 'Any status'], ['live', 'Live (' + n0(states.live || 0) + ')'], ['upcoming', 'Starts later (' + n0(states.upcoming || 0) + ')'],
                                    ['pipeline', 'Locked in, not live (' + n0(states.pipeline || 0) + ')']], f.state) +
          '<select id="ncAm" aria-label="Account manager" title="Account manager">' + options(L.ams, f.am, 'Any account manager', 'account_manager') + '</select>' +
          sel('ncSort', 'Order', [['customer', 'Customer A to Z'], ['ending', 'Ending soonest'], ['newest', 'Newest start first'], ['meters', 'Most meters first']], f.sort) +
          '<button class="act" id="ncGo">Search</button></div></div>' +
          '<div class="grid" id="ncList">' + table + '</div>' +
          '<div class="fc-foot">' + (Number(tot.groups) > NC_PAGE ? pager(f.page, NC_PAGE, Number(tot.groups) || 0) : '') + '<div id="ncMsg"></div></div></div>';

        var again = function (keep) { go('nocontract', null, keep ? { keepScroll: true } : null); };
        var read = function () {
          f.q = body.querySelector('#ncQ').value; f.state = body.querySelector('#ncState').value;
          f.am = body.querySelector('#ncAm').value; f.sort = body.querySelector('#ncSort').value; f.page = 0;
        };
        body.querySelector('#ncGo').addEventListener('click', function () { read(); again(); });
        body.querySelector('#ncQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { read(); again(); } });
        [].forEach.call(body.querySelectorAll('.toolbar select'), function (s) { s.addEventListener('change', function () { read(); again(); }); });
        [].forEach.call(body.querySelectorAll('#ncKinds [data-k]'), function (b) {
          b.addEventListener('click', function () { read(); f.kind = b.getAttribute('data-k'); again(); });
        });
        [].forEach.call(body.querySelectorAll('[data-more]'), function (b) {
          b.addEventListener('click', function () {
            var rest = b.previousElementSibling;
            var open = rest.classList.toggle('hide') === false;
            b.textContent = open ? 'show fewer' : 'and ' + rest.children.length + ' more';
          });
        });
        [].forEach.call(body.querySelectorAll('[data-cust]'), function (el) {
          el.addEventListener('click', function () { go('customer', el.getAttribute('data-cust')); });
        });
        wirePager(body, function (p) { f.page = p; again(); });
        body.querySelector('#ncX').addEventListener('click', function () { read(); exportNoContract(f); });
        if (docs && body.querySelector('#ncTable')) docs.wire(body.querySelector('#ncTable'), rows, function () { docsChanged(); again(true); });
      });
    }

    /** Every row of the current filter, one line per meter, for someone to work through. */
    function exportNoContract(f) {
      var msg = body.querySelector('#ncMsg');
      var X = opts.XLSX || root.XLSX;
      if (!X) { msg.innerHTML = '<div class="note bad">The spreadsheet library did not load.</div>'; return Promise.resolve(); }
      var out = [], page = 0, size = 500;
      msg.innerHTML = '<span class="crm-small">Reading&hellip;</span>';
      function next() {
        return q(sb.rpc('crm_no_contract', ncArgs(f, size, page * size)), 'export').then(function (r) {
          var d = r.data || {}, gs = d.groups || [];
          gs.forEach(function (g) {
            (g.rows || []).forEach(function (x) {
              out.push({ Customer: g.customer_name, 'Account manager': g.account_manager, Kind: g.service_group === 'supply' ? (x.f || '') : (GROUPS[g.service_group] || g.service_group),
                Supplier: g.service_group === 'supply' ? g.supplier : (g.service_provider || g.supplier), Product: g.product,
                'Contract start': g.meter_start, 'Contract end': g.meter_end, Status: (NC_STATE[x.st] || [x.st])[0], 'UC deal status': x.u,
                'MPAN/MPRN': x.m, Site: x.s });
            });
          });
          page++;
          if (gs.length === size) return next();
        });
      }
      return next().then(function () {
        var wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(out), 'No contract uploaded');
        X.writeFile(wb, 'CES no contract uploaded ' + today() + '.xlsx');
        msg.innerHTML = '<span class="crm-small">' + n0(out.length) + ' meters downloaded.</span>';
      }).catch(function (e) { msg.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; });
    }

    // ---------------------------------------------------------------- import
    var KIND_LABEL = { contracts: 'Contract Export', portfolio: 'Portfolio Export', customers: 'Customer Export', contacts: 'Contact Export',
                       tenders: 'Tender Export', notes: 'Change Log Note Export', reads: 'Meter Readings Export' };
    function renderImport() {
      return q(sb.from('crm_import_runs').select('*').order('started_at', { ascending: false }).limit(10), 'import history').then(function (r) {
        var runs = r.data || [];
        body.innerHTML = '<div class="card"><h2>Import from UtilityClick</h2><div class="sub">Export the seven UC reports (Contract, Portfolio, Customer, Contact, ' +
          'Tender, Change Log Note, Meter Readings) and drop all seven here together. They are cleaned in this browser with the same rules as the first load, ' +
          'you see the counts and the problems found, and only then is anything written. Records UC no longer exports are marked removed, never deleted; ' +
          'customers added on the desk and profile class corrections are never touched. ' +
          'All seven are needed because a partial set would blank the fields the missing reports carry.</div>' +
          '<div class="crm-drop" id="crmDrop" tabindex="0" role="button"><b>Drop the seven UC exports here</b><div class="crm-small" style="margin-top:6px">or click to choose them</div>' +
          '<input type="file" id="crmFile" accept=".xlsx" multiple class="hide"></div>' +
          '<div id="crmPlan" style="margin-top:14px"></div></div>' +
          '<div class="card"><h2>Previous imports</h2>' + (runs.length ? '<div class="scroll"><table><thead><tr><th>Started</th><th>By</th><th>Status</th><th>Files</th><th>Counts</th></tr></thead><tbody>' +
            runs.map(function (x) {
              var counts = x.counts || {};
              var shown = ['customers', 'meters', 'contracts', 'tenders'].map(function (k) { return counts[k] ? k + ' ' + n0(counts[k].upserted != null ? counts[k].upserted : counts[k]) : ''; }).filter(Boolean).join(', ');
              return '<tr><td>' + uk(x.started_at) + ' ' + String(x.started_at || '').slice(11, 16) + '</td><td>' + esc(x.by_name || '') + '</td><td>' + esc(x.status) + (x.notes ? '<div class="crm-small">' + esc(x.notes) + '</div>' : '') + '</td>' +
                '<td class="crm-wrap">' + esc((x.files || []).map(function (f) { return f.name; }).join(', ')) + '</td><td class="crm-wrap">' + esc(shown) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '<div class="note">None yet.</div>') + '</div>';
        var drop = body.querySelector('#crmDrop'), input = body.querySelector('#crmFile');
        drop.addEventListener('click', function () { input.click(); });
        drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
        drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); planImport(e.dataTransfer.files); });
        input.addEventListener('change', function () { planImport(input.files); input.value = ''; });
      });
    }

    function planImport(fileList) {
      var box = body.querySelector('#crmPlan');
      var X = opts.XLSX || root.XLSX, C = root.CrmImport;
      if (!X || !C) { box.innerHTML = '<div class="note bad">The import code did not load (SheetJS or pricing-crm-import.js). Hold Shift and reload.</div>'; return; }
      var files = [].slice.call(fileList || []);
      box.innerHTML = '<div class="note">Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '&hellip;</div>';
      return Promise.all(files.map(function (f) {
        return f.arrayBuffer().then(function (buf) {
          return (root.crypto && root.crypto.subtle ? root.crypto.subtle.digest('SHA-256', buf) : Promise.resolve(null)).then(function (h) {
            var r = C.readWorkbook(X, new Uint8Array(buf), f.name);
            r.sha256 = h ? Array.from(new Uint8Array(h)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('') : null;
            return r;
          });
        });
      })).then(function (read) {
        var missing = Object.keys(KIND_LABEL).filter(function (k) { return !read.some(function (r) { return r.kind === k; }); });
        var unknown = read.filter(function (r) { return !r.kind; });
        var list = '<table><thead><tr><th>File</th><th>Recognised as</th><th class="num">Rows</th></tr></thead><tbody>' + read.map(function (r) {
          return '<tr><td class="crm-wrap">' + esc(r.name) + '</td><td>' + (r.kind ? esc(KIND_LABEL[r.kind]) : '<span class="pill p-fail">not a UC export</span>') + '</td><td class="num">' + n0(r.rows.length - 1) + '</td></tr>';
        }).join('') + '</tbody></table>';
        if (missing.length || unknown.length) {
          box.innerHTML = list + '<div class="note bad" style="margin-top:10px">' + (missing.length ? 'Missing: ' + missing.map(function (k) { return KIND_LABEL[k]; }).join(', ') + '. ' : '') +
            (unknown.length ? unknown.length + ' file(s) are not UC exports. ' : '') + 'Nothing has been imported.</div>';
          return;
        }
        var plan = C.build(read, { asOf: today() });
        plan.file_hashes = read.map(function (r) { return { name: r.name, kind: r.kind, sha256: r.sha256, rows: r.rows.length - 1 }; });
        S.importPlan = plan;
        var st = plan.stats, life = st.contract_lifecycle || {}, sev = st.issues_by_severity || {};
        box.innerHTML = list + '<div class="crm-h3">What will be written</div><div class="crm-kpis">' +
          ['customers', 'leads', 'contacts', 'sites', 'meters', 'contracts', 'tenders', 'notes', 'reads'].map(function (k) {
            return '<div class="crm-kpi"><div class="k">' + k + '</div><div class="v">' + n0(st[k]) + '</div></div>';
          }).join('') + '</div>' +
          '<div class="note" style="margin-top:10px">Contracts today: ' + ['live', 'upcoming', 'ended', 'pipeline', 'stale', 'lost', 'service'].map(function (l) { return LIFE[l][0] + ' ' + n0(life[l] || 0); }).join(', ') +
          '. Problems found: ' + n0(sev.high || 0) + ' high, ' + n0(sev.medium || 0) + ' medium, ' + n0(sev.low || 0) + ' low.' +
          (st.duplicate_notes_dropped ? ' ' + n0(st.duplicate_notes_dropped) + ' duplicate notes dropped.' : '') + '</div>' +
          '<div style="margin-top:12px;display:flex;gap:10px;align-items:center"><button class="act" id="crmGo">Import it</button><span class="crm-small" id="crmProg"></span></div>';
        body.querySelector('#crmGo').addEventListener('click', function () { runImport(this); });
      }).catch(function (e) { box.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; });
    }

    function runImport(btn) {
      var plan = S.importPlan, prog = body.querySelector('#crmProg');
      if (!plan || S.busy) return;
      S.busy = true; btn.disabled = true;
      var data = Object.assign({}, plan.data, { issues: plan.issues });
      var order = ['customers', 'sites', 'meters', 'contacts', 'contracts', 'tenders', 'notes', 'reads', 'issues'];
      var counts = { cleaner_stats: plan.stats }, run = null;
      return q(sb.rpc('crm_import_begin', { p_files: plan.file_hashes, p_by_name: who() || 'pricing desk', p_cleaner_version: plan.version, p_full: true }), 'start import')
        .then(function (r) {
          run = r.data;
          var chain = Promise.resolve();
          order.forEach(function (kind) {
            var rows = data[kind] || [], n = 0;
            for (var i = 0; i < rows.length; i += 500) {
              (function (slice, from) {
                chain = chain.then(function () {
                  prog.textContent = 'Writing ' + kind + ' ' + n0(from + slice.length) + ' of ' + n0(rows.length) + '...';
                  return q(sb.rpc('crm_import_rows', { p_run: run, p_kind: kind, p_rows: slice }), 'writing ' + kind).then(function (x) { n += Number(x.data) || 0; });
                });
              })(rows.slice(i, i + 500), i);
            }
            chain = chain.then(function () { counts[kind] = { sent: rows.length, upserted: n }; });
          });
          return chain;
        })
        .then(function () { return q(sb.rpc('crm_import_finish', { p_run: run, p_kinds: order, p_counts: counts }), 'finish import'); })
        .then(function (r) {
          S.busy = false; S.overview = null; S.lists = null; S.providers = null;
          var removed = (r.data && r.data.marked_removed) || {};
          prog.innerHTML = '<b>Done.</b> ' + Object.keys(removed).filter(function (k) { return removed[k]; }).map(function (k) { return n0(removed[k]) + ' ' + k + ' no longer in UC, marked removed'; }).join(', ');
        })
        .catch(function (e) {
          S.busy = false; btn.disabled = false;
          prog.innerHTML = '<span style="color:var(--fail)">' + esc(e.message) + '</span>';
          if (run) sb.rpc('crm_import_fail', { p_run: run, p_note: String(e.message).slice(0, 500) });
        });
    }

    if (opts.start !== false) go(opts.start || 'portfolios');
    return { go: go, state: S, VERSION: VERSION, refreshLists: function () { S.lists = null; S.providers = null; },
             // The No contract uploaded page, optionally searched for one company (6 Nov 2026).
             noContract: function (term) {
               if (term != null) S.nc = { kind: '', state: '', am: '', q: term || '', sort: 'customer', page: 0 };
               return go('nocontract');
             },
             company: function () { return S.customer ? { id: S.customer.id, name: S.customer.name || '' } : null; },
             closeCompany: function () { S.customer = null; } };
  }

  root.CrmDesk = {
    VERSION: VERSION, mount: mount,
    rules: { pcRule: pcRule, pcReason: pcReason, RATE: RATE, pc2: pc2 },
    _internals: { uk: uk, plusDays: plusDays, LIFE: LIFE, ISSUE_LABEL: ISSUE_LABEL, KIND: KIND, GROUPS: GROUPS },
  };
})(typeof window !== 'undefined' ? window : globalThis);
