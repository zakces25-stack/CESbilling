// run.mjs - the GitHub pricebook loader (CES, 28 Nov 2026).
//
// CES, 28 Nov 2026: "I would ideally like for all the pricebooks to load automatically into the
// website". The pricebook-mail edge function already COLLECTS every supplier's books from
// pricingteam@ into pricebook_inbox every 15 minutes; only E.ON Next then loaded itself (the
// pricebook-autoload edge function). Everything else waited for someone to press Load, and a
// TotalEnergies power book takes four to seven minutes of parsing per file, which no edge function
// (two seconds of CPU) can do. So this runs on a GitHub Actions runner instead, triggered by
// pricebook_loader_kick() (pg_cron) when a new book lands, with a two-hourly fallback schedule.
//
// WHAT IT DOES, per mailbox file (newest first, at most 12 a run, a 45 minute budget):
//   1. Live mode only (pricebook_mail_config.notices_mode = 'live'): an email the mailbox watcher
//      has not read yet, received under 30 minutes ago, is left for the next run.
//   2. A watcher notice saying this email's book "goes live on <date>" holds it until then (live
//      mode and loader_respect_effective_from); in watch mode it loads and says it would have waited.
//   3. Claims the row (status 'loading'), unpacks it exactly as the desk's addFiles does (7z, zip,
//      E.ON's password zip, single files), routes each file to a product by its name, and loads each
//      through the desk's processOne gates in the desk's order: product rule, quotable, layout
//      fingerprint, same file already live, newer book already live, parse, nothing parsed, expired.
//   4. Then the E.ON autoload's comparison with the book it would replace (refused rows, row count,
//      median rates and standing charge), stores the receipt copy, inserts the rates, records the
//      parse, goes live and deletes the replaced book's rates straight away, as the desk does.
//   5. Settles the mailbox row. Anything a person must look at is 'automatic load held: <why>' with
//      ONE alert email (pricebook_alerts, sent by the pricebook-notices function). A failure is tried
//      again on the next run, and held with an alert after three.
// Every outcome is a line in pricebook_autoload_runs, version 'pricebook-loader ... (GitHub)'.
//
// THE DESK'S OWN READER. public/pricing-parsers.js and public/pricing-7z.js are loaded from the same
// checkout the website deploys from, and the run stops if pricing-parsers.js is not the version
// pricing.html expects, so the loader can never read a book differently from the desk.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required); INBOX_ID (one file only, may be a held
// or failed one); DRY_RUN=true (every check, nothing written but the run log); RUN_BUDGET_MIN (45);
// PUBLIC_DIR (defaults to ../../public).

import './tz.mjs';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as L from './lib.mjs';
import { createStore } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(import.meta.url);

/** The desk's reader, from the checkout, refused unless pricing.html expects exactly this version. */
export function loadDeskReader(publicDir) {
  const parsersPath = join(publicDir, 'pricing-parsers.js');
  const sevenPath = join(publicDir, 'pricing-7z.js');
  const htmlPath = join(publicDir, 'pricing.html');
  for (const p of [parsersPath, sevenPath, htmlPath]) {
    if (!existsSync(p)) throw new Error(`the desk's ${p.split(/[\\/]/).pop()} is not in ${publicDir}`);
  }
  const PP = requireHere(parsersPath);
  const SevenZip = requireHere(sevenPath);
  const m = /const\s+EXPECTS_PARSERS\s*=\s*'([^']+)'/.exec(readFileSync(htmlPath, 'utf8'));
  if (!m) throw new Error('pricing.html does not say which parser version it expects (EXPECTS_PARSERS)');
  if (!PP || typeof PP.parse !== 'function' || typeof PP.csvRows !== 'function') throw new Error('pricing-parsers.js did not load');
  if (PP.VERSION !== m[1]) {
    throw new Error(`pricing.html expects parser version ${m[1]} but pricing-parsers.js is ${PP.VERSION}. `
      + 'The desk refuses to parse in that state and so does this loader. Fix the checkout first.');
  }
  if (!SevenZip || typeof SevenZip.extract !== 'function') throw new Error('pricing-7z.js did not load');
  return { PP, SevenZip, expects: m[1] };
}

/** No rates in the GitHub log: numbers with a price unit are blanked (the database log keeps them). */
export const redact = (s) => String(s == null ? '' : s)
  .replace(/-?\d[\d,]*(\.\d+)?\s*p\/(kWh|day|kVA\/month|kva\/month)/gi, '<n> p/$2');

