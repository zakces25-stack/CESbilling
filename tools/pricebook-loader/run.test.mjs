// run.test.mjs - the loader's whole flow against an in-memory store with the same interface as
// store.mjs, using the desk's REAL pricing-parsers.js on small synthetic files. Run: npm test
//
// The desk files are read from ../../public (the repo layout), or from PUBLIC_DIR, or from the
// unzipped upload at /tmp/ces_src/CESbilling-main/public when run outside the repo.
import './tz.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as L from './lib.mjs';
import { runLoader, loadDeskReader, redact } from './run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const JSZip = require('jszip');

function publicDir() {
  for (const p of [process.env.PUBLIC_DIR, join(HERE, '..', '..', 'public'), '/tmp/ces_src/CESbilling-main/public']) {
    if (p && existsSync(join(p, 'pricing-parsers.js')) && existsSync(join(p, 'pricing-7z.js')) && existsSync(join(p, 'pricing.html'))) return p;
  }
  throw new Error('set PUBLIC_DIR to a folder holding pricing-parsers.js, pricing-7z.js and pricing.html');
}
const DESK = loadDeskReader(publicDir());
const PP = DESK.PP;

const NOW = Date.parse('2026-11-27T12:00:00Z');       // a Friday
const ago = (min) => new Date(NOW - min * 60e3).toISOString();

// ---- synthetic books the real parsers accept --------------------------------------------------
const EDF_HEADER = ['Utility', 'SaleType', 'ContractDuration', 'MinimumAnnualConsumption', 'MaximumAnnualConsumption',
  'StandingCharge', 'UnitRate', 'DayRate', 'NightRate', 'DNOId', 'ProfileClass', 'RateStructure', 'TariffInformation2',
  'MinimumValidQuoteDate', 'MaximumValidQuoteDate', 'Min Selling Days', 'Max Selling Days'];
