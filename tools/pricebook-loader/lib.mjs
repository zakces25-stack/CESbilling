// lib.mjs - the pure parts of the GitHub pricebook loader (CES, 28 Nov 2026).
//
// Everything here is a port of what the pricing desk already does in pricing.html (readWorkbook,
// sheetPlan, matchProduct, bookValidity, quoteUntil, newerLiveBook, settleInbox, the archive sniff
// in addFiles) or of what the E.ON edge autoload does (ukDate, bookMedians, sanityProblem). Nothing
// in here touches the network or the database, so all of it is tested in Node.
//
// Rule kept from both: the loader must never read a book differently from the desk. The parsers
// themselves are NOT here: run.mjs loads public/pricing-parsers.js from the same checkout the
// website is deployed from, and refuses to run when its version is not the one pricing.html expects.

import { createHash } from 'node:crypto';

export const VERSION = 'pricebook-loader 2026-11-28.1';
export const WHO = 'Automatic (mailbox loader)';
export const INBOX_BUCKET = 'pricebook-inbox';
export const FILES_BUCKET = 'pricebook-files';
export const BATCH = 1000;              // the desk's insert batch
export const IN_FLIGHT = 3;             // batches in flight at once
export const HEARTBEAT_EVERY = 20;      // batches between heartbeats, as the desk
export const MAX_FILES = 12;            // mailbox files per run
export const MAX_ATTEMPTS = 3;          // failed runs before a file is held for a person
export const STALE_MIN = 15;            // the desk's reaper interval
export const UNREAD_WAIT_MIN = 30;      // live mode: how long to wait for the mailbox watcher
export const ELIGIBLE_DAYS = 14;        // the collector closes older files anyway

/** The desk's own comparison limits for an automatic load, overridable from pricebook_mail_config. */
export const LIMITS = {
  rowsChange: 0.20,     // loader_rows_change
  medianChange: 0.25,   // loader_median_change
  refusedShare: 0.02,   // floor for the refused-rows share
  refusedSlack: 0.05,   // allowed rise in the refused share over the book being replaced
  refusedMin: 50,       // fewer refusals than this never hold a book
};

// ---- small helpers -------------------------------------------------------------------------
export const baseName = (n) => String(n || '').split(/[\\/]/).pop();
export const iso = (ms) => new Date(ms).toISOString();

export function sha256Hex(data) {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return h.digest('hex');
}

function num(x, dflt) {
  const n = Number(x);
  return x == null || x === '' || !Number.isFinite(n) ? dflt : n;
}

/** Limits for this run: the defaults, with the two the desk may tune from pricebook_mail_config. */
export function limitsFrom(cfg = {}) {
  return { ...LIMITS,
    rowsChange: num(cfg.loader_rows_change, LIMITS.rowsChange),
    medianChange: num(cfg.loader_median_change, LIMITS.medianChange) };
}

export const truthy = (v, dflt = false) => (v == null || v === '' ? dflt : String(v).trim().toLowerCase() === 'true');

export function excludedSet(cfg = {}) {
  const raw = cfg.loader_exclude == null ? 'eon_next' : String(cfg.loader_exclude);
  return new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

// ---- UK dates ------------------------------------------------------------------------------
/** The UK calendar date of an instant, as YYYY-MM-DD. The desk's "today" is a UK day. */
export function ukDate(ms) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms));
    const v = (t) => p.find((x) => x.type === t).value;
    return `${v('year')}-${v('month')}-${v('day')}`;
  } catch (_) {
    return ukDateByRule(ms);
  }
}

/** No time zone data: British Summer Time by the rule (last Sunday of March to last Sunday of October, 01:00 UTC). */
export function ukDateByRule(ms) {
  const y = new Date(ms).getUTCFullYear();
  const lastSun = (m) => { const d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); };
  const bst = ms >= lastSun(2) && ms < lastSun(9);
  return new Date(ms + (bst ? 3600e3 : 0)).toISOString().slice(0, 10);
}

/** "Mon 30 Nov 00:00", UK time, for notes a person reads. */
export function ukWhen(ms) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
    const v = (t) => (p.find((x) => x.type === t) || {}).value || '';
    return `${v('weekday')} ${v('day')} ${v('month')} ${v('hour')}:${v('minute')}`;
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

// ---- what the bytes are --------------------------------------------------------------------
const SIG_7Z = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const SIG_ZIP = [0x50, 0x4b, 0x03, 0x04];
const SIG_ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const startsWith = (u8, sig) => !!u8 && u8.length >= sig.length && sig.every((b, i) => u8[i] === b);

