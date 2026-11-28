// store.mjs - everything the BG portal puller reads from or writes to Supabase, behind one small
// interface so run.mjs can be tested against an in-memory fake (run.test.mjs) with the same shape.
//
// Service role, because nobody is signed in on a GitHub runner. It only ever ADDS: a file in the
// pricebook-inbox bucket, a pricebook_inbox row, a run log line and (when something needs a person)
// an alert. It never changes a pricebook, a rate or a meter; the pricebook loader does the loading.

import { INBOX_BUCKET, SUPPLIER } from './lib.mjs';

async function rows(q, what) {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data || [];
}
const missingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message || ''));
const duplicate = (e) => !!e && (e.code === '23505' || /duplicate key|already exists/i.test(e.message || ''));

export function createStore(sb) {
  return {
    async config() {
      const r = await rows(sb.from('pricebook_mail_config').select('key, value'), 'reading pricebook_mail_config');
      return Object.fromEntries(r.map((x) => [x.key, x.value]));
    },

    /** British Gas books the desk or the loader already has (any of the states that count as having it). */
    async bgUploads() {
      return rows(sb.from('pricebook_uploads')
        .select('source_filename, status, uploaded_at, uploaded_by_name, product_key, pricebook_version')
        .eq('supplier_key', SUPPLIER).in('status', ['live', 'parsed', 'loading', 'superseded'])
        .order('uploaded_at', { ascending: false }).limit(300), 'reading the British Gas books on the desk');
    },

    /** Which of these portal documents are already in the mailbox store. */
    async collectedDocIds(docIds) {
      if (!docIds || !docIds.length) return new Set();
      const r = await rows(sb.from('pricebook_inbox').select('message_id')
        .in('message_id', docIds.map((id) => `bgportal:${id}`)), 'reading the mailbox store');
      return new Set(r.map((x) => String(x.message_id).replace(/^bgportal:/, '')));
    },

    /** The same bytes are already in the mailbox store (from the portal, or emailed by someone). */
    async inboxHasSha(sha) {
      const r = await rows(sb.from('pricebook_inbox').select('id').eq('sha256', sha).limit(1), 'checking the mailbox store');
      return r.length > 0;
    },

    /** {ok:true} or {ok:true, existed:true} when an earlier run left the same object there. */
    async upload(path, bytes, contentType) {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const { error } = await sb.storage.from(INBOX_BUCKET).upload(path, body, { contentType, upsert: false });
      if (!error) return { ok: true };
      if (duplicate(error) || /exists|409/i.test(String(error.statusCode || '') + ' ' + (error.message || ''))) return { ok: true, existed: true };
      throw new Error(`storing ${path}: ${error.message}`);
    },

    /** Best effort: an object nobody points at after a duplicate insert. */
    async removeObject(path) {
      try { await sb.storage.from(INBOX_BUCKET).remove([path]); } catch (_) { /* housekeeping */ }
    },

    /** {inserted:true, id} or {duplicate:true} (the unique sha256 index says it is already there). */
    async insertInbox(row) {
      const { data, error } = await sb.from('pricebook_inbox').insert(row).select('id');
      if (!error) return { inserted: true, id: data && data[0] && data[0].id };
      if (duplicate(error)) return { duplicate: true };
      throw new Error(`adding ${row.file_name} to the mailbox store: ${error.message}`);
    },

    /** The run log never fails a run; a missing table (migration not applied yet) is ignored. */
    async logRun(entry) {
      try {
        const { error } = await sb.from('pricebook_portal_runs').insert(entry);
        return !error;
      } catch (_) { return false; }
    },

    /** One email per outcome per UK day: the unique dedupe_key turns a second alert into a no-op. */
    async alert(subject, body, dedupeKey) {
      const { error } = await sb.from('pricebook_alerts').insert({ source: 'bgportal', subject, body, dedupe_key: dedupeKey });
      if (!error) return true;
      if (duplicate(error) || missingTable(error)) return false;
      throw new Error(`queueing the alert: ${error.message}`);
    },
  };
}