function edfCsv({ n = 100, validTo = '', rate = 25.1, sc = 30 } = {}) {
  const lines = [EDF_HEADER.join(',')];
  for (let i = 0; i < n; i++) {
    lines.push(['Electricity', 'Acquisition', 12 + 12 * (i % 3), 0, 100000, sc, rate, '', '', 10 + (i % 14), 3, 'Standard',
      'Fixed Online 1 Year', '', validTo, 1, 185].join(','));
  }
  return new TextEncoder().encode(lines.join('\r\n') + '\r\n');
}
const ECO_HEADER = ['PC', 'Digit Code', 'Region', 'Banding', 'SC p/day', 'Start Date', 'End Date', 'Single UR', 'Day UR', 'Night UR', 'LLFC'];
function ecoXlsx({ n = 40 } = {}) {
  const aoa = [ECO_HEADER];
  for (let i = 0; i < n; i++) {
    aoa.push([3, String(10 + (i % 14)), '_A', 'Band 1', 31.5, new Date(2026, 11, 1), new Date(2027, 10, 30), 24.75, null, null, '201']);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Power');
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const shaHeader = (cols) => L.sha256Hex(PP.normHeader(cols));

// ---- the in-memory store ---------------------------------------------------------------------
function fakeStore(over = {}) {
  const s = {
    config: { notices_mode: 'watch', notices_min_confidence: '0.8', loader_enabled: 'true', loader_exclude: 'eon_next', ...(over.config || {}) },
    inbox: [], files: new Map(), notices: [], runs: [], alerts: [], uploads: [], rates: [], archive: new Map(),
    suppliers: {
      edf: { supplier_key: 'edf', display_name: 'EDF', parser_key: 'bkf' },
      ecotricity: { supplier_key: 'ecotricity', display_name: 'Ecotricity', parser_key: 'ecotricity' },
      eon_next: { supplier_key: 'eon_next', display_name: 'E.ON Next', parser_key: 'bkf' },
    },
    cadence: { eon_next: 'daily' },
    products: [
      { supplier_key: 'edf', product_key: 'fixed_online', display_name: 'Fixed Online', fuel: 'both', sale_scope: 'any', filename_match: 'rate_card.*\\.csv$', quotable: true, sort_order: 10, green: null },
      { supplier_key: 'ecotricity', product_key: 'pricebook', display_name: 'Pricebook', fuel: 'electricity', sale_scope: 'any', filename_match: '^power_pricebook', quotable: true, sort_order: 10, green: null },
      { supplier_key: 'ecotricity', product_key: 'tool', display_name: 'Quote tool', fuel: 'electricity', sale_scope: 'any', filename_match: '^quote_tool', quotable: false, sort_order: 5, notes: 'not a book', green: null },
    ],
    fingerprints: [
      { id: 1, supplier_key: 'edf', parser_key: 'bkf', fuel: 'both', header_sha256: shaHeader(EDF_HEADER), active: true },
      { id: 2, supplier_key: 'ecotricity', parser_key: 'ecotricity', fuel: 'electricity', header_sha256: shaHeader(ECO_HEADER), active: true },
    ],
    failInsert: 0, claimRefuse: false, reaped: 0, sweeps: 0,
  };
  if (over.noFingerprints) s.fingerprints = [];
  const W = L.WHO;
  const store = {
    async config() { return { ...s.config }; },
    async candidateRows() {
      return s.inbox.filter((r) => r.status === 'new' && r.kind === 'attachment' && r.storage_path
        && NOW - Date.parse(r.received_at) <= L.ELIGIBLE_DAYS * 864e5).map((r) => ({ ...r }));
    },
    async inboxRow(id) { const r = s.inbox.find((x) => x.id === id); return r ? { ...r } : null; },
    async claim(row, mark, { explicit = false } = {}) {
      const r = s.inbox.find((x) => x.id === row.id);
      if (s.claimRefuse || !r || !(explicit ? ['new', 'failed'] : ['new']).includes(r.status)) return false;
      Object.assign(r, { status: 'loading', status_note: mark, handled_by_name: W });
      return true;
    },
    async heartbeatInbox() {},
    async settle(id, mark, patch) {
      const r = s.inbox.find((x) => x.id === id);
      if (!r || r.status !== 'loading' || r.status_note !== mark) return false;
      Object.assign(r, patch); return true;
    },
    async noteUnclaimed(id, note) { const r = s.inbox.find((x) => x.id === id); if (r && r.status === 'new') r.status_note = note; },
    async download(path) { if (!s.files.has(path)) throw new Error('no such object'); return s.files.get(path); },
    async noticesFor(row) { return s.notices.filter((n) => n.message_id === row.message_id); },
    async supplier(k) { return s.suppliers[k] || null; },
    async isDaily(k) { return s.cadence[k] === 'daily'; },
    async products(k) { return s.products.filter((p) => p.supplier_key === k); },
    async fingerprints(skey, fuel, h) {
      return { mine: s.fingerprints.filter((f) => f.supplier_key === skey && f.fuel === fuel && f.header_sha256 === h && f.active),
               elsewhere: s.fingerprints.filter((f) => f.header_sha256 === h && f.supplier_key !== skey) };
    },
    async duplicate(skey, sha) { return s.uploads.find((u) => u.supplier_key === skey && u.file_sha256 === sha && ['loading', 'parsed', 'live'].includes(u.status)) || null; },
    async liveBooks(skey, pk) { return s.uploads.filter((u) => u.supplier_key === skey && u.product_key === pk && u.status === 'live').map((u) => ({ ...u })); },
    async medians(id) { const m = L.bookMedians(s.rates.filter((r) => r.upload_id === id)); return m; },
    async storeArchive(id, name, bytes) { const path = `${id}/${name}.gz`; s.archive.set(path, bytes.byteLength); return { path, note: '' }; },
    async insertUpload(row) { s.uploads.push({ ...row }); },
    async failUpload(id, msg) { const u = s.uploads.find((x) => x.id === id); if (u) Object.assign(u, { status: 'failed', parse_error: msg }); },
    async insertRates(id, rates) {
      if (s.failInsert > 0) { s.failInsert--; throw new Error('inserting rates at row 0: simulated outage'); }
      let elec = 0;
      for (const r of rates) { s.rates.push({ ...r, upload_id: id }); if (r.fuel === 'electricity') elec++; }
      return { total: rates.length, elec };
    },
    async parseDone(a) {
      const u = s.uploads.find((x) => x.id === a.p_upload);
      if (!u || u.status !== 'loading') throw new Error('no longer loading');
      Object.assign(u, { rows_loaded: a.p_rows, rows_refused: a.p_refused, status: a.p_rows > 0 ? 'parsed' : 'rejected' });
    },
    async goLive(id) {
      const u = s.uploads.find((x) => x.id === id);
      const ov = (a, b, any) => a === b || a === any || b === any;
      const old = s.uploads.filter((x) => x.id !== id && x.status === 'live' && x.supplier_key === u.supplier_key && x.product_key === u.product_key
        && ov(x.fuel, u.fuel, 'both') && ov(x.sale_scope || 'any', u.sale_scope || 'any', 'any'));
      for (const x of old) x.status = 'replaced';
      u.status = 'live';
      return old.length;
    },
    async reapStale() { s.reaped++; },
    async sweepRates() {
      const dead = new Set(s.uploads.filter((u) => ['replaced', 'failed', 'deleted', 'rejected'].includes(u.status)).map((u) => u.id));
      const before = s.rates.length;
      s.rates = s.rates.filter((r) => !dead.has(r.upload_id));
      s.sweeps++;
      return { removed: before - s.rates.length };
    },
    async sweepFilesAndRows() { return { files: 0, purged: 0 }; },
    async priorFailures(id) { return s.runs.filter((r) => r.inbox_id === id && r.outcome === 'failed' && String(r.version).startsWith('pricebook-loader')).length; },
    async logRun(e) { s.runs.push({ ...e }); },
    async alert(id, subject, body) {
      if (s.alerts.some((a) => a.dedupe_key === `loader:${id}`)) return false;
      s.alerts.push({ dedupe_key: `loader:${id}`, subject, body }); return true;
    },
  };
  return { s, store };
}

function addInbox(s, { id = randomUUID(), file, bytes, supplier = 'edf', received = ago(120), messageId = `msg-${id}`, note = null, status = 'new' }) {
  const path = `2026-11-27/${id.slice(0, 8)}-${file}`;
  s.files.set(path, bytes);
  const row = { id, message_id: messageId, internet_message_id: `<${id}@example>`, received_at: received, sender: 'x@supplier',
    subject: 'Price change', supplier_key: supplier, kind: 'attachment', file_name: file, storage_path: path,
    status, status_note: note, upload_ids: null };
  s.inbox.push(row);
  return row;
}

function addLiveBook(s, { supplier = 'edf', product = 'fixed_online', fuel = 'both', received = '2026-11-20T10:00:00Z', rows = 100, refused = 0, rate = 25.1, sc = 30 }) {
  const id = randomUUID();
  s.uploads.push({ id, supplier_key: supplier, product_key: product, fuel, sale_scope: 'any', status: 'live', source_received_at: received,
    uploaded_at: received, rows_loaded: rows, rows_refused: refused, source_filename: 'old_book.csv', file_sha256: 'old' + id });
  for (let i = 0; i < Math.min(rows, 50); i++) s.rates.push({ upload_id: id, fuel: 'electricity', unit_rate_p_kwh: rate, standing_charge_p_day: sc });
  return id;
}

const deps = (store, env = {}, now = NOW, extra = {}) => ({ store, PP, SevenZip: DESK.SevenZip, XLSX, JSZip, env, now: () => now, uuid: randomUUID, log: () => {}, ...extra });
const inbox = (s, id) => s.inbox.find((r) => r.id === id);

// ---- the cases ------------------------------------------------------------------------------
test('loads an EDF CSV, replaces the live book and deletes its rates', async () => {
  const { s, store } = fakeStore();
  const oldId = addLiveBook(s, {});
  const row = addInbox(s, { file: 'rate_card_271126_EDFKraken.csv', bytes: edfCsv() });
  const res = await runLoader(deps(store));
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].outcome, 'loaded', res.files[0].message);
  const r = inbox(s, row.id);
  assert.equal(r.status, 'loaded');
  assert.equal(r.status_note, null);
  assert.equal(r.upload_ids.length, 1);
  const up = s.uploads.find((u) => u.id === r.upload_ids[0]);
  assert.equal(up.status, 'live');
  assert.equal(up.uploaded_by_name, L.WHO);
  assert.equal(up.inbox_id, row.id);
  assert.equal(up.source_received_at, row.received_at);
  assert.equal(up.rows_loaded, 100);
  assert.match(up.notes, /loaded_by=pricebook-loader/);
  assert.equal(s.uploads.find((u) => u.id === oldId).status, 'replaced');
  assert.equal(s.rates.filter((x) => x.upload_id === oldId).length, 0, 'replaced rates swept');
  assert.equal(s.rates.filter((x) => x.upload_id === up.id).length, 100);
  assert.equal(s.archive.size, 1);
  assert.equal(s.runs.at(-1).outcome, 'loaded');
  assert.equal(s.runs.at(-1).supplier_key, 'edf');
  assert.match(s.runs.at(-1).version, /^pricebook-loader .* \(GitHub\)$/);
  assert.equal(s.alerts.length, 0);
  assert.ok(s.reaped >= 1);
  // A second run finds nothing to do.
  const again = await runLoader(deps(store));
  assert.equal(again.files.length, 0);
});

