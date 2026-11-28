// run.test.mjs - the BG portal puller's whole run against a fake portal and an in-memory store with the
// same interface as store.mjs. No browser, no network. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';
import { runPull, exitCodeFor } from './run.mjs';
import { createStore } from './store.mjs';

const NOW = Date.parse('2026-11-27T13:40:00Z');   // Friday afternoon, V317 just posted
const FOLDER = 'Energy Quote Tools & Flatfiles';
const PASSWORD = 'S3cret-Pa55word!';
const ENV = { BG_PORTAL_USERNAME: 'pricing@example.test', BG_PORTAL_PASSWORD: PASSWORD };

const LISTING = [
  ['Standard_Gas_Ren_V317.xlsx', '015R500000IesycIAB', '27/11/2026'],
  ['Standard_Gas_Ren_V316.xlsx', '015R500000IVbc2IAD', '20/11/2026'],
  ['Standard_Gas_Ren_DSC_V317.xlsx', '015R500000IetTFIAZ', '27/11/2026'],
  ['Standard_Gas_Acq_V317.xlsx', '015R500000IetQ1IAJ', '27/11/2026'],
  ['Standard_Gas_Acq_DSC_V317.xlsx', '015R500000IetJZIAZ', '27/11/2026'],
  ['Standard_Elec_V317.xlsx', '015R500000Iet6fIAB', '27/11/2026'],
  ['Standard_Elec_V316.xlsx', '015R500000IVc3RIAT', '20/11/2026'],
  ['Natural REGO_Elec_V317.xlsx', '015R500000IevjZIAR', '27/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_V317.xlsx', '015R500000IeteXIAR', '27/11/2026'],
  ['BGB_Gas_Broker_Tool_V317.xlsx', '015R500000Iet3RIAR', '27/11/2026'],
  ['BGB_Elec_Broker_Tool_V317.xlsb', '015R500000Iet1pIAB', '27/11/2026'],
];
const STANDARD_V317 = ['Standard_Elec_V317.xlsx', 'Standard_Gas_Acq_DSC_V317.xlsx', 'Standard_Gas_Acq_V317.xlsx',
  'Standard_Gas_Ren_DSC_V317.xlsx', 'Standard_Gas_Ren_V317.xlsx'];
const rawRows = () => LISTING.map(([name, id, modified]) => ({
  name, href: `/servlet/servlet.FileDownload?file=${id}`, description: '', size: '1 KB', type: 'xlsx', folder: FOLDER, modified,
}));
/** A small real-looking xlsx: PK header plus the name, so every file has its own sha. */
const xlsxBytes = (name) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(name)]);

function fakePortal(o = {}) {
  const calls = { login: [], list: 0, download: [], closed: 0 };
  return {
    calls,
    login: async (creds) => { calls.login.push(creds); if (o.loginThrows) throw new Error(o.loginThrows); return o.login || { ok: true }; },
    listDocuments: async ({ folderId }) => {
      calls.list++;
      if (o.listThrows) throw o.listThrows;
      return { rows: o.rows || rawRows(), folderLabel: FOLDER, how: 'datatable', folderId };
    },
    download: async (url) => {
      calls.download.push(url);
      const id = L.docIdOf(url);
      const hit = LISTING.find((x) => x[1] === id);
      if (o.download) return o.download(url, hit);
      return { status: 200, contentType: L.XLSX_TYPE, bytes: xlsxBytes(hit ? hit[0] : url) };
    },
    close: async () => { calls.closed++; },
  };
}