/**
 * How to open a stored mailbox file. As the desk's addFiles: for a .zip or .7z, what the bytes ARE
 * decides the reader, not the extension alone. (The desk only catches a .zip that is really a 7z;
 * a .7z that is really a zip is opened as a zip here rather than refused.)
 *   '7z' | 'zip' | 'book' (with isCsv) | 'unsupported' (rar, tar, gz) | 'not_book'
 */
export function classifyFile(name, head) {
  const n = String(name || '');
  const archiveName = /\.(zip|7z)$/i.test(n);
  if (startsWith(head, SIG_7Z) || (!head && /\.7z$/i.test(n))) return { kind: '7z' };
  if (/\.zip$/i.test(n) || (archiveName && (startsWith(head, SIG_ZIP) || startsWith(head, SIG_ZIP_EMPTY)))) return { kind: 'zip' };
  if (/\.(xlsx|xlsm|xlsb|csv)$/i.test(n)) return { kind: 'book', isCsv: /\.csv$/i.test(n) };
  if (/\.(rar|tar|gz|tgz)$/i.test(n)) return { kind: 'unsupported' };
  return { kind: 'not_book' };
}

/** A member of an archive the desk would queue: the four pricebook types, no Mac resource forks. */
export const MEMBER_RE = /\.(csv|xlsx|xlsm|xlsb)$/i;
export function wantMember(name) {
  const n = String(name || '');
  if (/(^|\/)__MACOSX\//i.test(n) || /(^|\/)\._/.test(n)) return false;
  return MEMBER_RE.test(n);
}

/**
 * Supplier archives the desk opens by itself (pricing.html KNOWN_ARCHIVES). E.ON Next's zip is
 * password protected; the password is not a secret (it is on their broker portal, the same for every
 * TPI) but it lives in pricebook_mail_config.autoload_eon_password rather than in this repo.
 */
export const KNOWN_ARCHIVES = [
  { label: 'E.ON Next', match: /(^|[^a-z])sme_pricebook.*\.zip$/i, passwordKey: 'autoload_eon_password',
    skip: (name) => /_NC\.csv$/i.test(name), skipWhy: 'new connection pricebooks, which CES does not quote' },
];
export const knownArchive = (name) => KNOWN_ARCHIVES.find((a) => a.match.test(String(name || ''))) || null;

// ---- reading a workbook (pricing.html readWorkbook / sheetToRows) --------------------------
/**
 * A CSV never goes through SheetJS: on TotalEnergies' 88 MB renewal power file it built one
 * property per cell and V8 refused. PricingParsers.csvRows reads it as plain arrays of strings,
 * which is what SheetJS with raw:true handed the parsers anyway. Parsed once and kept.
 *
 * Workbooks are read dense, with no formatted text: British Gas V313 (433,152 rows) took 2.3 GB
 * and 57 s sparse, 1.3 GB and 22 s dense, with every row of 40 real workbooks proved identical.
 * cellDates so dates arrive as Dates; the parsers read them with LOCAL getters, which is why the
 * loader runs with TZ=Europe/London like the desk's browsers.
 */
export function readWorkbook(XLSX, PP, bytes, isCsv) {
  if (isCsv) {
    const rows = PP.csvRows(new TextDecoder('utf-8').decode(bytes));
    return { names: ['Sheet1'], wb: { SheetNames: ['Sheet1'], Sheets: { Sheet1: rows }, csv: true } };
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true, cellText: false, cellNF: false, cellHTML: false });
  return { names: wb.SheetNames, wb };
}

export const sheetToRows = (XLSX, wb, name) => (wb.csv
  ? wb.Sheets[name]
  : XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: true }));

/**
 * Which sheets a parser reads, and what fuel each one is (pricing.html sheetPlan, unchanged).
 * UGP's rates hide in Spark Output Elec / Gas; Ecotricity gas is split over two sheets at
 * 73,200 kWh and both are real prices; SEFE needs its AQ bands and Single site pricing sheets
 * as lookups beside the one price sheet.
 */