test('an xlsx book loads through SheetJS with UK dates', async () => {
  const { s, store } = fakeStore();
  const row = addInbox(s, { file: 'Power_Pricebook_2026-11-27.xlsx', bytes: ecoXlsx(), supplier: 'ecotricity' });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'loaded', res.files[0].message);
  const up = s.uploads.find((u) => u.id === inbox(s, row.id).upload_ids[0]);
  const rates = s.rates.filter((x) => x.upload_id === up.id);
  assert.equal(rates.length, 40);
  assert.equal(rates[0].start_date_min, '2026-12-01');
  assert.equal(rates[0].term_months, 12);
});

test('a layout that is not registered is held once, with one alert, and not picked up again', async () => {
  const { s, store } = fakeStore({ noFingerprints: true });
  const row = addInbox(s, { file: 'Power_Pricebook_2026-11-27.xlsx', bytes: ecoXlsx(), supplier: 'ecotricity' });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'held');
  const r = inbox(s, row.id);
  assert.equal(r.status, 'new');
  assert.match(r.status_note, /^automatic load held: Power_Pricebook_2026-11-27\.xlsx: this layout is not registered for ecotricity\/electricity/);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].subject, /Pricebook NOT loaded automatically: Ecotricity/);
  assert.equal(s.uploads.length, 0);
  const again = await runLoader(deps(store));
  assert.equal(again.files.length, 0);
  assert.equal(s.alerts.length, 1);
});

