// store.test.mjs - store.mjs through the REAL supabase-js client with a recording fetch, so every
// query it builds is a real PostgREST / Storage request (method, table, filters). Nothing leaves
// the machine. Run: npm test
import './tz.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createStore } from './store.mjs';
import { WHO } from './lib.mjs';

function recorder(answer = () => ({ status: 200, body: [] })) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (body && typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { /* raw */ } }
    const call = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: init.headers };
    calls.push(call);
    const a = answer(call);
    const payload = a.raw !== undefined ? a.raw : JSON.stringify(a.body);
    return new Response(payload, { status: a.status || 200, headers: { 'content-type': a.type || 'application/json' } });
  };
  const sb = createClient('https://example.supabase.co', 'service-key-for-tests', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch } });
  return { calls, sb };
}

const NOW = Date.parse('2026-11-27T12:00:00Z');

test('config, candidate rows and the claim build the right requests', async () => {
  const { calls, sb } = recorder((c) => {
    if (c.path.endsWith('/pricebook_mail_config')) return { body: [{ key: 'notices_mode', value: 'watch' }] };
    if (c.method === 'PATCH') return { body: [{ id: 'r1' }] };
    return { body: [] };
  });
  const store = createStore(sb, { now: () => NOW });
  assert.deepEqual(await store.config(), { notices_mode: 'watch' });
  await store.candidateRows();
  const cand = calls.at(-1);
  assert.equal(cand.path, '/rest/v1/pricebook_inbox');
  assert.equal(cand.query.status, 'eq.new');
  assert.equal(cand.query.kind, 'eq.attachment');
  assert.equal(cand.query.storage_path, 'not.is.null');
  assert.match(cand.query.received_at, /^gte\.2026-11-13T12:00:00/);
  assert.equal(cand.query.order, 'received_at.desc');

  assert.equal(await store.claim({ id: 'r1' }, 'automatic load in progress t1'), true);
  const claim = calls.at(-1);
  assert.equal(claim.method, 'PATCH');
  assert.equal(claim.query.id, 'eq.r1');
  assert.equal(claim.query.status, 'in.(new)');
  assert.equal(claim.body.status, 'loading');
  assert.equal(claim.body.handled_by_name, WHO);
  assert.equal(claim.body.status_note, 'automatic load in progress t1');
  await store.claim({ id: 'r1' }, 'm', { explicit: true });
  assert.equal(calls.at(-1).query.status, 'in.(new,failed)');

  await store.settle('r1', 'm', { status: 'loaded' });
  const st = calls.at(-1);
  assert.equal(st.query.status, 'eq.loading');
  assert.equal(st.query.status_note, 'eq.m');
});

test('notices: two lookups, a missing table is an empty answer', async () => {
  const { calls, sb } = recorder((c) => (c.path.endsWith('/pricebook_notices')
    ? { status: 404, body: { code: 'PGRST205', message: "Could not find the table 'public.pricebook_notices' in the schema cache" } }
    : { body: [] }));
  const store = createStore(sb, { now: () => NOW });
  assert.deepEqual(await store.noticesFor({ message_id: 'AAMk1', internet_message_id: '<x@y>', supplier_key: 'edf' }), []);
  assert.equal(calls[0].query.message_id, 'eq.AAMk1');
});

test('rates: 1,000 a batch, upload_id on every row, heartbeats, failure reported with its row', async () => {
  let inserts = 0;
  const { calls, sb } = recorder((c) => {
    if (c.method === 'POST' && c.path.endsWith('/pricebook_rates')) { inserts++; return { status: 201, raw: '' }; }
    return { body: [] };
  });
  const store = createStore(sb, { now: () => NOW });
  const rates = Array.from({ length: 41500 }, (_, i) => ({ fuel: i % 2 ? 'electricity' : 'gas', unit_rate_p_kwh: 20 }));
  const r = await store.insertRates('u1', rates, { inboxId: 'r1', mark: 'm' });
  assert.deepEqual(r, { total: 41500, elec: 20750 });
  assert.equal(inserts, 42);
  const posts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pricebook_rates'));
  assert.ok(posts.every((p) => Array.isArray(p.body) && p.body.length <= 1000 && p.body.every((x) => x.upload_id === 'u1')));
  const beats = calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/pricebook_uploads'));
  assert.equal(beats.length, 2);                 // after 20 and 40 batches
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/pricebook_inbox') && c.query.status === 'eq.loading'));

  const bad = recorder((c) => (c.method === 'POST' && c.path.endsWith('/pricebook_rates')
    ? { status: 400, body: { code: '23514', message: 'new row violates check constraint' } } : { body: [] }));
  await assert.rejects(createStore(bad.sb).insertRates('u1', rates.slice(0, 10)), /inserting rates at row 0: new row violates check constraint/);
});

test('rpc calls, sweep loop and the alert de-duplication', async () => {
  let sweeps = 0;
  const { calls, sb } = recorder((c) => {
    if (c.path.endsWith('/rpc/pricebook_go_live')) return { body: [{ superseded: 1, went_live: true, rates_removed: 0 }] };
    if (c.path.endsWith('/rpc/pricebook_sweep_orphan_rates')) { sweeps++; return { body: [{ removed: sweeps < 3 ? 20000 : 500, remaining: sweeps < 3 ? 1 : 0 }] }; }
    if (c.path.endsWith('/rpc/pricebook_upload_medians')) return { body: [{ elec_rate: 20, gas_rate: null, standing: 30, n: 10 }] };
    if (c.path.endsWith('/pricebook_alerts')) return { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    return { body: [] };
  });
  const store = createStore(sb, { now: () => NOW });
  assert.equal(await store.goLive('u1'), 1);
  assert.deepEqual(await store.sweepRates(), { removed: 40500 });
  assert.deepEqual(await store.medians('u0'), { elec_rate: 20, gas_rate: null, standing: 30, n: 10 });
  await store.parseDone({ p_upload: 'u1', p_rows: 1, p_elec: 1, p_gas: 0, p_refused: 0, p_refusals: [], p_version: null, p_window_open: null, p_window_close: null });
  assert.ok(calls.some((c) => c.path.endsWith('/rpc/pricebook_parse_done') && c.body.p_upload === 'u1'));
  assert.equal(await store.alert('r1', 's', 'b'), false);
  const al = calls.filter((c) => c.path.endsWith('/pricebook_alerts')).at(-1);
  assert.equal(al.body.dedupe_key, 'loader:r1');
  assert.equal(al.body.source, 'loader');
  await store.priorFailures('r1');
  const pf = calls.at(-1);
  assert.equal(pf.query.outcome, 'eq.failed');
  assert.match(pf.query.version, /^like\.pricebook-loader[%*]$/);   // PostgREST reads % and * alike
});

test('storage: the receipt copy is gzipped into pricebook-files', async () => {
  const { calls, sb } = recorder((c) => (c.path.includes('/storage/v1/object/') ? { body: { Key: 'pricebook-files/x' } } : { body: [] }));
  const store = createStore(sb, { now: () => NOW });
  const text = new TextEncoder().encode('a,b,c\n'.repeat(5000));
  const r = await store.storeArchive('u1', 'book.csv', text);
  assert.equal(r.path, 'u1/book.csv.gz');
  const up = calls.find((c) => c.path.includes('/storage/v1/object/pricebook-files/u1/book.csv.gz'));
  assert.ok(up, 'uploaded to pricebook-files');
});
