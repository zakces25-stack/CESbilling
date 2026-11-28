// lib.test.mjs - the pure rules of the pricebook loader. Run: npm test
import './tz.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';

test('classifyFile: the bytes decide, as the desk does', () => {
  const sevenZ = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  assert.equal(L.classifyFile('20261124_POW_R.7z', sevenZ).kind, '7z');
  assert.equal(L.classifyFile('looks_like.zip', sevenZ).kind, '7z');          // a .zip that is really a 7z
  assert.equal(L.classifyFile('looks_like.7z', zip).kind, 'zip');             // and the other way round
  assert.equal(L.classifyFile('TPI flat files December 26.zip', zip).kind, 'zip');
  assert.deepEqual(L.classifyFile('rate_card_261126_EDFKraken.csv', new Uint8Array([0x55])), { kind: 'book', isCsv: true });
  assert.deepEqual(L.classifyFile('CE_PPB_Broker_Flat File.xlsb', new Uint8Array([0x50, 0x4b])), { kind: 'book', isCsv: false });
  assert.equal(L.classifyFile('prices.rar', new Uint8Array([1])).kind, 'unsupported');
  assert.equal(L.classifyFile('quote tool.pdf', new Uint8Array([1])).kind, 'not_book');
});

test('wantMember skips Mac resource forks and non-pricebooks', () => {
  assert.equal(L.wantMember('__MACOSX/._Elec.xlsx'), false);
  assert.equal(L.wantMember('folder/._Elec.xlsx'), false);
  assert.equal(L.wantMember('folder/Elec Acq Dec-26 vZ9 Flat File BKF - TPI.xlsx'), true);
  assert.equal(L.wantMember('readme.txt'), false);
});

test('knownArchive matches E.ON only', () => {
  assert.ok(L.knownArchive('sme_pricebook_sales_2026-11-27.zip'));
  assert.equal(L.knownArchive('TPI flat files December 26.zip'), null);
});

test('sheetPlan: the desk rules', () => {
  assert.deepEqual(L.sheetPlan('ugp_spark', ['Matrix', 'Spark Output Elec', 'Spark Output Gas'], 'both'),
    [{ name: 'Spark Output Elec', fuel: 'electricity' }, { name: 'Spark Output Gas', fuel: 'gas' }]);
  assert.throws(() => L.sheetPlan('ugp_spark', ['Matrix'], 'both'), /Spark Output/);
  assert.deepEqual(L.sheetPlan('ecotricity', ['Below73200_Matrix', 'Above73200_Matrix', 'Info'], 'gas'),
    [{ name: 'Above73200_Matrix', fuel: 'gas' }, { name: 'Below73200_Matrix', fuel: 'gas' }]);
  assert.deepEqual(L.sheetPlan('sefe', ['Single site pricing', 'AQ bands', 'Matrix prices'], 'gas'),
    [{ name: 'Single site pricing', fuel: 'gas' }, { name: 'AQ bands', fuel: 'gas' }, { name: 'Matrix prices', fuel: 'gas' }]);
  assert.deepEqual(L.sheetPlan('bkf', ['Front', 'BKF'], 'electricity'), [{ name: 'BKF', fuel: 'electricity' }]);
  assert.deepEqual(L.sheetPlan('bkf', ['UD Partner'], 'both'), [{ name: 'UD Partner', fuel: 'both' }]);
  assert.deepEqual(L.sheetPlan('corona', ['First'], 'gas'), [{ name: 'First', fuel: 'gas' }]);
});

test('matchProduct: sort_order first, bad regex is no match, other suppliers ignored', () => {
  const products = [
    { supplier_key: 'british_gas', product_key: 'standard', fuel: 'gas', sale_scope: 'acquisition', filename_match: '^standard_gas_acq', sort_order: 20 },
    { supplier_key: 'british_gas', product_key: 'standard_dsc', fuel: 'gas', sale_scope: 'acquisition', filename_match: '^standard_gas_acq_dsc', sort_order: 10 },
    { supplier_key: 'british_gas', product_key: 'broken', fuel: 'gas', sale_scope: 'any', filename_match: '([', sort_order: 1 },
    { supplier_key: 'edf', product_key: 'x', fuel: 'both', sale_scope: 'any', filename_match: 'standard', sort_order: 0 },
  ];
  assert.equal(L.matchProduct(products, 'Standard_Gas_Acq_DSC_V315.xlsx', 'british_gas').product_key, 'standard_dsc');
  assert.equal(L.matchProduct(products, 'folder/Standard_Gas_Acq_V315.xlsx', 'british_gas').product_key, 'standard');
  assert.equal(L.matchProduct(products, 'Natural_Gas.xlsx', 'british_gas'), null);
});