test('a file no product rule matches is held', async () => {
  const { s, store } = fakeStore();
  const row = addInbox(s, { file: 'edf_prices_this_week.csv', bytes: edfCsv() });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'held');
  assert.match(inbox(s, row.id).status_note, /no product rule matches this filename/);
});

test('a product marked not quotable is skipped, not held', async () => {
  const { s, store } = fakeStore();
  const row = addInbox(s, { file: 'quote_tool_v2.xlsx', bytes: ecoXlsx(), supplier: 'ecotricity' });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'skipped');
  assert.equal(inbox(s, row.id).status, 'skipped');
  assert.match(inbox(s, row.id).status_note, /marked not quotable/);
});

test('a book older than the live one is skipped', async () => {
  const { s, store } = fakeStore();
  addLiveBook(s, { received: ago(30) });
  const row = addInbox(s, { file: 'rate_card_old.csv', bytes: edfCsv(), received: ago(240) });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'skipped');
  assert.equal(inbox(s, row.id).status, 'skipped');
  assert.match(inbox(s, row.id).status_note, /older than the book already live/);
});

test('a book past its own end date is skipped', async () => {
  const { s, store } = fakeStore();
  const row = addInbox(s, { file: 'rate_card_expired.csv', bytes: edfCsv({ validTo: '2026-11-20' }) });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'skipped');
  assert.match(inbox(s, row.id).status_note, /its prices ended on 2026-11-20/);
  assert.equal(s.uploads.length, 0);
});