export function sheetPlan(parserKey, names, fuel) {
  const pick = (n) => names.find((x) => x.toLowerCase() === n.toLowerCase());
  if (parserKey === 'ugp_spark') {
    const out = [];
    const e = pick('Spark Output Elec'), g = pick('Spark Output Gas');
    if (e && fuel !== 'gas') out.push({ name: e, fuel: 'electricity' });
    if (g && fuel !== 'electricity') out.push({ name: g, fuel: 'gas' });
    if (!out.length) throw new Error('no Spark Output sheet in this workbook');
    return out;
  }
  if (parserKey === 'ecotricity' && fuel !== 'electricity') {
    const out = names
      .filter((n) => /^(below|above)73200_matrix$/i.test(n.trim()))
      .sort()
      .map((n) => ({ name: n, fuel: 'gas' }));
    if (out.length) return out;
  }
  if (parserKey === 'sefe') {
    const price = names.find((n) => /matrix\s*prices/i.test(n))
               || names.find((n) => /flatfile|flat\s*file/i.test(n));
    if (!price) throw new Error('no SEFE price sheet: expected "Matrix prices" or a Flatfile sheet');
    const out = names
      .filter((n) => /aq\s*bands|single\s*site/i.test(n))
      .map((n) => ({ name: n, fuel: 'gas' }));
    out.push({ name: price, fuel: 'gas' });
    return out;
  }
  const preferred = pick('BKF') || pick('UD Partner') || pick('OutputFile') || pick('SSE Choice');
  return [{ name: preferred || names[0], fuel }];
}

// ---- product routing (pricing.html matchProduct) -------------------------------------------
/**
 * A regex per product, tried in sort_order so specific patterns win. No rule matches, no load:
 * a guess here is a wrong price on a signed contract.
 */
export function matchProduct(products, filename, skey) {
  const n = baseName(filename).toLowerCase();
  const cands = (products || [])
    .filter((p) => p.supplier_key === skey && p.filename_match)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  for (const p of cands) {
    let re;
    try { re = new RegExp(p.filename_match, 'i'); } catch (_) { continue; }
    if (re.test(n)) return p;
  }
  return null;
}

export const productLabel = (p) => (!p ? '' : `${p.display_name}${p.fuel === 'both' ? '' : ' / ' + p.fuel}${p.sale_scope === 'any' ? '' : ' / ' + p.sale_scope}`);

// ---- validity (pricing.html bookValidity / quoteUntil) -------------------------------------
/** The last day a parsed book may be quoted on, when every row says (E.ON: its own day). */
export function bookValidity(rows) {
  let from = null, to = null, all = rows.length > 0;
  for (const r of rows) {
    const t = r.quote_valid_to ? String(r.quote_valid_to).slice(0, 10) : null;
    if (!t) { all = false; break; }
    if (!to || t > to) to = t;
    const f = r.quote_valid_from ? String(r.quote_valid_from).slice(0, 10) : null;
    if (f && (!from || f < from)) from = f;
  }
  return all ? { from, to } : { from: null, to: null };
}

/** A DAILY supplier's Friday book also covers Saturday and Sunday (CES, 15 Nov 2026). */
export function quoteUntil(validTo, daily) {
  if (!validTo) return null;
  const isoDay = String(validTo).slice(0, 10);
  if (!daily) return isoDay;
  const d = new Date(isoDay + 'T00:00:00Z');
  if (isNaN(d) || d.getUTCDay() !== 5) return isoDay;
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
}

// ---- which live book a new one would replace (pricing.html newerLiveBook) ------------------
const overlap = (a, b, any) => a === b || a === any || b === any;
export const receivedMs = (u) => Date.parse(u.source_received_at || u.uploaded_at);

/** The live books in this product's slot: overlapping fuel ('both' overlaps all) and sale scope ('any' overlaps all). */
export function slotOf(liveBooks, product) {
  return (liveBooks || []).filter((u) => overlap(u.fuel, product.fuel, 'both')
    && overlap(u.sale_scope || 'any', product.sale_scope || 'any', 'any'));
}

/** A live book for the same product from a NEWER email (or dropped in by hand later). Never put an older book over it. */
export function newerLiveBook(liveBooks, product, receivedAt) {
  if (!receivedAt) return null;
  const t = Date.parse(receivedAt);
  return slotOf(liveBooks, product).find((u) => receivedMs(u) > t) || null;
}

/** The book this one would replace: the newest live book in its slot. */
export function previousBook(liveBooks, product) {
  return slotOf(liveBooks, product).sort((x, y) => receivedMs(y) - receivedMs(x))[0] || null;
}