test('bookValidity and quoteUntil', () => {
  assert.deepEqual(L.bookValidity([{ quote_valid_to: '2026-11-27', quote_valid_from: '2026-11-27' }, { quote_valid_to: '2026-11-27' }]),
    { from: '2026-11-27', to: '2026-11-27' });
  assert.deepEqual(L.bookValidity([{ quote_valid_to: '2026-11-27' }, { quote_valid_to: null }]), { from: null, to: null });
  assert.deepEqual(L.bookValidity([]), { from: null, to: null });
  assert.equal(L.quoteUntil('2026-11-27', true), '2026-11-29');   // a daily supplier's Friday book
  assert.equal(L.quoteUntil('2026-11-27', false), '2026-11-27');
  assert.equal(L.quoteUntil('2026-11-26', true), '2026-11-26');
  assert.equal(L.quoteUntil(null, true), null);
});

test('newerLiveBook and previousBook: fuel and sale scope overlap', () => {
  const p = { product_key: 'standard', fuel: 'gas', sale_scope: 'acquisition' };
  const live = [
    { id: 'a', fuel: 'gas', sale_scope: 'acquisition', source_received_at: '2026-11-20T10:00:00Z' },
    { id: 'b', fuel: 'electricity', sale_scope: 'any', source_received_at: '2026-11-25T10:00:00Z' },
    { id: 'c', fuel: 'both', sale_scope: 'renewal', source_received_at: '2026-11-26T10:00:00Z' },
  ];
  assert.equal(L.newerLiveBook(live, p, '2026-11-21T00:00:00Z'), null);
  assert.equal(L.newerLiveBook(live, p, '2026-11-19T00:00:00Z').id, 'a');
  assert.equal(L.newerLiveBook(live, p, null), null);
  assert.equal(L.previousBook(live, p).id, 'a');
  assert.equal(L.previousBook(live, { product_key: 'x', fuel: 'both', sale_scope: 'any' }).id, 'c');
  assert.equal(L.previousBook([{ id: 'h', fuel: 'gas', sale_scope: null, uploaded_at: '2026-11-01T00:00:00Z' }], p).id, 'h');
});

test('sanityProblem: refused share is measured against the book it replaces', () => {
  const lim = L.limitsFrom({});
  // British Gas style: a third refused every week is normal.
  const prevBg = { rows_loaded: 100000, rows_refused: 50000 };
  assert.equal(L.sanityProblem('bg.xlsx', 100000, 51000, prevBg, null, {}, lim), null);
  assert.match(L.sanityProblem('bg.xlsx', 100000, 80000, prevBg, null, {}, lim), /80000 of 180000 rows refused/);
  // No previous book: the flat 2% floor.
  assert.match(L.sanityProblem('x.csv', 1000, 100, null, null, {}, lim), /100 of 1100 rows refused/);
  assert.equal(L.sanityProblem('x.csv', 1000, 40, null, null, {}, lim), null);       // under refusedMin
  // Row count and medians.
  const prev = { rows_loaded: 1000, rows_refused: 0 };
  assert.match(L.sanityProblem('x.csv', 700, 0, prev, null, {}, lim), /700 rows, against 1000/);
  assert.equal(L.sanityProblem('x.csv', 900, 0, prev, null, {}, lim), null);
  const med = L.sanityProblem('x.csv', 1000, 0, prev, { elec_rate: 20, gas_rate: null, standing: 30 }, { elec_rate: 26, gas_rate: 5, standing: 31 }, lim);
  assert.match(med, /median electricity rate 26\.00 p\/kWh, against 20\.00 p\/kWh/);
  assert.equal(L.sanityProblem('x.csv', 1000, 0, prev, { elec_rate: 20 }, { elec_rate: 24 }, lim), null);
  // Tunable from pricebook_mail_config.
  const loose = L.limitsFrom({ loader_rows_change: '0.5', loader_median_change: '0.4' });
  assert.equal(L.sanityProblem('x.csv', 700, 0, prev, { elec_rate: 20 }, { elec_rate: 26 }, loose), null);
});