test('a book far from the one it replaces is held (row count, then median rate)', async () => {
  const { s, store } = fakeStore();
  addLiveBook(s, { rows: 1000 });
  const row = addInbox(s, { file: 'rate_card_small.csv', bytes: edfCsv({ n: 100 }) });
  await runLoader(deps(store));
  assert.match(inbox(s, row.id).status_note, /^automatic load held: rate_card_small\.csv: 100 rows, against 1000/);

  const b = fakeStore();
  addLiveBook(b.s, { rows: 100, rate: 20 });
  const row2 = addInbox(b.s, { file: 'rate_card_dear.csv', bytes: edfCsv({ rate: 30 }) });
  const res2 = await runLoader(deps(b.store));
  assert.match(inbox(b.s, row2.id).status_note, /median electricity rate 30\.00 p\/kWh, against 20\.00 p\/kWh/);
  assert.match(redact(res2.files[0].message), /<n> p\/kWh/);
  assert.doesNotMatch(redact(res2.files[0].message), /30\.00 p\/kWh/);
});

test('live mode: an email the watcher has not read yet waits, untouched', async () => {
  const { s, store } = fakeStore({ config: { notices_mode: 'live' } });
  const row = addInbox(s, { file: 'rate_card_new.csv', bytes: edfCsv(), received: ago(5) });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'waiting');
  const r = inbox(s, row.id);
  assert.equal(r.status, 'new');
  assert.equal(r.status_note, null);
  assert.equal(s.uploads.length, 0);
  // Read by the watcher (nothing special in it): loads.
  s.notices.push({ id: 'n1', message_id: row.message_id, supplier_key: 'edf', kind: 'new_book', evidence_ok: true, confidence: 0.9, effective_from: null });
  const res2 = await runLoader(deps(store));
  assert.equal(res2.files[0].outcome, 'loaded', res2.files[0].message);
});

test('live mode: a book that goes live later waits until then, then loads', async () => {
  const { s, store } = fakeStore({ config: { notices_mode: 'live' } });
  const row = addInbox(s, { file: 'rate_card_monday.csv', bytes: edfCsv(), received: ago(120) });
  s.notices.push({ id: 'n1', message_id: row.message_id, supplier_key: 'edf', kind: 'new_book', evidence_ok: true, confidence: 0.95,
    effective_from: '2026-11-30T00:00:00Z' });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'waiting');
  const r = inbox(s, row.id);
  assert.equal(r.status, 'new');
  assert.match(r.status_note, /^waiting until Mon 30 Nov 00:00: EDF say this book goes live then \[until=2026-11-30T00:00:00\.000Z\]$/);
  assert.equal(s.uploads.length, 0);
  const logs = s.runs.length;
  await runLoader(deps(store));                      // same note: no second log line
  assert.equal(s.runs.length, logs);
  const res3 = await runLoader(deps(store, {}, Date.parse('2026-11-30T06:00:00Z')));
  assert.equal(res3.files[0].outcome, 'loaded', res3.files[0].message);
});

test('watch mode: the same notice loads at once and says it would have waited', async () => {
  const { s, store } = fakeStore({ config: { notices_mode: 'watch' } });
  const row = addInbox(s, { file: 'rate_card_monday.csv', bytes: edfCsv(), received: ago(5) });
  s.notices.push({ id: 'n1', message_id: row.message_id, supplier_key: 'edf', kind: 'new_book', evidence_ok: true, confidence: 0.95,
    effective_from: '2026-11-30T00:00:00Z' });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'loaded');
  assert.match(s.runs.at(-1).message, /would have waited until Mon 30 Nov 00:00/);
  assert.match(s.uploads.find((u) => u.status === 'live').notes, /would_have_waited/);
});