function memStore(o = {}) {
  const db = { config: { ...(o.config || {}) }, uploads: o.uploads || [], inbox: o.inbox || [], objects: new Map(), runs: [], alerts: [] };
  return {
    db,
    async config() { if (o.configThrows) throw new Error(o.configThrows); return db.config; },
    async bgUploads() { return db.uploads; },
    async collectedDocIds(ids) { return new Set(db.inbox.filter((r) => ids.includes(String(r.message_id).replace(/^bgportal:/, ''))).map((r) => String(r.message_id).replace(/^bgportal:/, ''))); },
    async inboxHasSha(sha) { return db.inbox.some((r) => r.sha256 === sha); },
    async upload(path, bytes) { if (db.objects.has(path)) return { ok: true, existed: true }; db.objects.set(path, bytes); return { ok: true }; },
    async removeObject(path) { db.objects.delete(path); },
    async insertInbox(row) {
      if (o.insertDuplicate || db.inbox.some((r) => r.sha256 === row.sha256)) return { duplicate: true };
      db.inbox.push({ id: `inbox-${db.inbox.length + 1}`, ...row });
      return { inserted: true, id: `inbox-${db.inbox.length}` };
    },
    async logRun(e) { db.runs.push(e); return true; },
    async alert(subject, body, key) {
      if (db.alerts.some((a) => a.key === key)) return false;
      db.alerts.push({ subject, body, key });
      return true;
    },
  };
}

async function run({ store = memStore(), portal = fakePortal(), env = ENV, now = NOW } = {}) {
  const logs = [];
  let opened = 0;
  const res = await runPull({ env, store, openPortal: async () => { opened++; return portal; }, now: () => now, log: (s) => logs.push(s) });
  return { res, store, portal, logs, opened };
}

test('Friday afternoon: the five Standard V317 books go into the mailbox store for the loader', async () => {
  const { res, store, portal, logs } = await run();
  assert.equal(res.outcome, 'ok');
  assert.equal(res.newFiles, 5);
  assert.equal(res.filesSeen, LISTING.length);
  assert.equal(exitCodeFor(res.outcome), 0);
  assert.deepEqual(store.db.inbox.map((r) => r.file_name).sort(), STANDARD_V317);
  for (const r of store.db.inbox) {
    assert.equal(r.kind, 'attachment');
    assert.equal(r.supplier_key, 'british_gas');
    assert.equal(r.status, 'new');
    assert.equal(r.status_note, 'collected from the BG partner portal');
    assert.match(r.message_id, /^bgportal:015R5/);
    assert.match(r.storage_path, /^bgportal\/2026-11-27\/015R5[A-Za-z0-9]+-Standard_/);
    assert.ok(store.db.objects.has(r.storage_path), 'the file is in the bucket');
    assert.equal(r.size_bytes, store.db.objects.get(r.storage_path).length);
    assert.equal(r.sha256, L.sha256Hex(store.db.objects.get(r.storage_path)));
    assert.equal(r.received_at, '2026-11-27T13:40:00.000Z');
  }
  // Only the wanted ones were downloaded: no REGO, no Carbon Neutral, no broker tools, no V316.
  assert.equal(portal.calls.download.length, 5);
  assert.equal(portal.calls.closed, 1);
  assert.equal(store.db.runs.length, 1);
  const run1 = store.db.runs[0];
  assert.equal(run1.portal, 'bg');
  assert.equal(run1.outcome, 'ok');
  assert.equal(run1.files_seen, LISTING.length);
  assert.equal(run1.files_new, 5);
  assert.equal(run1.dry_run, false);
  assert.equal(run1.version, L.VERSION);
  assert.equal(store.db.alerts.length, 0);
  assert.ok(!logs.join('\n').includes(PASSWORD), 'the password is never logged');
});

test('the next run: everything already collected, nothing downloaded twice', async () => {
  const store = memStore();
  await run({ store });
  const second = await run({ store, portal: fakePortal() });
  assert.equal(second.res.outcome, 'nothing_new');
  assert.equal(second.portal.calls.download.length, 0);
  assert.equal(store.db.inbox.length, 5);
  assert.equal(store.db.runs.at(-1).outcome, 'nothing_new');
});