test('bookMedians', () => {
  const m = L.bookMedians([
    { fuel: 'electricity', unit_rate_p_kwh: 20, standing_charge_p_day: 30 },
    { fuel: 'electricity', unit_rate_p_kwh: null, day_rate_p_kwh: 24, standing_charge_p_day: 40 },
    { fuel: 'gas', unit_rate_p_kwh: 6, standing_charge_p_day: 50 },
  ]);
  assert.deepEqual(m, { elec_rate: 22, gas_rate: 6, standing: 40 });
});

test('effectiveNotice: only verified, confident, future new_book notices', () => {
  const now = Date.parse('2026-11-27T18:45:00Z');
  const base = { kind: 'new_book', evidence_ok: true, confidence: 0.9, effective_from: '2026-11-30T00:00:00Z' };
  assert.equal(L.effectiveNotice([base], {}, now), base);
  assert.equal(L.effectiveNotice([{ ...base, evidence_ok: false }], {}, now), null);
  assert.equal(L.effectiveNotice([{ ...base, confidence: 0.6 }], {}, now), null);
  const lowConf = { ...base, confidence: 0.6 };
  assert.equal(L.effectiveNotice([lowConf], { notices_min_confidence: '0.5' }, now), lowConf);
  assert.equal(L.effectiveNotice([{ ...base, kind: 'expiry' }], {}, now), null);
  assert.equal(L.effectiveNotice([{ ...base, effective_from: '2026-11-27T00:00:00Z' }], {}, now), null);
  const later = { ...base, effective_from: '2026-12-01T00:00:00Z' };
  assert.equal(L.effectiveNotice([base, later], {}, now), later);
});

test('unreadNoticeWait: live mode only, 30 minutes only', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const row = { received_at: '2026-11-27T11:50:00Z' };
  assert.equal(L.unreadNoticeWait(row, [], { notices_mode: 'live' }, now), true);
  assert.equal(L.unreadNoticeWait(row, [{ id: 1 }], { notices_mode: 'live' }, now), false);
  assert.equal(L.unreadNoticeWait(row, [], { notices_mode: 'watch' }, now), false);
  assert.equal(L.unreadNoticeWait({ received_at: '2026-11-27T11:00:00Z' }, [], { notices_mode: 'live' }, now), false);
});

test('waitNote carries a time the kick can read back', () => {
  const t = Date.parse('2026-11-30T00:00:00Z');
  const note = L.waitNote(t, 'British Gas Lite');
  assert.match(note, /^waiting until Mon 30 Nov 00:00: British Gas Lite say this book goes live then \[until=2026-11-30T00:00:00\.000Z\]$/);
  assert.equal(L.waitUntilOf(note), t);
  assert.equal(L.waitUntilOf('automatic load held: x'), null);
});

test('pickRows: the eligibility rule, newest first, at most 12', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const mk = (i, over = {}) => ({ id: `r${i}`, status: 'new', kind: 'attachment', storage_path: `p${i}`, supplier_key: 'edf',
    received_at: new Date(now - i * 3600e3).toISOString(), status_note: null, ...over });
  const rows = [
    mk(1), mk(2, { supplier_key: 'eon_next' }), mk(3, { status_note: 'automatic load held: layout' }),
    mk(4, { status_note: 'needs a person: x' }), mk(5, { status: 'loaded' }), mk(6, { kind: 'link' }),
    mk(7, { storage_path: null }), mk(8, { received_at: new Date(now - 15 * 864e5).toISOString() }),
    mk(9, { status_note: 'automatic load failed (attempt 1 of 3), trying again on the next run: x' }),
    mk(10, { supplier_key: null }),
  ];
  assert.deepEqual(L.pickRows(rows, {}, now).map((r) => r.id), ['r1', 'r9']);
  assert.deepEqual(L.pickRows(rows, { loader_exclude: '' }, now).map((r) => r.id), ['r1', 'r2', 'r9']);
  const many = Array.from({ length: 20 }, (_, i) => mk(i + 1));
  assert.equal(L.pickRows(many, {}, now).length, L.MAX_FILES);
  assert.equal(L.pickRows(many, {}, now)[0].id, 'r1');
});