test('a failure is tried three times, then held with one alert', async () => {
  const { s, store } = fakeStore();
  s.failInsert = 5;
  const row = addInbox(s, { file: 'rate_card_flaky.csv', bytes: edfCsv() });
  let res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'failed');
  assert.match(inbox(s, row.id).status_note, /^automatic load failed \(attempt 1 of 3\), trying again on the next run: rate_card_flaky\.csv: inserting rates/);
  assert.equal(s.uploads[0].status, 'failed');
  res = await runLoader(deps(store));
  assert.match(inbox(s, row.id).status_note, /attempt 2 of 3/);
  res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'held');
  assert.match(inbox(s, row.id).status_note, /^automatic load held: it failed 3 times, last: /);
  assert.equal(s.alerts.length, 1);
  res = await runLoader(deps(store));
  assert.equal(res.files.length, 0);
  // A person can still force it once the outage is over.
  s.failInsert = 0;
  res = await runLoader(deps(store, { INBOX_ID: row.id }));
  assert.equal(res.files[0].outcome, 'loaded', res.files[0].message);
  assert.equal(inbox(s, row.id).status, 'loaded');
});

test('a plain zip: pricebooks loaded, Mac forks and other files ignored', async () => {
  const { s, store } = fakeStore();
  const zip = new JSZip();
  zip.file('TPI/rate_card_a.csv', edfCsv());
  zip.file('__MACOSX/TPI/._rate_card_a.csv', 'junk');
  zip.file('TPI/readme.txt', 'hello');
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  const row = addInbox(s, { file: 'EDF pack.zip', bytes });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'loaded', res.files[0].message);
  const up = s.uploads.find((u) => u.status === 'live');
  assert.equal(up.source_filename, 'rate_card_a.csv');
  assert.equal(up.zip_filename, 'EDF pack.zip');
  assert.equal(inbox(s, row.id).upload_ids.length, 1);
});

test('a 7z: members are unpacked to temp files and loaded one by one', async () => {
  const { s, store } = fakeStore();
  const head = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]);
  const csv = edfCsv();
  const fake7z = {
    list: () => [{ name: 'rate_card_x.csv', isDir: false }, { name: 'notes.pdf', isDir: false }],
    extract: async (_u8, { filter, onFile }) => {
      if (filter('rate_card_x.csv')) await onFile({ name: 'rate_card_x.csv', size: csv.length, chunks: [csv.subarray(0, 100), csv.subarray(100)] });
      return { files: ['rate_card_x.csv'] };
    },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'pbl-test-'));
  const row = addInbox(s, { file: '20261124_EDF_R.7z', bytes: head });
  const res = await runLoader(deps(store, {}, NOW, { SevenZip: fake7z, tmpDir: tmp }));
  assert.equal(res.files[0].outcome, 'loaded', res.files[0].message);
  assert.equal(s.uploads.find((u) => u.status === 'live').zip_filename, '20261124_EDF_R.7z');
  assert.ok(s.runs.at(-1).books.some((b) => b.book === '1 not a pricebook' && b.outcome === 'skipped'));
});

test('an E.ON style password zip opens with the saved password', { skip: !existsSync('/usr/bin/zip') }, async () => {
  const { s, store } = fakeStore({ config: { loader_exclude: '', autoload_eon_password: 'not-a-secret-1' } });
  s.products.push({ supplier_key: 'eon_next', product_key: 'standard_1yr', display_name: 'Standard 1 year', fuel: 'both', sale_scope: 'acquisition',
    filename_match: 'tpi_acquisition_1_year', quotable: true, sort_order: 10, green: null });
  s.fingerprints.push({ id: 3, supplier_key: 'eon_next', parser_key: 'bkf', fuel: 'both', header_sha256: shaHeader(EDF_HEADER), active: true });
  const dir = mkdtempSync(join(tmpdir(), 'pbl-zip-'));
  writeFileSync(join(dir, 'sme_pricebook_tpi_acquisition_1_year.csv'), edfCsv());
  writeFileSync(join(dir, 'sme_pricebook_tpi_acquisition_1_year_NC.csv'), edfCsv());
  const { execFileSync } = await import('node:child_process');
  execFileSync('/usr/bin/zip', ['-q', '-j', '-P', 'not-a-secret-1', join(dir, 'sme_pricebook_sales_2026-11-27.zip'),
    join(dir, 'sme_pricebook_tpi_acquisition_1_year.csv'), join(dir, 'sme_pricebook_tpi_acquisition_1_year_NC.csv')]);
  const bytes = new Uint8Array(readFileSync(join(dir, 'sme_pricebook_sales_2026-11-27.zip')));
  const row = addInbox(s, { file: 'sme_pricebook_sales_2026-11-27.zip', bytes, supplier: 'eon_next' });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'loaded', res.files[0].message);
  assert.ok(s.runs.at(-1).books.some((b) => /new connection pricebooks/.test(b.message || '')));
  assert.equal(inbox(s, row.id).status, 'loaded');
});

