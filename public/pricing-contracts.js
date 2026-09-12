/* ═══════════════════════════════════════════════════════════════════════════════════════
   CES pricing desk — supplier contract filling.
   ═══════════════════════════════════════════════════════════════════════════════════════

   A ticked quote becomes the supplier's own contract acceptance form, filled from what the
   portal already holds: the customer, the site, the meter, the rates, the term, the start
   date, the account manager, CES's commission. Three suppliers to begin with:

     British Gas Business   BGB_Operational_ContractAcceptanceform V2.2   AcroForm, 440 fields
     EDF                    B30 AW16 V5                                   AcroForm, 560 fields
     British Gas Lite       STS Contract Acceptance Gas & Elec V6.0       an .xlsx, four tabs

   The forms are the SUPPLIERS' documents. Their field names are "Text Field 456"; the
   meaning of each box was harvested from the label the form prints beside it
   (contracts/harvest_fields.py) and then curated by hand into the maps below, checked against
   contracts CES have actually sent (Kent Foods, Tom Walker, Rainbow Dust). Conventions come
   from those: a single unit rate goes in the first "Unit charges" row and day/night in the
   first two; charges to three decimals; dates DD/MM/YY one digit per box; EAC without commas.

   TWO THINGS ARE NEVER WRITTEN BY THIS FILE, however the data arrives:
     - the signature, print name, job title and date of the person signing;
     - any bank detail: account name, sort code, account number, bank name, bank address.
   Those boxes are not in any map, so nothing here can reach them. Credit-vetting personal
   details (date of birth, home address) are not held by the portal and are left blank for
   the broker to type; they are never cached.

   BG Lite's form is a spreadsheet. The .xlsx is filled by surgical XML edit — one cell at a
   time, keeping its style, forcing a recalculation on open — the way cot-fill already does
   for the same supplier's COT form, so nothing else in the workbook is disturbed. The PDF
   that goes to the customer is BG Lite's own sheet rendered blank at build time with the
   values drawn onto it at cell positions MEASURED from a probe render (contracts/
   bgl_geometry.json), not guessed.
   ═══════════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const VERSION = '2026-09-12.1';
  const CES = { name: 'Commercial Energy Solutions Ltd', phone: '02030 988777' };

  // ── Formatting, as the filled examples have it ────────────────────────────────────────
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const fmt3 = (v) => (num(v) == null ? '' : Number(v).toFixed(3));
  const fmt2 = (v) => (num(v) == null ? '' : Number(v).toFixed(2));
  const fmtInt = (v) => (num(v) == null ? '' : String(Math.round(Number(v))));
  const pkwh = (v) => (num(v) == null ? '' : String(+Number(v).toFixed(2)));       // "1", "1.5", "0.7"
  /** '2026-10-01' -> { d:'01', m:'10', y:'26', yyyy:'2026', digits:['0','1','1','0','2','6'] } */
  function dateParts(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return { d: m[3], m: m[2], y: m[1].slice(2), yyyy: m[1], digits: [...m[3], ...m[2], ...m[1].slice(2)] };
  }
  function addMonths(iso, months) {
    const p = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!p) return null;
    const d = new Date(Date.UTC(+p[1], +p[2] - 1 + months, +p[3]));
    d.setUTCDate(d.getUTCDate() - 1);                       // a 12-month term from 1 Oct ends 30 Sep
    return d.toISOString().slice(0, 10);
  }
  /** The MPAN as the forms box it: S | PC | MTC | LLFC over | dd | dddd | dddd | ddd. */
  function mpanParts(core, topLine, pc, mtc, llfc) {
    const c = String(core || '').replace(/\D/g, '');
    const t = String(topLine || '').replace(/\s/g, '');
    const parts = { pc: pc || '', mtc: mtc || '', llfc: llfc || '' };
    if (t.length >= 8) { parts.pc = parts.pc || t.slice(0, 2); parts.mtc = parts.mtc || t.slice(2, 5); parts.llfc = parts.llfc || t.slice(5, 8); }
    parts.pc = String(parts.pc || '').padStart(parts.pc ? 2 : 0, '0');
    return { ...parts, core: c, c1: c.slice(0, 2), c2: c.slice(2, 6), c3: c.slice(6, 10), c4: c.slice(10, 13) };
  }
  /** "Unit 4, Atlas Business Centre, Oxgate Lane, London" -> lines for a form with 2 lines + city. */
  function splitAddress(addr, postcode) {
    const parts = String(addr || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)
      .filter(s => !postcode || s.replace(/\s/g, '').toUpperCase() !== String(postcode).replace(/\s/g, '').toUpperCase());
    if (!parts.length) return { line1: '', line2: '', city: '' };
    if (parts.length === 1) return { line1: parts[0], line2: '', city: '' };
    if (parts.length === 2) return { line1: parts[0], line2: '', city: parts[1] };
    return { line1: parts[0], line2: parts.slice(1, -1).join(', '), city: parts[parts.length - 1] };
  }

  // ── The data a contract is filled from ────────────────────────────────────────────────
  /**
   * One object, built once from the desk's state, that every form map reads. Anything the
   * portal does not hold is an empty string here and an empty, editable box on the form.
   */
  function buildContractData(x) {
    const meter = x.meter || {}, quote = x.quote || {}, row = x.row || {}, current = x.current || {};
    const fuel = meter.utility === 'gas' ? 'gas' : 'electricity';
    const termMonths = Number(row.term_months) || 0;
    const years = termMonths ? Math.round(termMonths / 12 * 100) / 100 : 0;
    const start = quote.start || '';
    const end = start && termMonths ? addMonths(start, termMonths) : '';
    const kwh = quote.kwh || { total: Number(quote.aq) || 0, regs: ['total'] };
    const uplift = Number(quote.uplift) || 0;
    const annualCommission = uplift * (kwh.total || 0) / 100;
    const addr = splitAddress(meter.site_address, meter.postcode);
    const sale = row.sale_type === 'renewal' ? 'renewal' : (row.sale_type === 'upgrade' ? 'upgrade' : 'acquisition');
    const mp = mpanParts(meter.mpan, meter.top_line, meter.profile_class, meter.mtc, meter.llfc);
    // Rates as they were QUOTED: uplift already on them. That is what the contract says.
    const rates = { u: num(row.u), d: num(row.d), nt: num(row.nt), ew: num(row.ew), sc: num(row.standing_charge_p_day) };
    // The unit-charge rows in the order the supplier forms use them.
    const unitRows = rates.u != null ? [rates.u]
      : [rates.d, rates.nt, rates.ew].filter(v => v != null);
    const rs = String(meter.rate_structure || '');
    const meterType = rs === 'day_night' ? 'Day / Night' : rs === 'day_night_ew' ? 'Day / Night / Evening & Weekend'
      : rs === 'eve_weekend' ? 'Day / Evening & Weekend' : rs === 'single' ? 'Standard' : '';
    return {
      fuel, supplier_key: row.supplier_key || '',
      broker: { name: CES.name, agent: (x.manager && x.manager.name) || '', phone: CES.phone,
                email: (x.manager && x.manager.email) || '' },
      customer: { business_name: x.customer || meter.customer_id || '', contact_name: '', phone: '',
                  email: '', reg_number: '', trading_as: '', business_type: '' },
      supply: { name: x.customer || meter.customer_id || '', address: [meter.site_address, meter.postcode].filter(Boolean).join(', '),
                line1: addr.line1, line2: addr.line2, city: addr.city, postcode: meter.postcode || '',
                site_name: meter.site_name || '' },
      meter: { mpan: fuel === 'electricity' ? mp.core : '', mprn: fuel === 'gas' ? String(meter.mpan || '').replace(/\D/g, '') : '',
               pc: mp.pc, mtc: mp.mtc, llfc: mp.llfc, c1: mp.c1, c2: mp.c2, c3: mp.c3, c4: mp.c4,
               serial: meter.meter_serial || '', type: meterType, top_line: meter.top_line || '' },
      contract: { term_months: termMonths, years, start, end, sale,
                  product: row.product_display || row.product_name || '',
                  sc: rates.sc, u: rates.u, d: rates.d, nt: rates.nt, ew: rates.ew, unitRows,
                  kwh: Math.round(kwh.total || 0), kwh_day: Math.round(kwh.day || 0), kwh_night: Math.round(kwh.night || 0) },
      commission: { pkwh: uplift, annual: annualCommission, total: annualCommission * (years || 1) },
      current: { supplier: current.supplier || meter.supplier || '', end: meter.contract_end_date || '' },
    };
  }

  // ── Form maps ─────────────────────────────────────────────────────────────────────────
  //
  // A field spec: { id, label, section, get(data) -> string, and ONE of:
  //   name:  an AcroForm text field
  //   chars: several one-character text fields, filled left to right
  //   radio: { name, option } an AcroForm radio group and the export value to select
  //   check: an AcroForm checkbox, ticked when get() is truthy
  //   cell:  a spreadsheet cell (BG Lite)
  // `fixed` marks a box the desk may look at but not change (the broker name BG pre-print).

  const BG_BUSINESS = {
    key: 'bg_business', supplier_key: 'british_gas', label: 'British Gas Business — Contract Acceptance Form V2.2',
    kind: 'acroform', template: '/contract-forms/bg_business_v2.2.pdf', fuels: ['electricity', 'gas'],
    fields: (d) => {
      const e = d.fuel === 'electricity', g = !e;
      const u = d.contract.unitRows;
      const start = dateParts(d.contract.start), cur = dateParts(d.current.end);
      const F = [];
      const add = (o) => F.push(o);
      add({ id: 'broker_name', section: 'Broker details', label: 'Broker name', name: 'Text Field 456', get: () => CES.name, fixed: true });
      add({ id: 'agent', section: 'Broker details', label: 'Sales agent name', name: 'Text Field 457', get: () => d.broker.agent });
      add({ id: 'broker_phone', section: 'Broker details', label: 'Broker contact no', name: 'Text Field 458', get: () => d.broker.phone });
      add({ id: 'business_name', section: 'Customer details', label: 'Business name', name: 'Text Field 459', get: () => d.customer.business_name });
      add({ id: 'contact_name', section: 'Customer details', label: 'Contact name', name: 'Text Field 460', get: () => d.customer.contact_name });
      add({ id: 'phone', section: 'Customer details', label: 'Telephone number', name: 'Text Field 497', get: () => d.customer.phone });
      add({ id: 'email', section: 'Customer details', label: 'Email address', name: 'Text Field 461', get: () => d.customer.email });
      add({ id: 'supply_address', section: 'Supply details', label: 'Supply address', name: 'Text Field 462', get: () => d.supply.address, multiline: true });
      add({ id: 'billing_address', section: 'Billing details', label: 'Billing address', name: 'Text Field 463', get: () => d.supply.address, multiline: true });
      add({ id: 'reg_number', section: 'Credit vetting', label: 'Registered charity / business number', name: 'Text Field 468', get: () => d.customer.reg_number });
      add({ id: 'existing_account', section: 'Credit vetting', label: 'Existing British Gas account number', name: 'Text Field 469', get: () => '' });
      if (g) add({ id: 'mprn', section: 'Meter point', label: 'Gas — meter point reference (MPRN)', name: 'Text Field 3010', get: () => d.meter.mprn });
      if (e) {
        add({ id: 'mpan_pc', section: 'Meter point', label: 'MPAN profile class', name: 'Text Field 3018', get: () => d.meter.pc });
        add({ id: 'mpan_mtc', section: 'Meter point', label: 'MPAN meter time-switch code', name: 'Text Field 3023', get: () => d.meter.mtc });
        add({ id: 'mpan_llfc', section: 'Meter point', label: 'MPAN line loss factor class', name: 'Text Field 3024', get: () => d.meter.llfc });
        add({ id: 'mpan_c1', section: 'Meter point', label: 'MPAN core (distributor)', name: 'Text Field 3019', get: () => d.meter.c1 });
        add({ id: 'mpan_c2', section: 'Meter point', label: 'MPAN core (digits 3–6)', name: 'Text Field 3020', get: () => d.meter.c2 });
        add({ id: 'mpan_c3', section: 'Meter point', label: 'MPAN core (digits 7–10)', name: 'Text Field 3021', get: () => d.meter.c3 });
        add({ id: 'mpan_c4', section: 'Meter point', label: 'MPAN core (check digits)', name: 'Text Field 3022', get: () => d.meter.c4 });
      }
      // Contract details: gas column | electricity column
      const col = e ? { yrs: 'Text Field 3012', sc: 'Text Field 500', units: ['Text Field 3014', 'Text Field 502', 'Text Field 498', 'Text Field 504', 'Text Field 506'] }
                    : { yrs: 'Text Field 3011', sc: 'Text Field 499', units: ['Text Field 3013', 'Text Field 501', 'Text Field 3015', 'Text Field 503', 'Text Field 505'] };
      add({ id: 'years', section: 'Contract details', label: `Contract length (${d.fuel}, years)`, name: col.yrs, get: () => (d.contract.years ? String(+d.contract.years.toFixed(2)) : '') });
      add({ id: 'sc', section: 'Contract details', label: 'Standing charge (p/day)', name: col.sc, get: () => fmt3(d.contract.sc) });
      const unitLabels = d.contract.u != null ? ['Unit charge (p/kWh)'] : ['Day unit charge (p/kWh)', 'Night unit charge (p/kWh)', 'Evening & weekend unit charge (p/kWh)'];
      u.forEach((v, i) => add({ id: 'unit' + (i + 1), section: 'Contract details', label: unitLabels[i] || `Unit charge ${i + 1} (p/kWh)`, name: col.units[i], get: () => fmt3(v) }));
      add({ id: 'commission_total', section: 'Commission', label: 'Estimated total broker commission value (£)', name: 'Text Field 5010', get: () => fmt2(d.commission.total) });
      add({ id: 'commission_years', section: 'Commission', label: '…for your __ year contract', name: 'Text Field 509', get: () => (d.contract.years ? String(+d.contract.years.toFixed(2)) : '') });
      add({ id: 'commission_pkwh', section: 'Commission', label: `Commission included — ${d.fuel} p/kWh`, name: e ? 'Text Field 1044' : 'Text Field 5011', get: () => pkwh(d.commission.pkwh) });
      add({ id: 'eac', section: 'Consumption', label: `Estimated annual consumption — ${d.fuel} (kWh)`, name: e ? 'Text Field 1067' : 'Text Field 1066', get: () => fmtInt(d.contract.kwh) });
      add({ id: 'sale_type', section: 'Sale', label: `Sale type — ${d.fuel}`, radio: { name: e ? 'Sale type - Electricity' : 'Sale type - Gas' },
            options: { acquisition: 0, upgrade: 1, renewal: 2 }, get: () => d.contract.sale });
      add({ id: 'annex', section: 'Sale', label: 'Annex attached', radio: { name: 'Annex attached' }, options: { yes: 0, no: 1 }, get: () => 'no' });
      add({ id: 'cot', section: 'Sale', label: 'Change of tenancy involved', radio: { name: 'Change of tenancy' }, options: { yes: 0, no: 1 }, get: () => 'no' });
      add({ id: 'start', section: 'Dates', label: 'Proposed start date (DDMMYY)', chars: ['Text Field 1046', 'Text Field 507', 'Text Field 1047', 'Text Field 1055', 'Text Field 1048', 'Text Field 1056'],
            get: () => (start ? start.digits.join('') : '') });
      add({ id: 'current_end', section: 'Dates', label: 'Current contract end date (DDMMYY)', chars: ['Text Field 1051', 'Text Field 1059', 'Text Field 1050', 'Text Field 1058', 'Text Field 1049', 'Text Field 1057'],
            get: () => (cur ? cur.digits.join('') : '') });
      add({ id: 'debt', section: 'Sale', label: 'Debt with current supplier', radio: { name: 'Debt with current supplier' }, options: { yes: 0, no: 1 }, get: () => 'no' });
      // The template ships with Acquisition pre-ticked on BOTH fuels. The fuel this contract is
      // not for must read blank, or a gas section with nothing in it still says Acquisition.
      add({ id: 'other_sale', section: 'Sale', label: `Sale type — ${e ? 'gas' : 'electricity'} (not this contract)`, radio: { name: e ? 'Sale type - Gas' : 'Sale type - Electricity' }, options: {}, get: () => '', fixed: true });
      add({ id: 'conf_email', section: 'Confirmation (the signatory fills these)', label: 'Email address', name: 'Text Field 1062', get: () => '' });
      add({ id: 'conf_name', section: 'Confirmation (the signatory fills these)', label: 'Print name', name: 'Text Field 1063', get: () => '' });
      add({ id: 'conf_title', section: 'Confirmation (the signatory fills these)', label: 'Job title', name: 'Text Field 1064', get: () => '' });
      return F;
    },
  };

  const EDF = {
    key: 'edf', supplier_key: 'edf', label: 'EDF Energy Supply Contract — B30 AW16 V5',
    kind: 'acroform', template: '/contract-forms/edf_b30_aw16_v5.pdf', fuels: ['electricity', 'gas'],
    fields: (d) => {
      const e = d.fuel === 'electricity';
      const end = dateParts(d.contract.end), cur = dateParts(d.current.end);
      const F = []; const add = (o) => F.push(o);
      add({ id: 'tpi', section: 'TPI', label: 'TPI Name', name: 'Text Field 1388', get: () => CES.name, fixed: true });
      add({ id: 'qdss', section: 'TPI', label: 'QDSS Number', name: 'Text Field 1389', get: () => '' });
      add({ id: 'sales_type', section: 'TPI', label: 'Sales Type', name: 'Text Field 1390', get: () => (d.contract.sale === 'renewal' ? 'Renewal' : 'Acquisition') });
      add({ id: 'business_name', section: 'Business contact details', label: 'Business name', name: 'Text Field 353', get: () => d.customer.business_name });
      add({ id: 'contact_name', section: 'Business contact details', label: 'Contact name', name: 'Text Field 354', get: () => d.customer.contact_name });
      add({ id: 'business_type', section: 'Business contact details', label: 'Business type', name: 'Text Field 355', get: () => d.customer.business_type });
      add({ id: 'reg_number', section: 'Business contact details', label: 'Business reg number', name: 'Text Field 356', get: () => d.customer.reg_number });
      add({ id: 'trading_as', section: 'Business contact details', label: 'Trading as', name: 'Text Field 359', get: () => d.customer.trading_as });
      add({ id: 'email', section: 'Business contact details', label: 'Email address', name: 'Text Field 357', get: () => d.customer.email });
      add({ id: 'phone', section: 'Business contact details', label: 'Telephone', name: 'Text Field 360', get: () => d.customer.phone });
      add({ id: 'mobile', section: 'Business contact details', label: 'Mobile', name: 'Text Field 358', get: () => '' });
      add({ id: 'supply_name', section: 'Supply details', label: 'Supply name', name: 'Text Field 365', get: () => d.supply.name });
      add({ id: 'supply_address', section: 'Supply details', label: 'Supply address', name: 'Text Field 366', get: () => [d.supply.line1, d.supply.line2].filter(Boolean).join(', ') });
      add({ id: 'supply_town', section: 'Supply details', label: 'Town, County', name: 'Text Field 367', get: () => d.supply.city });
      add({ id: 'supply_postcode', section: 'Supply details', label: 'Postcode', name: 'Text Field 368', get: () => d.supply.postcode });
      add({ id: 'billing_name', section: 'Billing details', label: 'Billing name', name: 'Text Field 369', get: () => d.supply.name });
      add({ id: 'billing_address', section: 'Billing details', label: 'Billing address', name: 'Text Field 370', get: () => [d.supply.line1, d.supply.line2].filter(Boolean).join(', ') });
      add({ id: 'billing_town', section: 'Billing details', label: 'Town, County', name: 'Text Field 371', get: () => d.supply.city });
      add({ id: 'billing_postcode', section: 'Billing details', label: 'Postcode', name: 'Text Field 372', get: () => d.supply.postcode });
      if (e) {
        add({ id: 'product', section: 'Electricity', label: 'Product code', name: 'Text Field 373', get: () => d.contract.product });
        add({ id: 'sc', section: 'Electricity', label: 'Standing charge (p/day)', name: 'Text Field 374', get: () => fmt3(d.contract.sc) });
        add({ id: 'unit', section: 'Electricity', label: 'Unit rate (p/kWh)', name: 'Text Field 378', get: () => fmt3(d.contract.u) });
        add({ id: 'day', section: 'Electricity', label: 'Day (p/kWh)', name: 'Text Field 375', get: () => fmt3(d.contract.d) });
        add({ id: 'night', section: 'Electricity', label: 'Night (p/kWh)', name: 'Text Field 379', get: () => fmt3(d.contract.nt) });
        add({ id: 'ew', section: 'Electricity', label: 'Eve/Wknd (p/kWh)', name: 'Text Field 377', get: () => fmt3(d.contract.ew) });
        add({ id: 'review_d', section: 'Electricity', label: 'Price review date — DD', name: 'Text Field 380', get: () => (end ? end.d : '') });
        add({ id: 'review_m', section: 'Electricity', label: 'Price review date — MM', name: 'Text Field 381', get: () => (end ? end.m : '') });
        add({ id: 'review_y', section: 'Electricity', label: 'Price review date — YYYY', name: 'Text Field 382', get: () => (end ? end.yyyy : '') });
        add({ id: 'mpan_pc', section: 'Electricity', label: 'MPAN profile class', name: 'Text Field 386', get: () => d.meter.pc });
        add({ id: 'mpan_mtc', section: 'Electricity', label: 'MPAN meter time-switch code', name: 'Text Field 387', get: () => d.meter.mtc });
        add({ id: 'mpan_llfc', section: 'Electricity', label: 'MPAN line loss factor class', name: 'Text Field 388', get: () => d.meter.llfc });
        add({ id: 'mpan_c1', section: 'Electricity', label: 'MPAN core (distributor)', name: 'Text Field 392', get: () => d.meter.c1 });
        add({ id: 'mpan_c2', section: 'Electricity', label: 'MPAN core (digits 3–6)', name: 'Text Field 391', get: () => d.meter.c2 });
        add({ id: 'mpan_c3', section: 'Electricity', label: 'MPAN core (digits 7–10)', name: 'Text Field 390', get: () => d.meter.c3 });
        add({ id: 'mpan_c4', section: 'Electricity', label: 'MPAN core (check digits)', name: 'Text Field 389', get: () => d.meter.c4 });
        add({ id: 'serial', section: 'Electricity', label: 'Meter serial number', name: 'Text Field 440', get: () => d.meter.serial });
        add({ id: 'meter_type', section: 'Electricity', label: 'Meter type', name: 'Text Field 441', get: () => d.meter.type });
        add({ id: 'eac', section: 'Electricity', label: 'EAC (kWh)', name: 'Text Field 442', get: () => fmtInt(d.contract.kwh) });
        add({ id: 'comm_day', section: 'Third party intermediary commission', label: 'Electricity day unit cost (p/kWh)', name: 'Text Field 1014', get: () => pkwh(d.commission.pkwh) });
        add({ id: 'comm_night', section: 'Third party intermediary commission', label: 'Electricity night / off-peak (p/kWh)', name: 'Text Field 1018', get: () => (d.contract.nt != null ? pkwh(d.commission.pkwh) : '') });
        add({ id: 'comm_ew', section: 'Third party intermediary commission', label: 'Electricity evening/weekend/off-peak (p/kWh)', name: 'Text Field 1015', get: () => (d.contract.ew != null ? pkwh(d.commission.pkwh) : '') });
        add({ id: 'cur_supplier', section: 'Current supply', label: 'Current supplier for electricity', name: 'Text Field 407', get: () => d.current.supplier });
        add({ id: 'cur_fixed', section: 'Current supply', label: 'Electricity: fixed term contract', check: 'Check Box 9', get: () => (cur ? 'yes' : '') });
        add({ id: 'cur_end_d', section: 'Current supply', label: 'Electricity end date — DD', name: 'Text Field 412', get: () => (cur ? cur.d : '') });
        add({ id: 'cur_end_m', section: 'Current supply', label: 'Electricity end date — MM', name: 'Text Field 413', get: () => (cur ? cur.m : '') });
        add({ id: 'cur_end_y', section: 'Current supply', label: 'Electricity end date — YYYY', name: 'Text Field 414', get: () => (cur ? cur.yyyy : '') });
      } else {
        add({ id: 'product', section: 'Gas', label: 'Product code', name: 'Text Field 399', get: () => d.contract.product });
        add({ id: 'sc', section: 'Gas', label: 'Standing charge (p/day)', name: 'Text Field 400', get: () => fmt3(d.contract.sc) });
        add({ id: 'unit', section: 'Gas', label: 'Unit rate (p/kWh)', name: 'Text Field 401', get: () => fmt3(d.contract.u != null ? d.contract.u : d.contract.d) });
        add({ id: 'review_d', section: 'Gas', label: 'Price review date — DD', name: 'Text Field 393', get: () => (end ? end.d : '') });
        add({ id: 'review_m', section: 'Gas', label: 'Price review date — MM', name: 'Text Field 394', get: () => (end ? end.m : '') });
        add({ id: 'review_y', section: 'Gas', label: 'Price review date — YYYY', name: 'Text Field 395', get: () => (end ? end.yyyy : '') });
        add({ id: 'mprn', section: 'Gas', label: 'MPRN', name: 'Text Field 406', get: () => d.meter.mprn });
        add({ id: 'serial', section: 'Gas', label: 'Meter serial number', name: 'Text Field 402', get: () => d.meter.serial });
        add({ id: 'serial2', section: 'Gas', label: 'Meter serial number (second box)', name: 'Text Field 405', get: () => d.meter.serial });
        add({ id: 'tariff', section: 'Gas', label: 'Tariff type', name: 'Text Field 403', get: () => '' });
        add({ id: 'aq', section: 'Gas', label: 'AQ (kWh)', name: 'Text Field 404', get: () => fmtInt(d.contract.kwh) });
        add({ id: 'comm_gas', section: 'Third party intermediary commission', label: 'Gas day cost (p/kWh)', name: 'Text Field 1019', get: () => pkwh(d.commission.pkwh) });
        add({ id: 'cur_supplier', section: 'Current supply', label: 'Current supplier for gas', name: 'Text Field 408', get: () => d.current.supplier });
        add({ id: 'cur_fixed', section: 'Current supply', label: 'Gas: fixed term contract', check: 'Check Box 10', get: () => (cur ? 'yes' : '') });
        add({ id: 'cur_end_d', section: 'Current supply', label: 'Gas end date — DD', name: 'Text Field 409', get: () => (cur ? cur.d : '') });
        add({ id: 'cur_end_m', section: 'Current supply', label: 'Gas end date — MM', name: 'Text Field 410', get: () => (cur ? cur.m : '') });
        add({ id: 'cur_end_y', section: 'Current supply', label: 'Gas end date — YYYY', name: 'Text Field 411', get: () => (cur ? cur.yyyy : '') });
      }
      add({ id: 'comm_total', section: 'Third party intermediary commission', label: 'Total commission payment (£)', name: 'Text Field 1017', get: () => fmt2(d.commission.total) });
      return F;
    },
  };

  // BG Lite: cells by meaning, per sheet. Measured positions on the PDF face live in
  // BGL_GEOMETRY below (from contracts/bgl_geometry.json; do not hand-edit, re-run the probe).
  const BGL_CELLS = {
    electricity: { sheet: 'BGL Electricity Contract', face: '/contract-forms/bg_lite_elec_v6.0.pdf',
      broker_name: 'I20', agent_name: 'I22', broker_phone: 'I24',
      mpan_pc: 'V22', mpan_mtc: 'AB22', mpan_llfc: 'AI22', mpan_core1: 'V24', mpan_core2: 'X24', mpan_core3: 'AD24', mpan_core4: 'AI24',
      commission_total: 'C29', commission_years: 'H29', commission_pkwh: 'H31',
      business_name: 'I37', business_phone: 'I39', site_addr1: 'I41', site_addr2: 'I43', site_city: 'I45', site_postcode: 'I47',
      contract_years: 'AA37', standing_charge: 'AA39', unit1: 'AA41', unit2: 'AA43', unit3: 'AA45', eac: 'AA47',
      sale_acq: 'AJ55', sale_upg: 'AJ57', sale_ren: 'AJ59',
      schedule_yes: 'AG61', schedule_no: 'AJ61', cot_yes: 'AG63', cot_no: 'AJ63',
      cot_d: 'AB65', cot_m: 'AF65', cot_y: 'AI65', start_d: 'AB67', start_m: 'AF67', start_y: 'AI67',
      notice_yes: 'AG69', notice_no: 'AJ69', debt_yes: 'AG71', debt_no: 'AJ71',
      end_d: 'AB73', end_m: 'AF73', end_y: 'AI73' },
    gas: { sheet: 'BGL Gas Contract Single', face: '/contract-forms/bg_lite_gas_v6.0.pdf',
      broker_name: 'I19', agent_name: 'I21', broker_phone: 'I23', mprn: 'Z21',
      commission_total: 'C28', commission_years: 'I28', commission_pkwh: 'H30',
      business_name: 'I36', business_phone: 'I38', site_addr1: 'I40', site_addr2: 'I42', site_city: 'I44', site_postcode: 'I46',
      contract_years: 'AA36', standing_charge: 'AA38', unit1: 'AA40', unit2: 'AA42', unit3: 'AA44', eac: 'AA46',
      sale_acq: 'AJ53', sale_upg: 'AJ55', sale_ren: 'AJ57', cot_yes: 'AG61', cot_no: 'AJ61',
      cot_d: 'AB63', cot_m: 'AF63', cot_y: 'AI63', start_d: 'AB65', start_m: 'AF65', start_y: 'AI65',
      notice_yes: 'AG67', notice_no: 'AJ67', debt_yes: 'AG69', debt_no: 'AJ69',
      end_d: 'AB71', end_m: 'AF71', end_y: 'AI71' },
  };
  let BGL_GEOMETRY = null;         // loaded from /contract-forms/bgl_geometry.json on first use

  const BG_LITE = {
    key: 'bg_lite', supplier_key: 'bg_lite', label: 'British Gas Lite — STS Contract Acceptance V6.0',
    kind: 'xlsx', template: '/contract-forms/bg_lite_v6.0.xlsx', fuels: ['electricity', 'gas'],
    fields: (d) => {
      const e = d.fuel === 'electricity';
      const C = BGL_CELLS[d.fuel];
      const start = dateParts(d.contract.start), cur = dateParts(d.current.end);
      const F = []; const add = (o) => F.push({ ...o, cell: C[o.id] });
      add({ id: 'broker_name', section: 'Broker details', label: 'Broker name', get: () => CES.name, fixed: true });
      add({ id: 'agent_name', section: 'Broker details', label: 'Sales agent name', get: () => d.broker.agent });
      add({ id: 'broker_phone', section: 'Broker details', label: 'Broker contact number', get: () => d.broker.phone });
      if (e) {
        add({ id: 'mpan_pc', section: 'Meter point', label: 'MPAN profile class', get: () => d.meter.pc });
        add({ id: 'mpan_mtc', section: 'Meter point', label: 'MPAN meter time-switch code', get: () => d.meter.mtc });
        add({ id: 'mpan_llfc', section: 'Meter point', label: 'MPAN line loss factor class', get: () => d.meter.llfc });
        add({ id: 'mpan_core1', section: 'Meter point', label: 'MPAN core (distributor)', get: () => d.meter.c1 });
        add({ id: 'mpan_core2', section: 'Meter point', label: 'MPAN core (digits 3–6)', get: () => d.meter.c2 });
        add({ id: 'mpan_core3', section: 'Meter point', label: 'MPAN core (digits 7–10)', get: () => d.meter.c3 });
        add({ id: 'mpan_core4', section: 'Meter point', label: 'MPAN core (check digits)', get: () => d.meter.c4 });
      } else {
        add({ id: 'mprn', section: 'Meter point', label: 'MPRN', get: () => d.meter.mprn });
      }
      add({ id: 'commission_total', section: 'Commission', label: 'Estimated total broker commission (£)', get: () => fmt2(d.commission.total) });
      add({ id: 'commission_years', section: 'Commission', label: '…for your __ year contract', get: () => (d.contract.years ? String(+d.contract.years.toFixed(2)) : '') });
      add({ id: 'commission_pkwh', section: 'Commission', label: 'Commission included (p/kWh)', get: () => pkwh(d.commission.pkwh) });
      add({ id: 'business_name', section: 'Supply details', label: 'Business name', get: () => d.customer.business_name });
      add({ id: 'business_phone', section: 'Supply details', label: 'Business contact number', get: () => d.customer.phone });
      add({ id: 'site_addr1', section: 'Supply details', label: 'Site address line 1', get: () => d.supply.line1 });
      add({ id: 'site_addr2', section: 'Supply details', label: 'Site address line 2', get: () => d.supply.line2 });
      add({ id: 'site_city', section: 'Supply details', label: 'City', get: () => d.supply.city });
      add({ id: 'site_postcode', section: 'Supply details', label: 'Postcode', get: () => d.supply.postcode });
      add({ id: 'contract_years', section: 'Contract details', label: 'Contract length (years)', get: () => (d.contract.years ? String(+d.contract.years.toFixed(2)) : '') });
      add({ id: 'standing_charge', section: 'Contract details', label: 'Standing charge (p/day)', get: () => fmt3(d.contract.sc) });
      const labels = d.contract.u != null ? ['Unit charge (p/kWh)'] : ['Day unit charge (p/kWh)', 'Night unit charge (p/kWh)', 'Evening & weekend unit charge (p/kWh)'];
      d.contract.unitRows.slice(0, 3).forEach((v, i) => add({ id: 'unit' + (i + 1), section: 'Contract details', label: labels[i] || `Unit charge ${i + 1}`, get: () => fmt3(v) }));
      add({ id: 'eac', section: 'Contract details', label: e ? 'EAC (kWh)' : 'AQ (kWh)', get: () => fmtInt(d.contract.kwh) });
      // Ticks are an X in the box cell; the form has no live checkboxes.
      add({ id: 'sale_acq', section: 'Sale', label: 'Sale type: Acquisition', tick: true, get: () => (d.contract.sale === 'acquisition' ? 'X' : '') });
      add({ id: 'sale_upg', section: 'Sale', label: 'Sale type: Upgrade', tick: true, get: () => (d.contract.sale === 'upgrade' ? 'X' : '') });
      add({ id: 'sale_ren', section: 'Sale', label: 'Sale type: Renewal', tick: true, get: () => (d.contract.sale === 'renewal' ? 'X' : '') });
      if (e) add({ id: 'schedule_no', section: 'Sale', label: 'Schedule attached: No', tick: true, get: () => 'X' });
      add({ id: 'cot_no', section: 'Sale', label: 'Change of tenancy / ownership: No', tick: true, get: () => 'X' });
      add({ id: 'start_d', section: 'Dates', label: 'Proposed start date — DD', get: () => (start ? start.d : '') });
      add({ id: 'start_m', section: 'Dates', label: 'Proposed start date — MM', get: () => (start ? start.m : '') });
      add({ id: 'start_y', section: 'Dates', label: 'Proposed start date — YY', get: () => (start ? start.y : '') });
      add({ id: 'end_d', section: 'Dates', label: 'Current contract end date — DD', get: () => (cur ? cur.d : '') });
      add({ id: 'end_m', section: 'Dates', label: 'Current contract end date — MM', get: () => (cur ? cur.m : '') });
      add({ id: 'end_y', section: 'Dates', label: 'Current contract end date — YY', get: () => (cur ? cur.y : '') });
      return F.filter(f => f.cell);
    },
  };

  const FORMS = { bg_business: BG_BUSINESS, edf: EDF, bg_lite: BG_LITE };
  const FORM_FOR_SUPPLIER = { british_gas: 'bg_business', bg_lite: 'bg_lite', edf: 'edf' };

  /** The editable value set for a form: id -> string, from the data. */
  function initialValues(form, data) {
    const out = {};
    for (const f of form.fields(data)) out[f.id] = String(f.get() == null ? '' : f.get());
    return out;
  }

  // ── AcroForm filling (pdf-lib) ────────────────────────────────────────────────────────
  /**
   * Fill from a PRISTINE template every time, so an edit-and-redraw never layers on top of a
   * previous fill. Returns the bytes and, for the editor, each field's page and rectangle.
   * Never flattens here: flattening is for the download, and only there.
   */
  async function fillAcroform(PDFLib, templateBytes, form, data, values, opts) {
    const doc = await PDFLib.PDFDocument.load(templateBytes, { updateMetadata: false });
    const acro = doc.getForm();
    const helv = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const boxes = [];
    const problems = [];
    const rectOf = (field) => {
      try {
        const w = field.acroField.getWidgets()[0];
        const r = w.getRectangle();
        const pageRef = w.P();
        let page = 0;
        doc.getPages().forEach((p, i) => { if (p.ref === pageRef) page = i; });
        return { page, x: r.x, y: r.y, w: r.width, h: r.height };
      } catch (_) { return null; }
    };
    for (const f of form.fields(data)) {
      const v = values[f.id] == null ? '' : String(values[f.id]);
      try {
        if (f.name) {
          const tf = acro.getTextField(f.name);
          tf.setText(v);
          if (f.multiline) tf.enableMultiline();
          // Auto-size (0) only in the NARROW boxes — the single-digit date and MPAN cells,
          // under 16pt wide. Every other box on both forms is 10–11pt tall and takes 8pt
          // text comfortably; on auto they came out at about 5pt, a business name nobody
          // could read. Height is the wrong test here: the digit boxes are the same height
          // as the wide ones.
          const r = rectOf(tf);
          const narrow = r && r.w < 16;
          tf.setFontSize(f.multiline ? 7.5 : (narrow ? 0 : (r && r.h < 10 ? 7.5 : 8)));
          boxes.push({ id: f.id, ...r });
        } else if (f.chars) {
          const chars = [...v.replace(/\s/g, '')];
          f.chars.forEach((name, i) => {
            const tf = acro.getTextField(name);
            tf.setText(chars[i] || '');
            tf.setFontSize(0);
            if (i === 0) boxes.push({ id: f.id, ...rectOf(tf) });
          });
        } else if (f.radio) {
          // Options are addressed by POSITION, left to right on the page. pdf-lib names them
          // Choice1, Choice2… in widget order and that order was checked against the widget
          // x-coordinates: Acquisition | Upgrade | Renewal, Yes | No.
          const rg = acro.getRadioGroup(f.radio.name);
          const idx = f.options[v];
          const names = rg.getOptions();
          if (idx != null && names[idx]) rg.select(names[idx]);
          else { try { rg.clear(); } catch (_) {} }
          boxes.push({ id: f.id, ...rectOf(rg) });
        } else if (f.check) {
          const cb = acro.getCheckBox(f.check);
          if (v) cb.check(); else cb.uncheck();
          boxes.push({ id: f.id, ...rectOf(cb) });
        }
      } catch (e) {
        problems.push(`${f.label}: ${e.message}`);
      }
    }
    acro.updateFieldAppearances(helv);
    if (opts && opts.flatten) acro.flatten();
    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, boxes, problems };
  }

  // ── BG Lite: the spreadsheet, filled surgically ───────────────────────────────────────
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colNum = (col) => [...col].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  const refParts = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); return { col: m[1], row: Number(m[2]) }; };

  /** Which zip entry holds a named sheet — from the relationships, never from the numbering. */
  function sheetPath(files, name) {
    const wb = files['xl/workbook.xml'], rels = files['xl/_rels/workbook.xml.rels'];
    if (!wb || !rels) return null;
    const relMap = {};
    for (const m of rels.matchAll(/Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) relMap[m[1]] = m[2].replace(/^\/?xl\//, '').replace(/^\//, '');
    for (const m of wb.matchAll(/<sheet\b[^>]*?>/g)) {
      const nm = /name="([^"]*)"/.exec(m[0]), rid = /r:id="([^"]*)"/.exec(m[0]);
      if (nm && rid && nm[1] === name) { const t = relMap[rid[1]]; if (t) return t.startsWith('xl/') ? t : 'xl/' + t; }
    }
    return null;
  }
  /** Replace, or insert, one cell's value as an inline string, keeping its style. */
  function setCell(xml, ref, value) {
    const { row } = refParts(ref);
    const body = `<is><t xml:space="preserve">${escXml(value)}</t></is>`;
    const open = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(/>|>)`);
    const hit = open.exec(xml);
    if (hit) {
      const style = /\bs="(\d+)"/.exec(hit[0]);
      const attrs = `r="${ref}"${style ? ` s="${style[1]}"` : ''} t="inlineStr"`;
      if (value === '') {                                   // blank: keep the styled empty cell
        const empty = `<c ${attrs.replace(' t="inlineStr"', '')}/>`;
        if (hit[1] === '/>') return xml;
        const close = xml.indexOf('</c>', hit.index);
        return xml.slice(0, hit.index) + empty + xml.slice(close + 4);
      }
      if (hit[1] === '/>') return xml.replace(hit[0], `<c ${attrs}>${body}</c>`);
      const close = xml.indexOf('</c>', hit.index);
      if (close < 0) throw new Error(`cell ${ref} is not closed`);
      return xml.slice(0, hit.index) + `<c ${attrs}>${body}</c>` + xml.slice(close + 4);
    }
    if (value === '') return xml;
    const rowRe = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*?(/>|>)`);
    const rh = rowRe.exec(xml);
    if (!rh) throw new Error(`row ${row} is not in the sheet`);
    const cell = `<c r="${ref}" t="inlineStr">${body}</c>`;
    if (rh[1] === '/>') return xml.replace(rh[0], `${rh[0].slice(0, -2)}>${cell}</row>`);
    const rowEnd = xml.indexOf('</row>', rh.index);
    const inner = xml.slice(rh.index + rh[0].length, rowEnd);
    const want = colNum(refParts(ref).col);
    let at = inner.length;
    for (const m of inner.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) { if (colNum(m[1]) > want) { at = m.index; break; } }
    return xml.slice(0, rh.index + rh[0].length) + inner.slice(0, at) + cell + inner.slice(at) + xml.slice(rowEnd);
  }
  /** Ask Excel to recalculate on open, and drop the chain that would fight it. */
  function forceRecalc(files) {
    const k = 'xl/workbook.xml';
    if (!files[k]) return;
    files[k] = /<calcPr\b/.test(files[k])
      ? files[k].replace(/<calcPr\b[^>]*?\/?>/, t => `${t.replace(/\/?>$/, '').replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`)
      : files[k].replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
    if (files['xl/calcChain.xml'] !== undefined) {
      delete files['xl/calcChain.xml'];
      if (files['[Content_Types].xml']) files['[Content_Types].xml'] = files['[Content_Types].xml'].replace(/<Override[^>]*calcChain\.xml"[^>]*\/>/, '');
      if (files['xl/_rels/workbook.xml.rels']) files['xl/_rels/workbook.xml.rels'] = files['xl/_rels/workbook.xml.rels'].replace(/<Relationship[^>]*calcChain\.xml"[^>]*\/>/, '');
    }
  }
  /**
   * Fill BG Lite's workbook. Only the contract sheet for this fuel is touched; the other three
   * tabs (the annexes and the other fuel) are left exactly as BG Lite issued them.
   */
  async function fillBgLiteXlsx(JSZip, templateBytes, data, values) {
    const zip = await JSZip.loadAsync(templateBytes);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const text = {};
    for (const n of ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/calcChain.xml']) {
      if (zip.files[n]) text[n] = await zip.files[n].async('string');
    }
    const C = BGL_CELLS[data.fuel];
    const path = sheetPath(text, C.sheet);
    if (!path || !zip.files[path]) throw new Error(`sheet "${C.sheet}" is not in the workbook`);
    let xml = await zip.files[path].async('string');
    const fields = BG_LITE.fields(data);
    for (const f of fields) {
      const v = values[f.id] == null ? '' : String(values[f.id]);
      xml = setCell(xml, f.cell, v);
    }
    zip.file(path, xml);
    forceRecalc(text);
    for (const n of Object.keys(text)) { if (text[n] === undefined) zip.remove(n); else if (n !== path) zip.file(n, text[n]); }
    if (text['xl/calcChain.xml'] === undefined && zip.files['xl/calcChain.xml']) zip.remove('xl/calcChain.xml');
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  /**
   * Draw the values onto BG Lite's own blank sheet, at the cell positions measured from the
   * probe render. The face is BG Lite's document; only the text is ours.
   */
  async function overlayBgLitePdf(PDFLib, faceBytes, data, values, geometry) {
    const doc = await PDFLib.PDFDocument.load(faceBytes, { updateMetadata: false });
    const page = doc.getPages()[0];
    const helv = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const C = BGL_CELLS[data.fuel];
    const geo = geometry[C.sheet];
    if (!geo) throw new Error(`no measured geometry for "${C.sheet}"`);
    const boxes = [];
    for (const f of BG_LITE.fields(data)) {
      const v = values[f.id] == null ? '' : String(values[f.id]);
      const g = geo.cells[f.id];
      if (!g) continue;
      boxes.push({ id: f.id, page: 0, x: g.x - 2, y: g.y - 2, w: Math.max(g.w, 40) + 4, h: g.h + 4 });
      if (!v) continue;
      // A `fixed` cell (the broker name) is already printed on BG Lite's own face; drawing it
      // again puts the same words on top of themselves.
      if (f.fixed) continue;
      const size = f.tick ? 9 : (g.w && g.w < 45 ? 6.8 : 7.5);
      page.drawText(v, { x: g.x, y: g.y, size, font: f.tick ? bold : helv, color: PDFLib.rgb(0.05, 0.05, 0.05) });
    }
    return { bytes: await doc.save({ useObjectStreams: false }), boxes };
  }

  const api = {
    VERSION, CES, FORMS, FORM_FOR_SUPPLIER, BGL_CELLS,
    buildContractData, initialValues, fillAcroform, fillBgLiteXlsx, overlayBgLitePdf,
    setGeometry: (g) => { BGL_GEOMETRY = g; }, getGeometry: () => BGL_GEOMETRY,
    _internals: { fmt3, fmt2, fmtInt, pkwh, dateParts, addMonths, mpanParts, splitAddress, setCell, sheetPath, forceRecalc },
  };
  root.PricingContracts = api;
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).PricingContracts;
}