test('settleOutcome and inboxPatch: the decision table', () => {
  const now = '2026-11-27T12:00:00.000Z';
  const done = { name: 'a.csv', state: 'done', uploadId: 'u1', msg: 'ok' };
  const already = { name: 'b.csv', state: 'done', already: true, msg: 'already live' };
  const older = { name: 'c.csv', state: 'skipped', msg: 'older' };
  const notQ = { name: 'd.xlsx', state: 'blocked', notQuotable: true, msg: 'not quotable' };
  const layout = { name: 'e.xlsx', state: 'layout', msg: 'new layout' };
  const broke = { name: 'f.csv', state: 'error', msg: 'network' };
  const busy = { name: 'g.csv', state: 'busy', msg: 'somebody is loading' };

  let o = L.settleOutcome([done, already, older, notQ]);
  assert.equal(o.outcome, 'loaded'); assert.deepEqual(o.ids, ['u1']);
  assert.deepEqual(L.inboxPatch(o, { nowIso: now }), { status: 'loaded', status_note: null, handled_by_name: L.WHO, handled_at: now, upload_ids: ['u1'] });

  o = L.settleOutcome([already]);
  assert.equal(o.outcome, 'loaded');
  assert.equal(L.inboxPatch(o, { nowIso: now }).upload_ids, undefined);

  o = L.settleOutcome([older, notQ]);
  assert.equal(o.outcome, 'skipped');
  assert.match(L.inboxPatch(o, { nowIso: now }).status_note, /c\.csv: older; d\.xlsx: not quotable/);

  o = L.settleOutcome([done, layout]);
  assert.equal(o.outcome, 'held');
  const held = L.inboxPatch(o, { nowIso: now });
  assert.equal(held.status, 'new'); assert.match(held.status_note, /^automatic load held: e\.xlsx: new layout$/); assert.deepEqual(held.upload_ids, ['u1']);

  o = L.settleOutcome([done, broke, layout]);
  assert.equal(o.outcome, 'failed');
  assert.match(L.inboxPatch(o, { attempt: 1, nowIso: now }).status_note, /^automatic load failed \(attempt 1 of 3\), trying again/);
  assert.match(L.inboxPatch(o, { attempt: 3, nowIso: now }).status_note, /^automatic load held: it failed 3 times, last: f\.csv: network/);

  o = L.settleOutcome([busy, done]);
  assert.equal(o.outcome, 'busy');
  assert.match(L.inboxPatch(o, { nowIso: now }).status_note, /^automatic load waiting: /);

  assert.equal(L.settleOutcome([]).outcome, 'held');
});

test('ukDate and the BST rule agree around the clock changes', () => {
  for (const t of ['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T23:30:00Z', '2026-06-30T23:30:00Z', '2026-12-31T23:59:00Z']) {
    assert.equal(L.ukDate(Date.parse(t)), L.ukDateByRule(Date.parse(t)), t);
  }
  assert.equal(L.ukDate(Date.parse('2026-06-30T23:30:00Z')), '2026-07-01');
  assert.equal(L.ukDate(Date.parse('2026-12-31T23:59:00Z')), '2026-12-31');
});

test('limitsFrom and excludedSet', () => {
  assert.deepEqual(L.limitsFrom({}), L.LIMITS);
  assert.equal(L.limitsFrom({ loader_rows_change: 'nonsense' }).rowsChange, L.LIMITS.rowsChange);
  assert.deepEqual([...L.excludedSet({})], ['eon_next']);
  assert.deepEqual([...L.excludedSet({ loader_exclude: 'eon_next, sse' })], ['eon_next', 'sse']);
  assert.deepEqual([...L.excludedSet({ loader_exclude: '' })], []);
});

test('sha256Hex hashes strings as UTF-8, the same way the desk hashes a header', () => {
  assert.equal(L.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(L.sha256Hex(new TextEncoder().encode('abc')), L.sha256Hex('abc'));
});
