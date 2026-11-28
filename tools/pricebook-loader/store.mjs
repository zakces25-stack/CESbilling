// store.mjs - everything the pricebook loader reads from or writes to Supabase, behind one small
// interface so run.mjs can be tested against an in-memory fake (run.test.mjs) with the same shape.
//
// Service role, because nobody is signed in on a GitHub runner. pricebook_can_admin() lets the
// service role through (it is how the E.ON edge autoload works), and RLS does not apply to it, so
// every write here is guarded by the same conditions the desk's own writes use.

import { gzipSync } from 'node:zlib';
import { INBOX_BUCKET, FILES_BUCKET, BATCH, IN_FLIGHT, HEARTBEAT_EVERY, ELIGIBLE_DAYS, WHO, iso } from './lib.mjs';

async function rows(q, what) {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data || [];
}
async function one(q, what) {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data || null;
}
const missingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message || ''));

export function createStore(sb, { now = () => Date.now() } = {}) {
  return {
    async config() {
      const r = await rows(sb.from('pricebook_mail_config').select('key, value'), 'reading pricebook_mail_config');
      return Object.fromEntries(r.map((x) => [x.key, x.value]));
    },

    /** Mailbox files waiting: the database's first cut, newest first. lib.pickRows has the last word. */
    async candidateRows() {
      return rows(sb.from('pricebook_inbox').select('*')
        .eq('status', 'new').eq('kind', 'attachment').not('storage_path', 'is', null)
        .gte('received_at', iso(now() - ELIGIBLE_DAYS * 864e5))
        .order('received_at', { ascending: false }).limit(100), 'reading the mailbox files');
    },

    async inboxRow(id) {
      return one(sb.from('pricebook_inbox').select('*').eq('id', id).maybeSingle(), 'reading that mailbox file');
    },

    /** Take a row so the desk, the cron and another run do not load it at the same time. */
    async claim(row, mark, { explicit = false } = {}) {
      const statuses = explicit ? ['new', 'failed'] : ['new'];
      const r = await rows(sb.from('pricebook_inbox')
        .update({ status: 'loading', handled_by_name: WHO, handled_at: iso(now()), status_note: mark })
        .eq('id', row.id).in('status', statuses).select('id'), 'claiming the mailbox file');
      return r.length > 0;
    },

    /** Keep the claim alive: pricebook_reap_stale reopens a 'loading' row whose handled_at is old. */
    async heartbeatInbox(id, mark) {
      await sb.from('pricebook_inbox').update({ handled_at: iso(now()) }).eq('id', id).eq('status', 'loading').eq('status_note', mark);
    },

    /** Settle a claimed row. Only while it is still ours: a reaped and re-claimed row is left alone. */
    async settle(id, mark, patch) {
      const r = await rows(sb.from('pricebook_inbox').update(patch).eq('id', id).eq('status', 'loading').eq('status_note', mark)
        .select('id'), 'settling the mailbox file');
      return r.length > 0;
    },

    /** A note on a row nobody has claimed (waiting for an effective date). */
    async noteUnclaimed(id, note) {
      await rows(sb.from('pricebook_inbox').update({ status_note: note }).eq('id', id).eq('status', 'new').select('id'), 'noting the mailbox file');
    },

    async download(path) {
      const { data, error } = await sb.storage.from(INBOX_BUCKET).download(path);
      if (error) throw new Error(`could not fetch the file from the mailbox store: ${error.message}`);
      return new Uint8Array(await data.arrayBuffer());
    },

    /** What the mailbox watcher said about this email. [] when the table is not there yet. */
    async noticesFor(row) {
      const cols = 'id, message_id, internet_message_id, supplier_key, kind, effective_from, valid_until, evidence_ok, confidence';
      const out = new Map();
      for (const [col, val] of [['message_id', row.message_id], ['internet_message_id', row.internet_message_id]]) {
        if (!val) continue;
        const { data, error } = await sb.from('pricebook_notices').select(cols).eq(col, val);
        if (error) { if (missingTable(error)) return []; throw new Error(`reading pricebook_notices: ${error.message}`); }
        for (const n of data || []) out.set(n.id, n);
      }
      return [...out.values()].filter((n) => !n.supplier_key || !row.supplier_key || n.supplier_key === row.supplier_key);
    },

    async supplier(skey) {
      return one(sb.from('pricebook_suppliers').select('supplier_key, display_name, parser_key, parser_ready')
        .eq('supplier_key', skey).maybeSingle(), 'reading the supplier');
    },
    async isDaily(skey) {
      const r = await one(sb.from('pricebook_supplier_cadence').select('cadence').eq('supplier_key', skey).maybeSingle(), 'reading the cadence');
      return r ? r.cadence === 'daily' : skey === 'eon_next';
    },
    async products(skey) {
      return rows(sb.from('pricebook_products').select('*').eq('supplier_key', skey), 'reading the products');
    },

    /** The layout gate: this exact header registered for this supplier and fuel, or somewhere else. */
    async fingerprints(skey, fuel, hSha) {
      const [mine, elsewhere] = await Promise.all([
        rows(sb.from('pricebook_fingerprints').select('id, parser_key').eq('supplier_key', skey).eq('fuel', fuel)
          .eq('header_sha256', hSha).eq('active', true).limit(1), 'fingerprint check'),
        rows(sb.from('pricebook_fingerprints').select('supplier_key, fuel').eq('header_sha256', hSha)
          .neq('supplier_key', skey).limit(5), 'cross-supplier check'),
      ]);
      return { mine, elsewhere };
    },

    /** The same bytes already loading, parsed or live for this supplier. */
    async duplicate(skey, fileSha) {
      const r = await rows(sb.from('pricebook_uploads').select('id, uploaded_at, status').eq('supplier_key', skey)
        .eq('file_sha256', fileSha).in('status', ['loading', 'parsed', 'live']).limit(1), 'duplicate check');
      return r[0] || null;
    },

    async liveBooks(skey, productKey) {
      return rows(sb.from('pricebook_uploads')
        .select('id, source_filename, source_received_at, uploaded_at, fuel, sale_scope, rows_loaded, rows_refused, file_sha256')
        .eq('supplier_key', skey).eq('product_key', productKey).eq('status', 'live'), 'live book check');
    },

    async medians(uploadId) {
      const r = await rows(sb.rpc('pricebook_upload_medians', { p_upload: uploadId }), 'medians of the live book');
      return r[0] || null;
    },

    /**
     * The receipt copy in pricebook-files, gzipped as the desk does (a pricebook is text and shrinks
     * about ten to one; TotalEnergies' 65.75 MB renewal file was once refused by the 50 MB limit).
     * A failure is a note on the upload row, never a reason not to load the rates.
     */
    async storeArchive(uploadId, name, bytes) {
      let body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), gz = false;
      try {
        const z = gzipSync(body);
        if (z.length < body.length) { body = z; gz = true; }
      } catch (_) { /* store raw */ }
      const path = `${uploadId}/${name}${gz ? '.gz' : ''}`;
      const { error } = await sb.storage.from(FILES_BUCKET).upload(path, body,
        { upsert: false, contentType: gz ? 'application/gzip' : 'application/octet-stream' });
      return error ? { path: null, note: ` archive_not_stored=${String(error.message).slice(0, 120)}` } : { path, note: '' };
    },

    async insertUpload(row) {
      await rows(sb.from('pricebook_uploads').insert(row).select('id'), 'create upload');
    },

    async failUpload(id, msg) {
      await sb.from('pricebook_uploads').update({ status: 'failed', parse_error: String(msg).slice(0, 500),
        parse_finished_at: iso(now()) }).eq('id', id);
    },

    /**
     * The rates, 1,000 a batch with three in flight. upload_id goes on in place (a 550,000-row
     * TotalEnergies book is not copied again just to add one field). Every 20 batches a heartbeat
     * tells the reaper this load is alive, on the upload row and on the claimed mailbox row.
     */
    async insertRates(uploadId, rates, { inboxId, mark, onProgress } = {}) {
      const total = rates.length;
      let next = 0, done = 0, failed = null, elec = 0;
      for (const r of rates) if (r.fuel === 'electricity') elec++;
      const worker = async () => {
        while (!failed && next < total) {
          const i = next; next += BATCH;
          const slice = rates.slice(i, i + BATCH);
          for (const r of slice) r.upload_id = uploadId;
          const { error } = await sb.from('pricebook_rates').insert(slice);
          if (error) { failed = new Error(`inserting rates at row ${i}: ${error.message}`); return; }
          done++;
          if (done % HEARTBEAT_EVERY === 0) {
            const t = iso(now());
            await Promise.all([
              sb.from('pricebook_uploads').update({ heartbeat_at: t }).eq('id', uploadId).then(() => {}, () => {}),
              inboxId && mark ? this.heartbeatInbox(inboxId, mark).then(() => {}, () => {}) : null,
            ]);
            if (onProgress) onProgress(Math.min(done * BATCH, total), total);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, Math.ceil(total / BATCH) || 1) }, worker));
      if (failed) throw failed;
      return { total, elec };
    },

    async parseDone(args) {
      const { error } = await sb.rpc('pricebook_parse_done', args);
      if (error) throw new Error(`recording the parse: ${error.message}`);
    },

    async goLive(uploadId) {
      const { data, error } = await sb.rpc('pricebook_go_live', { p_upload: uploadId });
      if (error) throw new Error(`going live: ${error.message}`);
      return (data && data[0] && data[0].superseded) || 0;
    },

    async reapStale(minutes) {
      try { await sb.rpc('pricebook_reap_stale', { p_minutes: minutes }); } catch (_) { /* housekeeping */ }
    },

    /** The replaced book's rates, in batches until none are left (the desk's sweepOrphanRates). */
    async sweepRates() {
      let total = 0;
      for (let pass = 0; pass < 200; pass++) {
        const { data, error } = await sb.rpc('pricebook_sweep_orphan_rates', { p_batch: 20000 });
        if (error) return { removed: total, error: error.message };
        const r = (data && data[0]) || {};
        const removed = Number(r.removed) || 0, left = Number(r.remaining) || 0;
        total += removed;
        if (left === 0 || removed === 0) break;
      }
      return { removed: total };
    },

    /** Source files of books that can never be quoted again, then their rows (the desk's sweepOrphanFiles + purge). */
    async sweepFilesAndRows() {
      const out = { files: 0, purged: 0 };
      try {
        const orphans = await rows(sb.from('pricebook_orphan_files').select('upload_id, storage_path').limit(500), 'orphan files');
        for (let i = 0; i < orphans.length; i += 50) {
          const slice = orphans.slice(i, i + 50);
          const del = await sb.storage.from(FILES_BUCKET).remove(slice.map((r) => r.storage_path));
          if (del.error) break;
          await sb.from('pricebook_uploads').update({ storage_path: null }).in('id', slice.map((r) => r.upload_id));
          out.files += slice.length;
        }
        const { data } = await sb.rpc('pricebook_purge_retired', { p_limit: 500 });
        out.purged = Number(data) || 0;
      } catch (e) {
        out.error = String(e.message || e).slice(0, 200);     // housekeeping never fails a load
      }
      return out;
    },

    /** How many earlier runs of THIS loader failed on this mailbox file. */
    async priorFailures(inboxId) {
      const r = await rows(sb.from('pricebook_autoload_runs').select('id').eq('inbox_id', inboxId).eq('outcome', 'failed')
        .like('version', 'pricebook-loader%'), 'reading earlier runs');
      return r.length;
    },

    async logRun(entry) {
      try { await sb.from('pricebook_autoload_runs').insert(entry); } catch (_) { /* the log never fails a load */ }
    },

    /** One email per mailbox file, ever: the unique dedupe_key turns a second alert into a no-op. */
    async alert(inboxId, subject, body) {
      const { error } = await sb.from('pricebook_alerts').insert({ source: 'loader', subject, body, dedupe_key: `loader:${inboxId}` });
      if (!error) return true;
      if (error.code === '23505' || /duplicate key/i.test(error.message || '')) return false;
      if (missingTable(error)) return false;
      throw new Error(`queueing the alert: ${error.message}`);
    },
  };
}