test('already loaded by hand after BG posted it (Zak, Sat 28 Nov): nothing to do', async () => {
  const uploads = STANDARD_V317.map((n) => ({ source_filename: n, status: 'live', uploaded_at: '2026-11-28T13:06:30.042799+00:00', uploaded_by_name: 'Zak Ilic' }));
  const { res, portal } = await run({ store: memStore({ uploads }), now: Date.parse('2026-11-30T07:10:00Z') });
  assert.equal(res.outcome, 'nothing_new');
  assert.equal(portal.calls.download.length, 0);
  assert.ok(res.files.every((f) => f.outcome === 'skipped' && /already loaded on 2026-11-28 by Zak Ilic/.test(f.note)));
});

test('dry run: signs in, decides, downloads to check, stores nothing', async () => {
  const { res, store } = await run({ env: { ...ENV, DRY_RUN: 'true' } });
  assert.equal(res.outcome, 'dry_run');
  assert.equal(res.dry, true);
  assert.equal(store.db.inbox.length, 0);
  assert.equal(store.db.objects.size, 0);
  assert.equal(res.files.filter((f) => f.outcome === 'would collect').length, 5);
  assert.match(res.note, /^would collect 5: /);
  assert.equal(store.db.runs[0].dry_run, true);
  assert.equal(store.db.runs[0].outcome, 'dry_run');
});

test('switched off: no browser at all', async () => {
  const { res, opened, store } = await run({ store: memStore({ config: { bgportal_enabled: 'false' } }) });
  assert.equal(res.outcome, 'disabled');
  assert.equal(opened, 0);
  assert.equal(exitCodeFor(res.outcome), 0);
  assert.equal(store.db.runs[0].outcome, 'disabled');
});

test('no BG secrets: failed, logged, one alert, a red run, no browser', async () => {
  const { res, opened, store } = await run({ env: { BG_PORTAL_USERNAME: '', BG_PORTAL_PASSWORD: '' } });
  assert.equal(res.outcome, 'failed');
  assert.match(res.note, /BG_PORTAL_USERNAME and BG_PORTAL_PASSWORD/);
  assert.equal(opened, 0);
  assert.equal(exitCodeFor(res.outcome), 1);
  assert.equal(store.db.alerts.length, 1);
  assert.equal(store.db.alerts[0].key, 'bgportal:failed:2026-11-27');
  assert.equal(store.db.runs[0].outcome, 'failed');
});

test('a refused login: login_failed, one alert a day, nothing listed', async () => {
  const store = memStore();
  const portal = fakePortal({ login: { ok: false, outcome: 'login_failed', message: 'Your login attempt has failed.' } });
  const { res } = await run({ store, portal });
  assert.equal(res.outcome, 'login_failed');
  assert.equal(portal.calls.list, 0);
  assert.equal(portal.calls.closed, 1);
  assert.equal(store.db.alerts.length, 1);
  assert.equal(store.db.alerts[0].key, 'bgportal:login_failed:2026-11-27');
  assert.match(store.db.alerts[0].body, /Your login attempt has failed\./);
  assert.match(store.db.alerts[0].body, /BG_PORTAL_PASSWORD/);
  // The same day again: logged, but no second email.
  await run({ store, portal: fakePortal({ login: { ok: false, outcome: 'login_failed', message: 'again' } }) });
  assert.equal(store.db.alerts.length, 1);
  assert.equal(store.db.runs.length, 2);
  assert.equal(exitCodeFor('login_failed'), 1);
  assert.equal(portal.calls.login[0].password, PASSWORD, 'the password goes to the portal and nowhere else');
});

test('a verification code request: verification_required', async () => {
  const { res, store } = await run({ portal: fakePortal({ login: { ok: false, outcome: 'verification_required', message: 'the portal asked for an identity verification code' } }) });
  assert.equal(res.outcome, 'verification_required');
  assert.equal(store.db.alerts[0].key, 'bgportal:verification_required:2026-11-27');
});