// ---- sanity checks (pricebook-autoload, generalised) ---------------------------------------
function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Medians of a parsed book: the same measures as SQL pricebook_upload_medians. */
export function bookMedians(rows) {
  const rate = (r) => (r.unit_rate_p_kwh != null ? r.unit_rate_p_kwh : r.day_rate_p_kwh);
  return {
    elec_rate: median(rows.filter((r) => r.fuel === 'electricity').map(rate)),
    gas_rate: median(rows.filter((r) => r.fuel === 'gas').map(rate)),
    standing: median(rows.map((r) => r.standing_charge_p_day)),
  };
}

/**
 * Is a new book close enough to the one it replaces? A reason when it is not, null when it is.
 *
 * The refused-rows test is measured against the book being replaced, not the flat 2% the E.ON
 * autoload uses: British Gas refuses some 150,000 half-hourly lines in every book by design, so a
 * flat 2% would hold every British Gas book for ever. A book whose refused share jumps more than
 * five points over the last one is still held.
 */
export function sanityProblem(name, n, refused, prev, prevMed, newMed, limits = LIMITS) {
  const pre = name ? `${name}: ` : '';
  const share = refused / Math.max(1, n + refused);
  let prevShare = null;
  if (prev && prev.rows_loaded != null && prev.rows_refused != null) {
    prevShare = Number(prev.rows_refused) / Math.max(1, Number(prev.rows_loaded) + Number(prev.rows_refused));
  }
  const allowed = Math.max(limits.refusedShare, prevShare == null ? limits.refusedShare : prevShare + limits.refusedSlack);
  if (refused > limits.refusedMin && share > allowed) {
    return `${pre}${refused} of ${n + refused} rows refused`
      + (prevShare == null ? '' : ` (${(share * 100).toFixed(1)}%, against ${(prevShare * 100).toFixed(1)}% in the book it would replace)`);
  }
  if (!prev || !prev.rows_loaded) return null;
  const ch = Math.abs(n - prev.rows_loaded) / prev.rows_loaded;
  if (ch > limits.rowsChange) return `${pre}${n} rows, against ${prev.rows_loaded} in the book it would replace`;
  if (prevMed) {
    for (const [k, label] of [['elec_rate', 'median electricity rate'], ['gas_rate', 'median gas rate'],
                              ['standing', 'median standing charge']]) {
      if (prevMed[k] == null || newMed[k] == null) continue;
      const a = Number(prevMed[k]), b = newMed[k];
      if (!a) continue;
      if (Math.abs(b - a) / a > limits.medianChange) {
        const unit = k === 'standing' ? 'p/day' : 'p/kWh';
        return `${pre}${label} ${b.toFixed(2)} ${unit}, against ${a.toFixed(2)} ${unit} in the book it would replace`;
      }
    }
  }
  return null;
}

/** "153,216 profile class 0 ...; 2,880 ..." - the two biggest refusal reasons. */
export function topReasons(refusals) {
  const c = (refusals && refusals.counts) || {};
  const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return top.length ? top.map(([k, n]) => `${n} ${k}`).join('; ') : 'no reason recorded';
}

// ---- waiting on the mailbox watcher --------------------------------------------------------
/**
 * Live mode only: an email the mailbox watcher has not read yet, received under 30 minutes ago,
 * is left for the next run, so a book whose email says "goes live on Monday" is not loaded on the
 * Friday before the watcher has seen that.
 */
export function unreadNoticeWait(row, notices, cfg, nowMs) {
  if (String(cfg.notices_mode || 'watch') !== 'live') return false;
  if (notices && notices.length) return false;
  return nowMs - Date.parse(row.received_at) < UNREAD_WAIT_MIN * 60e3;
}

/** The notice saying this email's book goes live later: kind new_book, quote verified, confident, future. */
export function effectiveNotice(notices, cfg, nowMs) {
  const minConf = num(cfg.notices_min_confidence, 0.8);
  const hits = (notices || []).filter((n) => n && n.kind === 'new_book' && n.evidence_ok === true
    && Number(n.confidence) >= minConf && n.effective_from && Date.parse(n.effective_from) > nowMs);
  if (!hits.length) return null;
  // The latest of them: a book is live only once every notice about it allows it.
  return hits.sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from))[0];
}

/** Waiting rows carry the time in a form pricebook_loader_kick() can read back: [until=<ISO>]. */
export function waitNote(untilMs, supplierName) {
  return `waiting until ${ukWhen(untilMs)}: ${supplierName} say this book goes live then [until=${iso(untilMs)}]`;
}
export function waitUntilOf(note) {
  const m = /\[until=([^\]]+)\]/.exec(String(note || ''));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