test('dry run: every check, nothing written but the log', async () => {
  const { s, store } = fakeStore();
  const row = addInbox(s, { file: 'rate_card_dry.csv', bytes: edfCsv() });
  const res = await runLoader(deps(store, { DRY_RUN: 'true' }));
  assert.equal(res.files[0].outcome, 'dry run');
  assert.match(res.files[0].message, /^1 of 1 would load/);
  assert.equal(inbox(s, row.id).status, 'new');
  assert.equal(s.uploads.length, 0);
  assert.equal(s.rates.length, 0);
  assert.equal(s.runs.at(-1).outcome, 'dry run');
});

test('excluded suppliers, switched off, and a lost claim', async () => {
  const a = fakeStore();
  addInbox(a.s, { file: 'sme_pricebook_sales_2026-11-27.zip', bytes: new Uint8Array([1]), supplier: 'eon_next' });
  assert.equal((await runLoader(deps(a.store))).files.length, 0);

  const b = fakeStore({ config: { loader_enabled: 'false' } });
  addInbox(b.s, { file: 'rate_card_off.csv', bytes: edfCsv() });
  const off = await runLoader(deps(b.store));
  assert.equal(off.off, true);
  assert.equal(b.s.uploads.length, 0);

  const c = fakeStore();
  c.s.claimRefuse = true;
  const row = addInbox(c.s, { file: 'rate_card_race.csv', bytes: edfCsv() });
  const res = await runLoader(deps(c.store));
  assert.equal(res.files[0].outcome, 'busy');
  assert.equal(inbox(c.s, row.id).status, 'new');
  assert.equal(c.s.uploads.length, 0);
});

test('the same bytes already live: the file settles as loaded without a second copy', async () => {
  const { s, store } = fakeStore();
  const bytes = edfCsv();
  s.uploads.push({ id: 'live1', supplier_key: 'edf', product_key: 'fixed_online', fuel: 'both', sale_scope: 'any', status: 'live',
    file_sha256: L.sha256Hex(bytes), uploaded_at: '2026-11-26T10:00:00Z', source_received_at: '2026-11-26T10:00:00Z', rows_loaded: 100, rows_refused: 0 });
  const row = addInbox(s, { file: 'rate_card_copy.csv', bytes });
  const res = await runLoader(deps(store));
  assert.equal(res.files[0].outcome, 'loaded');
  assert.equal(inbox(s, row.id).status, 'loaded');
  assert.equal(s.uploads.length, 1);
});

test('the parser version guard refuses a checkout the desk itself would refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbl-desk-'));
  const src = publicDir();
  for (const f of ['pricing-parsers.js', 'pricing-7z.js']) copyFileSync(join(src, f), join(dir, f));
  writeFileSync(join(dir, 'pricing.html'), "<script>const EXPECTS_PARSERS = '1999-01-01.1';</script>");
  assert.throws(() => loadDeskReader(dir), /expects parser version 1999-01-01\.1 but pricing-parsers\.js is/);
  writeFileSync(join(dir, 'pricing.html'), `<script>const EXPECTS_PARSERS = '${PP.VERSION}';</script>`);
  assert.equal(loadDeskReader(dir).expects, PP.VERSION);
});