test('a changed Documents page: layout_changed, nothing downloaded', async () => {
  let r = await run({ portal: fakePortal({ listThrows: new L.LayoutError('the folder list is not on the Documents page') }) });
  assert.equal(r.res.outcome, 'layout_changed');
  assert.match(r.res.note, /folder list/);
  assert.equal(r.store.db.alerts[0].key, 'bgportal:layout_changed:2026-11-27');
  r = await run({ portal: fakePortal({ rows: [] }) });
  assert.equal(r.res.outcome, 'layout_changed');
  r = await run({ portal: fakePortal({ rows: rawRows().filter((x) => !/^Standard_/.test(x.name)) }) });
  assert.equal(r.res.outcome, 'layout_changed');
  assert.match(r.res.note, /matches bgportal_files/);
  assert.equal(r.portal.calls.download.length, 0);
});

test('the session ends mid-run: an HTML page instead of a file is an error, not a book', async () => {
  const portal = fakePortal({ download: () => ({ status: 200, contentType: 'text/html', bytes: new TextEncoder().encode('<html>Login</html>') }) });
  const { res, store } = await run({ portal });
  assert.equal(res.outcome, 'failed');
  assert.equal(store.db.inbox.length, 0);
  assert.match(res.note, /not an Excel file \(the portal sent text\/html\)/);
  assert.equal(store.db.alerts.length, 1);
});

test('some files fail, some arrive: the new ones still count (ok) and the failures are emailed', async () => {
  const portal = fakePortal({ download: (url, hit) => (hit && hit[0] === 'Standard_Elec_V317.xlsx'
    ? { status: 500, contentType: 'text/html', bytes: new Uint8Array() }
    : { status: 200, contentType: L.XLSX_TYPE, bytes: xlsxBytes(hit[0]) }) });
  const { res, store } = await run({ portal });
  assert.equal(res.outcome, 'ok');
  assert.equal(res.newFiles, 4);
  assert.match(res.note, /^stored 4, but Standard_Elec_V317\.xlsx: the portal answered 500/);
  assert.equal(store.db.alerts.length, 1);
  assert.equal(store.db.alerts[0].key, 'bgportal:failed:2026-11-27');
});

test('the same bytes already in the mailbox (someone emailed it in): skipped quietly', async () => {
  const inbox = [{ id: 'x', message_id: 'AAMk-email', sha256: L.sha256Hex(xlsxBytes('Standard_Elec_V317.xlsx')), file_name: 'Standard_Elec_V317.xlsx' }];
  const { res, store } = await run({ store: memStore({ inbox }) });
  assert.equal(res.newFiles, 4);
  assert.equal(res.files.find((f) => f.name === 'Standard_Elec_V317.xlsx').outcome, 'skipped');
  assert.equal(store.db.alerts.length, 0);
});

test('a duplicate on insert (unique sha raced us): treated as collected, the orphan object removed', async () => {
  const store = memStore({ insertDuplicate: true });
  const { res } = await run({ store });
  assert.equal(res.newFiles, 0);
  assert.equal(res.outcome, 'nothing_new');
  assert.equal(store.db.objects.size, 0, 'no file left in the bucket that no row points at');
});

test('bgportal_hold_until_monday: the rows wait until 00:00 on Monday 30 Nov', async () => {
  const { store } = await run({ store: memStore({ config: { bgportal_hold_until_monday: 'true' } }) });
  assert.equal(store.db.inbox.length, 5);
  for (const r of store.db.inbox) {
    assert.match(r.status_note, /^waiting until Mon 30 Nov 00:00: /);
    assert.equal(L.waitUntilOf(r.status_note), Date.parse('2026-11-30T00:00:00Z'));
  }
});

test('a crash anywhere is failed, masked, logged, and the browser is still closed', async () => {
  const portal = fakePortal({ loginThrows: `page.fill: Timeout while typing ${PASSWORD}` });
  const { res, store, logs } = await run({ portal });
  assert.equal(res.outcome, 'failed');
  assert.ok(!res.note.includes(PASSWORD));
  assert.ok(!store.db.runs[0].note.includes(PASSWORD));
  assert.ok(!store.db.alerts[0].body.includes(PASSWORD));
  assert.ok(!logs.join('\n').includes(PASSWORD));
  assert.equal(portal.calls.closed, 1);
});