// ---- which mailbox rows to take ------------------------------------------------------------
export const HELD_RE = /^automatic load held/i;
export const PERSON_RE = /^needs a person/i;

/** pricebook_loader_kick()'s rule, applied again here: the database query is the first cut, this is the last word. */
export function isEligible(row, cfg, nowMs, excluded = excludedSet(cfg)) {
  if (!row || row.status !== 'new' || row.kind !== 'attachment' || !row.storage_path) return false;
  if (!row.supplier_key || excluded.has(row.supplier_key)) return false;
  if (nowMs - Date.parse(row.received_at) > ELIGIBLE_DAYS * 864e5) return false;
  const note = String(row.status_note || '');
  if (HELD_RE.test(note) || PERSON_RE.test(note)) return false;
  return true;
}

export function pickRows(rows, cfg, nowMs, max = MAX_FILES) {
  const ex = excludedSet(cfg);
  return (rows || []).filter((r) => isEligible(r, cfg, nowMs, ex))
    .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))
    .slice(0, max);
}

// ---- what one mailbox file came to (pricing.html settleInbox, for an unattended loader) ----
/**
 * Item states, as the desk's queue:
 *   done (with uploadId when it went live, already:true when the same book was live), skipped
 *   (older / expired / not a pricebook), blocked+notQuotable (catalogue says CES does not sell it),
 *   busy (someone is loading the same file right now), layout / unrouted / held (needs a person),
 *   error (something broke), wait (effective date in the future).
 *
 * The desk writes 'failed' or 'needs a person'. Unattended, a hold must stop the next run picking
 * the file up again, so it is 'automatic load held: ...' (the edge autoload's wording, which the
 * eligibility rule and the kick both skip); a failure is retried on the next run up to three times.
 */
export function settleOutcome(items) {
  const ids = items.map((i) => i.uploadId).filter(Boolean);
  const broke = items.find((i) => i.state === 'error');
  const human = items.find((i) => ['layout', 'unrouted', 'held'].includes(i.state));
  const busy = items.find((i) => i.state === 'busy');
  const settled = (i) => i.state === 'done' || i.state === 'skipped' || (i.state === 'blocked' && i.notQuotable);
  const loadedAny = items.some((i) => i.state === 'done');
  if (broke) return { outcome: 'failed', why: `${broke.name}: ${broke.msg}`, ids };
  if (human) return { outcome: 'held', why: `${human.name}: ${human.msg}`, ids };
  if (busy) return { outcome: 'busy', why: `${busy.name}: ${busy.msg}`, ids };
  if (items.length && items.every(settled) && loadedAny) return { outcome: 'loaded', why: null, ids };
  if (items.length && items.every(settled)) {
    return { outcome: 'skipped', why: items.map((i) => `${i.name}: ${i.msg || i.state}`).join('; '), ids };
  }
  if (!items.length) return { outcome: 'held', why: 'nothing in the file to load', ids };
  return { outcome: 'held', why: items.map((i) => `${i.name}: ${i.state}`).join('; '), ids };
}

/** The pricebook_inbox patch for an outcome. attempt = this run's failure count including this one. */
export function inboxPatch(o, { attempt = 1, nowIso } = {}) {
  const cut = (s) => String(s || '').slice(0, 500);
  switch (o.outcome) {
    case 'loaded':
      return { status: 'loaded', status_note: null, handled_by_name: WHO, handled_at: nowIso, ...(o.ids.length ? { upload_ids: o.ids } : {}) };
    case 'skipped':
      return { status: 'skipped', status_note: cut(o.why), handled_by_name: WHO, handled_at: nowIso, ...(o.ids.length ? { upload_ids: o.ids } : {}) };
    case 'busy':
      return { status: 'new', status_note: cut(`automatic load waiting: ${o.why}`), handled_by_name: WHO, handled_at: nowIso };
    case 'failed':
      return attempt >= MAX_ATTEMPTS
        ? { status: 'new', status_note: cut(`automatic load held: it failed ${attempt} times, last: ${o.why}`), handled_by_name: WHO, handled_at: nowIso }
        : { status: 'new', status_note: cut(`automatic load failed (attempt ${attempt} of ${MAX_ATTEMPTS}), trying again on the next run: ${o.why}`), handled_by_name: WHO, handled_at: nowIso };
    case 'held':
    default:
      return { status: 'new', status_note: cut(`automatic load held: ${o.why}`), handled_by_name: WHO, handled_at: nowIso, ...(o.ids && o.ids.length ? { upload_ids: o.ids } : {}) };
  }
}