// ---------------------------------------------------------------------------------------------
export async function runLoader(d) {
  const log = d.log || (() => {});
  const t0 = d.now();
  const dry = L.truthy(d.env.DRY_RUN);
  const cfg = await d.store.config();
  const out = { version: L.VERSION, dry, files: [] };
  if (!dry && !L.truthy(cfg.loader_enabled, true)) {
    log('pricebook_mail_config.loader_enabled is false: nothing loaded.');
    out.off = true;
    return out;
  }
  if (!dry) await d.store.reapStale(L.STALE_MIN);
  const limits = L.limitsFrom(cfg);
  const budgetMs = Number(d.env.RUN_BUDGET_MIN || 45) * 60e3;

  const explicitId = String(d.env.INBOX_ID || '').trim();
  let todo;
  if (explicitId) {
    const r = await d.store.inboxRow(explicitId);
    if (!r) { log(`No mailbox file ${explicitId}.`); return out; }
    if (r.kind !== 'attachment' || !r.storage_path) { log(`${r.file_name || explicitId}: no stored file to load.`); return out; }
    if (!['new', 'failed'].includes(r.status)) { log(`${r.file_name}: it is ${r.status}, so it is left alone.`); return out; }
    todo = [r];
  } else {
    todo = L.pickRows(await d.store.candidateRows(), cfg, d.now());
  }
  if (!todo.length) log('Nothing waiting in the mailbox.');

  for (const row of todo) {
    if (d.now() - t0 > budgetMs) { log('Time budget used: the rest wait for the next run.'); break; }
    let res;
    try {
      res = await handleRow(d, cfg, limits, row, { dry, explicit: !!explicitId });
    } catch (e) {
      // A fault in the loader itself, not in a book: say so and carry on with the next file.
      res = { file: row.file_name, supplier: row.supplier_key, outcome: 'error', message: String(e && e.message || e) };
    }
    out.files.push(res);
    log(`${res.supplier || ''} ${res.file}: ${res.outcome}${res.message ? ': ' + redact(res.message) : ''}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
async function handleRow(d, cfg, limits, row, o) {
  const now = d.now();
  const skey = row.supplier_key;
  const supplier = (await d.store.supplier(skey)) || { supplier_key: skey, display_name: skey, parser_key: null };
  const supName = supplier.display_name || skey;
  const notices = await d.store.noticesFor(row);
  const live = String(cfg.notices_mode || 'watch') === 'live';
  const base = { supplier_key: skey, inbox_id: row.id, file_name: row.file_name, version: `${L.VERSION} (GitHub)` };
  const res = { file: row.file_name, supplier: skey };

  // 1. Live mode: let the mailbox watcher read the email first.
  if (!o.explicit && L.unreadNoticeWait(row, notices, cfg, now)) {
    const msg = 'the mailbox watcher has not read this email yet; trying again on the next run';
    await d.store.logRun({ ...base, outcome: 'waiting', message: msg });
    return { ...res, outcome: 'waiting', message: msg };
  }

  // 2. "Goes live on Monday": wait in live mode, say so in watch mode.
  const eff = L.effectiveNotice(notices, cfg, now);
  let wouldWait = null;
  if (eff) {
    const until = Date.parse(eff.effective_from);
    if (live && L.truthy(cfg.loader_respect_effective_from, true) && !o.explicit) {
      const note = L.waitNote(until, supName);
      const msg = `${supName} say this book goes live ${L.ukWhen(until)}; it loads then`;
      if (row.status_note !== note) {
        if (!o.dry) await d.store.noteUnclaimed(row.id, note);
        await d.store.logRun({ ...base, outcome: o.dry ? 'dry run' : 'waiting', message: msg });
      }
      return { ...res, outcome: 'waiting', message: msg };
    }
    wouldWait = `would have waited until ${L.ukWhen(until)} (${supName} say this book goes live then); `
      + 'loaded now because the mailbox watcher is in watch mode';
  }

  // 3. Claim it, so the desk, the cron and another run cannot load it alongside.
  const token = d.uuid();
  const mark = `automatic load in progress ${token}`;
  if (!o.dry && !(await d.store.claim(row, mark, { explicit: o.explicit }))) {
    const msg = 'someone else took this file first';
    await d.store.logRun({ ...base, outcome: 'busy', message: msg, token });
    return { ...res, outcome: 'busy', message: msg };
  }

  // 4. Unpack, route, load. Inside the try: once the row is claimed, any fault settles it as a
  // failure (tried again next run) rather than leaving it at 'loading' for the reaper.
  let items = [];
  let tmp = null;
  try {
    const ctx = { row, cfg, limits, supplier, dry: o.dry, mark, wouldWait,
                  today: L.ukDate(now), daily: await d.store.isDaily(skey), products: await d.store.products(skey) };
    tmp = mkdtempSync(join(d.tmpDir || tmpdir(), 'pricebook-'));
    const bytes = await d.store.download(row.storage_path);
    items = await expand(d, cfg, row, bytes, tmp);
    route(items, ctx.products, skey);
    for (const it of items) {
      if (it.state !== 'queued') continue;
      it.state = 'busy-loading';
      try { await processItem(d, ctx, it); }
      catch (e) { it.state = 'error'; it.msg = String(e && e.message || e); }
      finally { it.bytes = null; }
    }
  } catch (e) {
    items.push({ name: row.file_name, state: 'error', msg: String(e && e.message || e) });
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp space */ } }
  }

  const books = items.map((i) => ({ book: i.name, outcome: i.state, message: i.msg || null }));
  const settled = L.settleOutcome(items.filter((i) => i.state !== 'would load'));
  if (o.dry) {
    const would = items.filter((i) => i.state === 'would load').length;
    const msg = `${would} of ${items.length} would load${items.some((i) => i.state !== 'would load')
      ? '; ' + items.filter((i) => i.state !== 'would load').map((i) => `${i.name}: ${i.msg || i.state}`).join('; ') : ''}`
      + (wouldWait ? `. ${wouldWait}` : '');
    await d.store.logRun({ ...base, outcome: 'dry run', message: msg.slice(0, 1000), books });
    return { ...res, outcome: 'dry run', message: msg };
  }

  // 5. Settle, alert, tidy, log.
  let attempt = 1;
  if (settled.outcome === 'failed') attempt = (await d.store.priorFailures(row.id)) + 1;
  const patch = L.inboxPatch(settled, { attempt, nowIso: L.iso(d.now()) });
  await d.store.settle(row.id, mark, patch);
  const outcome = settled.outcome === 'failed' && attempt >= L.MAX_ATTEMPTS ? 'held' : settled.outcome;
  let alerted = false;
  if (outcome === 'held') {
    const loaded = items.filter((i) => i.state === 'done' && i.uploadId).map((i) => i.name);
    alerted = await d.store.alert(row.id,
      `Pricebook NOT loaded automatically: ${supName}, ${row.file_name}`,
      `The ${supName} pricebook ${row.file_name} (email of ${L.ukWhen(Date.parse(row.received_at))}) was not loaded automatically:\n\n`
      + `  ${patch.status_note.replace(/^automatic load held: /, '')}\n\n`
      + (loaded.length ? `These books from the same file did go live: ${loaded.join(', ')}.\n\n` : 'Nothing from this file went live.\n\n')
      + 'Please check it and load it by hand on the pricing desk (Pricebooks, Mailbox).\n\n'
      + `${L.VERSION} on GitHub Actions`);
  }
  if (items.some((i) => i.state === 'done' && i.uploadId)) res.housekeeping = await d.store.sweepFilesAndRows();
  const msg = outcome === 'loaded'
    ? items.filter((i) => i.state === 'done').map((i) => `${i.name}: ${i.msg}`).join('; ') + (wouldWait ? `. ${wouldWait}` : '')
    : patch.status_note || settled.why || '';
  await d.store.logRun({ ...base, outcome, message: String(msg).slice(0, 1000), books, token, alerted });
  return { ...res, outcome, message: msg, books };
}

// ---------------------------------------------------------------------------------------------
/**
 * One mailbox file into queue items, as the desk's addFiles. Unlike the desk, a file that cannot
 * be opened at all is 'held' (a person must look) rather than 'error' (which is retried): an
 * encrypted zip with no password, or a .rar, will not open on the second try either.
 */
async function expand(d, cfg, row, bytes, tmp) {
  const items = [];
  const name = row.file_name || 'pricebook';
  const c = L.classifyFile(name, bytes.subarray(0, 6));
  if (c.kind === '7z') {
    try {
      const names = d.SevenZip.list(bytes).filter((e) => !e.isDir).map((e) => e.name);
      let k = 0;
      await d.SevenZip.extract(bytes, {
        filter: (n) => L.MEMBER_RE.test(n),
        onFile: async ({ name: n, size, chunks }) => {
          // On disk, not in memory: four 200+ MB TotalEnergies CSVs are not held at once.
          const path = join(tmp, `${k++}-${L.baseName(n).replace(/[^A-Za-z0-9._-]+/g, '_')}`);
          writeFileSync(path, Buffer.concat((chunks || []).map((u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength))));
          items.push({ name: L.baseName(n), zipName: name, size, path, isCsv: /\.csv$/i.test(n), state: 'queued' });
        },
      });
      const left = names.filter((n) => !L.MEMBER_RE.test(n));
      if (left.length) items.push({ name: `${left.length} not a pricebook`, zipName: name, state: 'skipped', msg: left.map(L.baseName).join(', ') });
    } catch (e) {
      items.push({ name, state: 'held', msg: `could not unpack ${name}: ${e.message}` });
    }
  } else if (c.kind === 'zip') {
    const known = L.knownArchive(name);
    if (known) {
      try {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const { files: members, skipped } = await d.PP.readZip(ab, { password: cfg[known.passwordKey] || null, skip: known.skip });
        for (const m of members) {
          if (!L.MEMBER_RE.test(m.name)) continue;
          items.push({ name: L.baseName(m.name), zipName: name, size: m.bytes.byteLength, bytes: m.bytes, isCsv: /\.csv$/i.test(m.name), state: 'queued' });
        }
        if (skipped.length) items.push({ name: `${skipped.length} skipped`, zipName: name, state: 'skipped', msg: `${known.skipWhy}: ${skipped.map(L.baseName).join(', ')}` });
      } catch (e) {
        items.push({ name, state: 'held', msg: `could not open the ${known.label} archive: ${e.message}` });
      }
    } else {
      try {
        const zip = await d.JSZip.loadAsync(bytes);
        const members = Object.values(zip.files).filter((e) => !e.dir && L.wantMember(e.name));
        if (!members.length) items.push({ name, state: 'held', msg: 'no .xlsx, .xlsm, .xlsb or .csv inside that zip' });
        for (const m of members) {
          try {
            const b = await m.async('uint8array');
            items.push({ name: L.baseName(m.name), zipName: name, size: b.byteLength, bytes: b, isCsv: /\.csv$/i.test(m.name), state: 'queued' });
          } catch (e) {
            items.push({ name: L.baseName(m.name), zipName: name, state: 'held',
              msg: /encrypt/i.test(e.message) ? 'the zip is password protected and this supplier has no saved password' : e.message });
          }
        }
      } catch (e) {
        items.push({ name, state: 'held', msg: /encrypt|password/i.test(e.message)
          ? 'password protected zip with no saved password' : `could not open that zip: ${e.message}` });
      }
    }
  } else if (c.kind === 'book') {
    items.push({ name, size: bytes.byteLength, bytes, isCsv: c.isCsv, state: 'queued' });
  } else if (c.kind === 'unsupported') {
    items.push({ name, state: 'held', msg: `a ${name.split('.').pop().toLowerCase()} archive cannot be opened here: extract it and load the files by hand` });
  } else {
    items.push({ name, state: 'held', msg: 'not a pricebook (.xlsx, .xlsm, .xlsb, .csv, .zip or .7z)' });
  }
  return items;
}

/** The desk's rescanQueue for a mailbox file: product by filename, not quotable blocked, none matched held. */
function route(items, products, skey) {
  for (const it of items) {
    if (it.state !== 'queued') continue;
    it.product = L.matchProduct(products, it.name, skey);
    if (!it.product) {
      it.state = 'unrouted';
      it.msg = 'no product rule matches this filename';
    } else if (it.product.quotable === false) {
      it.state = 'blocked';
      it.notQuotable = true;
      it.msg = `${it.product.display_name} is marked not quotable${it.product.notes ? ': ' + it.product.notes : ''}`;
    }
  }
}

// ---------------------------------------------------------------------------------------------
/** The desk's processOne, unattended, plus the autoload's comparison with the book it replaces. */
async function processItem(d, ctx, it) {
  const { row, supplier, limits, dry, mark } = ctx;
  const skey = row.supplier_key;
  const p = it.product;
  const fuel = p.fuel;
  const parserKey = supplier.parser_key;
  const hold = (msg) => { it.state = 'held'; it.msg = msg; };
  if (!parserKey) return hold(`${supplier.display_name || skey} has no parser on the desk`);

  let bytes = it.bytes || new Uint8Array(readFileSync(it.path));
  const fileSha = L.sha256Hex(bytes);

  // Read the workbook and find the header the layout gate hashes. A file that will not read is a
  // person's job, not a retry.
  let names, wb, plan, firstRows, hIdx;
  try {
    ({ names, wb } = L.readWorkbook(d.XLSX, d.PP, bytes, it.isCsv));
    plan = L.sheetPlan(parserKey, names, fuel);
    const priceSheet = plan[plan.length - 1];
    firstRows = L.sheetToRows(d.XLSX, wb, priceSheet.name);
    if (!firstRows || !firstRows.length) return hold('that sheet is empty');
    hIdx = d.PP.headerRowIndex ? d.PP.headerRowIndex(parserKey, firstRows, priceSheet.name) : 0;
    if (hIdx < 0) return hold(`could not find the header row on "${priceSheet.name}"`);
  } catch (e) {
    return hold(`could not read the file: ${e.message}`);
  }
  // A member unpacked to disk is read again for the receipt copy rather than held through the parse.
  if (it.path) bytes = null;
  const sample = d.PP.normHeader(firstRows[hIdx]);
  const hSha = L.sha256Hex(sample);
  const cols = (firstRows[hIdx] || []).length;
  firstRows = null;

  const [fp, dup] = await Promise.all([d.store.fingerprints(skey, fuel, hSha), d.store.duplicate(skey, fileSha)]);
  if (dup) {
    if (dup.status === 'live') { it.state = 'done'; it.already = true; it.msg = `already live (loaded ${String(dup.uploaded_at || '').slice(0, 10)})`; return; }
    it.state = 'busy';
    it.msg = `somebody is loading this exact file right now (started ${String(dup.uploaded_at || '').slice(0, 16).replace('T', ' ')})`;
    return;
  }
  if (!fp.mine.length) {
    it.state = 'layout';
    it.msg = fp.elsewhere.length
      ? `careful: this exact header is registered to ${fp.elsewhere.map((x) => `${x.supplier_key}/${x.fuel}`).join(', ')}, `
        + `not to ${skey}/${fuel}. Check the filename against the supplier.`
      : `this layout is not registered for ${skey}/${fuel}. Either the supplier changed their format or this is the wrong file. `
        + `Load it by hand and register the layout if the prices are right. Header: ${sample.slice(0, 180)}...`;
    return;
  }

  // Never an older book over a newer one.
  const live = await d.store.liveBooks(skey, p.product_key);
  const newer = L.newerLiveBook(live, p, row.received_at);
  if (newer) {
    it.state = 'skipped'; it.older = true;
    it.msg = `older than the book already live (${newer.source_filename}, ${String(newer.source_received_at || newer.uploaded_at || '').slice(0, 10)}), so not loaded`;
    return;
  }

  // Read the prices FIRST: nothing is stored for a book that is empty or already over.
  let parsed;
  try {
    const sheets = plan.map((pl) => ({ name: pl.name, fuel: pl.fuel, rows: L.sheetToRows(d.XLSX, wb, pl.name) }));
    wb = null;
    parsed = d.PP.parse({ parserKey, supplierKey: skey, fuel, sheets, saleScope: p.sale_scope, green: p.green });
  } catch (e) {
    return hold(`could not read the prices: ${e.message}`);
  }
  const refused = parsed.refusals.length + (parsed.refusals.overflow || 0);
  const n = parsed.rows.length;
  if (!n) return hold(`parsed 0 rows, nothing loaded (${L.topReasons(parsed.refusals)})`);

  const valid = L.bookValidity(parsed.rows);
  const lastDay = L.quoteUntil(valid.to, ctx.daily);
  if (lastDay && lastDay < ctx.today) {
    it.state = 'skipped'; it.expired = true;
    it.msg = `its prices ended on ${lastDay}${lastDay !== valid.to ? ' (a Friday book, good over the weekend only)' : ''}, so it was not loaded`;
    return;
  }

  // The autoload's comparison with the book this one would replace.
  const prev = L.previousBook(live, p);
  const prevMed = prev ? await d.store.medians(prev.id) : null;
  // No file name in the reason: the settle step puts the name in front of every item's message.
  const problem = L.sanityProblem('', n, refused, prev, prevMed, L.bookMedians(parsed.rows), limits);
  if (problem) return hold(problem);

  if (dry) {
    it.state = 'would load';
    it.msg = `${n} rates would go live${prev ? `, replacing ${prev.source_filename}` : ''}${refused ? `; ${refused} rows refused (${L.topReasons(parsed.refusals)})` : ''}`;
    return;
  }

  // Store, record, load, go live, then delete the replaced book's rates at once (the database is small).
  const uploadId = d.uuid();
  const stamp = L.iso(d.now());
  const arch = await d.store.storeArchive(uploadId, it.name, bytes || new Uint8Array(readFileSync(it.path)));
  bytes = null;
  await d.store.insertUpload({
    id: uploadId, supplier_key: skey, fuel, product_key: p.product_key, sale_scope: p.sale_scope,
    zip_filename: it.zipName || null, source_filename: it.name, storage_path: arch.path,
    file_sha256: fileSha, header_sha256: hSha, parser_key: parserKey, status: 'loading',
    uploaded_by: null, uploaded_by_name: L.WHO, parse_started_at: stamp, heartbeat_at: stamp,
    source_received_at: row.received_at || null, inbox_id: row.id,
    quote_valid_from: valid.from, quote_valid_to: valid.to,
    notes: `sheets=${plan.map((x) => x.name).join('|')} cols=${cols} loaded_by=${L.VERSION} parsers=${d.PP.VERSION}${arch.note}`
      + (ctx.wouldWait ? ' would_have_waited' : ''),
  });
  try {
    const { total, elec } = await d.store.insertRates(uploadId, parsed.rows, { inboxId: row.id, mark });
    parsed.rows = null;
    await d.store.parseDone({ p_upload: uploadId, p_rows: total, p_elec: elec, p_gas: total - elec, p_refused: refused,
      p_refusals: parsed.refusals, p_version: parsed.meta.version,
      p_window_open: parsed.meta.window_open, p_window_close: parsed.meta.window_close });
    const superseded = await d.store.goLive(uploadId);
    const swept = await d.store.sweepRates();
    it.state = 'done';
    it.uploadId = uploadId;
    it.msg = `${total} rates live`
      + (superseded ? `, replaced the previous book (${swept.removed} rates deleted)` : ', nothing previous to replace')
      + (refused ? `. ${refused} rows refused (${L.topReasons(parsed.refusals)})` : '');
  } catch (e) {
    // Visibly broken rather than half-loaded; the sweeper takes its rates.
    await d.store.failUpload(uploadId, e.message).catch(() => {});
    it.state = 'error';
    it.msg = String(e.message || e);
  }
}

// ---------------------------------------------------------------------------------------------
function summaryMarkdown(res) {
  const lines = [`### Pricebook loader (${res.version}${res.dry ? ', dry run' : ''})`, ''];
  if (res.off) return lines.concat('Switched off (loader_enabled = false).').join('\n');
  if (!res.files.length) return lines.concat('Nothing waiting in the mailbox.').join('\n');
  lines.push('| Supplier | File | Outcome | Note |', '|---|---|---|---|');
  for (const f of res.files) {
    lines.push(`| ${f.supplier || ''} | ${String(f.file || '').replace(/\|/g, '/')} | ${f.outcome} | ${redact(f.message || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300)} |`);
  }
  return lines.join('\n');
}

async function main() {
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (repository variable and secret).');
    process.exit(2);
  }
  const publicDir = resolve(env.PUBLIC_DIR || join(HERE, '..', '..', 'public'));
  const { PP, SevenZip, expects } = loadDeskReader(publicDir);
  const XLSX = requireHere('xlsx');
  const JSZip = requireHere('jszip');
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log(`${L.VERSION}: desk reader ${expects}, TZ ${process.env.TZ}${L.truthy(env.DRY_RUN) ? ', DRY RUN' : ''}`);
  const res = await runLoader({ store: createStore(sb), PP, SevenZip, XLSX, JSZip, env,
    now: () => Date.now(), uuid: randomUUID, log: (s) => console.log(s) });
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(res) + '\n'); } catch (_) { /* the summary is a nicety */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error('pricebook-loader stopped:', redact(e && e.message || e)); process.exit(1); });
}