test('the database unreachable at the start: failed, and nothing else breaks', async () => {
  const { res, opened } = await run({ store: memStore({ configThrows: 'fetch failed' }) });
  assert.equal(res.outcome, 'failed');
  assert.match(res.note, /fetch failed/);
  assert.equal(opened, 0);
});

// ---- store.mjs against a fake supabase-js client ----------------------------------------------
function fakeSb(o = {}) {
  const calls = [];
  const q = (table) => {
    const st = { table, ops: [] };
    const chain = {
      select: (c) => { st.ops.push(['select', c]); return chain; },
      insert: (r) => { st.ops.push(['insert', r]); return chain; },
      eq: (c, v) => { st.ops.push(['eq', c, v]); return chain; },
      in: (c, v) => { st.ops.push(['in', c, v]); return chain; },
      order: () => chain,
      limit: () => chain,
      then: (res, rej) => { calls.push(st); return Promise.resolve(o.answer ? o.answer(st) : { data: [], error: null }).then(res, rej); },
    };
    return chain;
  };
  const storage = { from: (bucket) => ({
    upload: async (path, body, opt) => { calls.push({ bucket, upload: path, opt, size: body.length }); return o.upload ? o.upload(path) : { error: null }; },
    remove: async (paths) => { calls.push({ bucket, remove: paths }); return { error: null }; },
  }) };
  return { from: q, storage, calls };
}

test('store.mjs: the queries and writes it sends', async () => {
  const sb = fakeSb({ answer: (st) => {
    if (st.table === 'pricebook_inbox' && st.ops.some((x) => x[0] === 'insert')) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "pricebook_inbox_sha_uq"' } };
    if (st.table === 'pricebook_inbox') return { data: [{ message_id: 'bgportal:015R500000Iet6fIAB' }], error: null };
    if (st.table === 'pricebook_alerts') return { data: null, error: { code: '23505', message: 'duplicate key' } };
    if (st.table === 'pricebook_mail_config') return { data: [{ key: 'bgportal_enabled', value: 'true' }], error: null };
    return { data: [], error: null };
  } });
  const s = createStore(sb);
  assert.deepEqual(await s.config(), { bgportal_enabled: 'true' });
  assert.deepEqual([...await s.collectedDocIds(['015R500000Iet6fIAB'])], ['015R500000Iet6fIAB']);
  const inCall = sb.calls.find((c) => c.table === 'pricebook_inbox');
  assert.deepEqual(inCall.ops.find((x) => x[0] === 'in'), ['in', 'message_id', ['bgportal:015R500000Iet6fIAB']]);
  assert.deepEqual(await s.insertInbox({ file_name: 'x' }), { duplicate: true });
  assert.equal(await s.alert('s', 'b', 'bgportal:failed:2026-11-27'), false);
  assert.deepEqual(await s.upload('bgportal/x', new Uint8Array([1, 2, 3]), L.XLSX_TYPE), { ok: true });
  const up = sb.calls.find((c) => c.upload);
  assert.equal(up.bucket, 'pricebook-inbox');
  assert.equal(up.opt.upsert, false);
  assert.equal(up.size, 3);
  const bg = createStore(fakeSb());
  await bg.bgUploads();
  assert.equal(await bg.logRun({ portal: 'bg' }), true);
  const s2 = createStore(fakeSb({ upload: () => ({ error: { statusCode: '409', message: 'The resource already exists' } }) }));
  assert.deepEqual(await s2.upload('p', new Uint8Array([1]), L.XLSX_TYPE), { ok: true, existed: true });
  const s3 = createStore(fakeSb({ upload: () => ({ error: { statusCode: '413', message: 'Payload too large' } }) }));
  await assert.rejects(() => s3.upload('p', new Uint8Array([1]), L.XLSX_TYPE), /Payload too large/);
});
