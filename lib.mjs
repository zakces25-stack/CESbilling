// lib.mjs - the pure parts of the BG portal puller (CES, 28 Nov 2026).
//
// CES, 28 Nov 2026: "British Gas has also moved their pricebooks onto their portal instead of emailing,
// I would like to know if theres any way of pulling their pricebooks from their portal into the website
// directly", then "lets get the bg login details plugged into the site as its not against their terms
// and conditions". The portal is the BGB (Salesforce) partner portal at bgbpartnerportal.my.site.com.
// Every week BG post the next price books in Documents > "Energy Quote Tools & Flatfiles" (V317 on
// Fri 27/11/2026), each with a plain download link. The desk loads five of them: Standard_Elec and the
// four Standard_Gas books (Acq / Ren, with and without DSC).
//
// Nothing in here touches the network, the browser or the database, so all of it is tested in Node.
// The waiting note keeps the loader's form ("... [until=<ISO>]") so pricebook_loader_eligible(),
// pricebook_loader_kick() and the loader itself all hold the file until then.

import { createHash } from 'node:crypto';

export const VERSION = 'bg-portal-pull 2026-11-28.1';
export const WHO = 'Automatic (BG portal puller)';
export const PORTAL = 'bg';
export const BASE = 'https://bgbpartnerportal.my.site.com';
export const LOGIN_PATH = '/login';
export const DOCS_PATH = '/apex/BGB_Document?sfdc.tabName=01r0g000000Q9EE';
export const INBOX_BUCKET = 'pricebook-inbox';
export const SUPPLIER = 'british_gas';
export const SENDER = 'BG partner portal (bgbpartnerportal.my.site.com)';
export const COLLECTED_NOTE = 'collected from the BG partner portal';
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** pricebook_mail_config defaults (SPEC-PORTALS.md section A). */
export const DEFAULTS = {
  bgportal_enabled: 'true',
  bgportal_folder_id: '00l0g000001UxTlAAK',
  bgportal_files: '^Standard_(Elec|Gas_(Acq|Ren)(_DSC)?)_V\\d+(_V\\d+)?\\.xlsx$',
  bgportal_hold_until_monday: 'false',
};

/** Outcomes a person has to hear about: one alert email per outcome per UK day, and a red run. */
export const ALERT_OUTCOMES = ['login_failed', 'verification_required', 'layout_changed', 'failed'];
export const OK_OUTCOMES = ['ok', 'nothing_new', 'disabled', 'dry_run'];

/** The portal's page is not what this was written against: nothing is downloaded on a guess. */
export class LayoutError extends Error {
  constructor(msg) { super(msg); this.name = 'LayoutError'; }
}

// ---- small helpers -------------------------------------------------------------------------
export const iso = (ms) => new Date(ms).toISOString();
export const truthy = (v, dflt = false) => (v == null || v === '' ? dflt : String(v).trim().toLowerCase() === 'true');

export function sha256Hex(data) {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return h.digest('hex');
}

/** An xlsx is a zip: PK\x03\x04. A Salesforce login page sent instead of the file is not. */
export function isXlsx(bytes) {
  return !!bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Secrets never reach a log line, a run note or an alert. */
export function mask(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const sec of secrets) {
    if (sec && String(sec).length >= 3) s = s.split(String(sec)).join('***');
  }
  return s;
}

// ---- UK dates (the loader's helpers) -------------------------------------------------------
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

/**
 * A database timestamp as epoch ms, or NaN. PostgREST sends "2026-11-28T13:06:34.191122+00:00"; a
 * psql-style "2026-11-28 13:06:34.191122+00" is accepted too.
 */
export function tsMs(s) {
  if (s == null || s === '') return NaN;
  if (typeof s === 'number') return s;
  let t = String(s).trim().replace(' ', 'T');
  t = t.replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(t);
}
const ukDay = (s) => { const ms = tsMs(s); return Number.isFinite(ms) ? ukDate(ms) : ''; };

/** The portal's "Last Modified" (dd/mm/yyyy) as YYYY-MM-DD, or null. */
export function parseUkDate(s) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/** 00:00 Europe/London on a UK calendar day (YYYY-MM-DD), as epoch ms. */
export function ukMidnight(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const gmt = Date.UTC(y, m - 1, d);
  return ukDate(gmt - 3600e3) === ymd ? gmt - 3600e3 : gmt;   // in BST the UK day starts at 23:00 UTC the day before
}

/** The first Monday on or after a day (a Monday gives itself). */
export function firstMondayOnOrAfter(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return new Date(Date.UTC(y, m - 1, d + ((8 - wd) % 7))).toISOString().slice(0, 10);
}

/** bgportal_hold_until_monday: BG post on a Friday for the Monday ("V316 ... live ... from Monday 23rd"). */
export function holdUntil(lastModifiedYmd) {
  return ukMidnight(firstMondayOnOrAfter(lastModifiedYmd));
}

/** The loader's waiting note: pricebook_note_until() and the loader read the trailing [until=<ISO>]. */
export function waitNote(untilMs) {
  return `waiting until ${ukWhen(untilMs)}: British Gas books go live on the Monday after they are posted [until=${iso(untilMs)}]`;
}
export function waitUntilOf(note) {
  const m = /\[until=([^\]]+)\]/.exec(String(note || ''));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

// ---- settings --------------------------------------------------------------------------------
/** pricebook_mail_config, with the defaults. A regex that will not compile falls back to the default. */
export function settingsFrom(cfg = {}) {
  const val = (k) => (cfg[k] == null || String(cfg[k]).trim() === '' ? DEFAULTS[k] : String(cfg[k]).trim());
  const warnings = [];
  let filesRe;
  try { filesRe = new RegExp(val('bgportal_files'), 'i'); } catch (e) {
    warnings.push(`bgportal_files is not a valid pattern (${e.message}); using the default`);
    filesRe = new RegExp(DEFAULTS.bgportal_files, 'i');
  }
  return {
    enabled: truthy(val('bgportal_enabled'), true),
    folderId: val('bgportal_folder_id'),
    filesRe,
    holdUntilMonday: truthy(val('bgportal_hold_until_monday'), false),
    warnings,
  };
}

// ---- the documents list ----------------------------------------------------------------------
/** "015R500000IesycIAB" from /servlet/servlet.FileDownload?file=015R500000IesycIAB */
export function docIdOf(href) {
  const m = /[?&]file=([A-Za-z0-9]{15,18})(?:&|$)/.exec(String(href || ''));
  return m ? m[1] : null;
}

/** V317 -> {v:317, sub:0}; V316_V2 -> {v:316, sub:2}; no version -> null. */
export function versionOf(name) {
  const n = String(name || '');
  let m = /_V(\d+)(?:_V(\d+))?\.[A-Za-z0-9]+$/i.exec(n);
  if (m) return { v: Number(m[1]), sub: m[2] ? Number(m[2]) : 0 };
  m = /(?:^|[_\s-])V(\d{2,4})(?:_V(\d+))?(?![0-9])/i.exec(n);
  return m ? { v: Number(m[1]), sub: m[2] ? Number(m[2]) : 0 } : null;
}

export function compareVersion(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a.v - b.v || a.sub - b.sub;
}

/** The product a file is a version of: Standard_Gas_Acq_DSC_V317.xlsx -> standard_gas_acq_dsc. */
export function productOf(name) {
  let n = String(name || '').trim();
  const strict = /_V\d+(?:_V\d+)?\.[A-Za-z0-9]+$/i;
  if (strict.test(n)) n = n.replace(strict, '');
  else n = n.replace(/\.[A-Za-z0-9]+$/, '').replace(/(?:^|[_\s-])V\d{2,4}(?![0-9]).*$/i, '');
  return n.toLowerCase().replace(/\s+/g, '_');
}

/** A row the page gave back, checked and tidied. null when it is not a document row at all. */
export function normaliseRow(raw, base = BASE) {
  if (!raw) return null;
  const name = String(raw.name || '').trim();
  const href = String(raw.href || '').trim();
  const docId = docIdOf(href);
  if (!name || !docId) return null;
  return {
    docId,
    name,
    href,
    url: /^https?:\/\//i.test(href) ? href : base + (href.startsWith('/') ? href : '/' + href),
    size: String(raw.size || '').trim(),
    type: String(raw.type || '').trim(),
    folder: String(raw.folder || '').trim(),
    lastModified: parseUkDate(raw.modified),
    version: versionOf(name),
    product: productOf(name),
  };
}

/** Every row tidied, or a LayoutError when the list does not look like the portal's documents list. */
export function normaliseRows(rawRows, base = BASE) {
  const raws = Array.isArray(rawRows) ? rawRows : [];
  if (!raws.length) throw new LayoutError('the folder showed no documents');
  const rows = raws.map((r) => normaliseRow(r, base)).filter(Boolean);
  if (!rows.length) throw new LayoutError('none of the rows has a document name and a download link');
  if (!rows.some((r) => r.lastModified)) throw new LayoutError('no row has a Last Modified date in dd/mm/yyyy');
  return rows;
}

const LOADED = ['live', 'parsed', 'loading', 'superseded'];

/**
 * Which documents to fetch. ctx: {uploads: british_gas pricebook_uploads rows (source_filename, status,
 * uploaded_at, uploaded_by_name), collected: Set of docIds already in pricebook_inbox}.
 * Returns {candidates (the newest wanted file of each product), wanted, skipped: [{row, why}]}.
 */
export function chooseFiles(rows, settings, ctx = {}) {
  const uploads = ctx.uploads || [];
  const collected = ctx.collected || new Set();
  const skipped = [];
  const best = new Map();
  for (const r of rows) {
    if (!settings.filesRe.test(r.name)) continue;
    const cur = best.get(r.product);
    const newer = !cur || compareVersion(r.version, cur.version) > 0
      || (compareVersion(r.version, cur.version) === 0 && String(r.lastModified || '') > String(cur.lastModified || ''));
    if (newer) best.set(r.product, r);
  }
  const candidates = [...best.values()];
  const wanted = [];
  for (const r of candidates) {
    if (collected.has(r.docId)) { skipped.push({ row: r, why: 'already collected from the portal' }); continue; }
    const same = uploads.find((u) => LOADED.includes(u.status)
      && String(u.source_filename || '').toLowerCase() === r.name.toLowerCase()
      && (!r.lastModified || (ukDay(u.uploaded_at) !== '' && ukDay(u.uploaded_at) >= r.lastModified)));
    if (same) {
      skipped.push({ row: r, why: `already loaded on ${ukDay(same.uploaded_at) || 'an earlier day'}${same.uploaded_by_name ? ' by ' + same.uploaded_by_name : ''}` });
      continue;
    }
    const newerLive = uploads.find((u) => u.status === 'live' && productOf(u.source_filename) === r.product
      && compareVersion(versionOf(u.source_filename), r.version) > 0);
    if (newerLive) { skipped.push({ row: r, why: `a newer book is already live (${newerLive.source_filename})` }); continue; }
    wanted.push(r);
  }
  return { candidates, wanted, skipped };
}

// ---- what gets written ---------------------------------------------------------------------
export function safeName(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
}

/** bgportal/<UK date>/<docId>-<file name> in the pricebook-inbox bucket. */
export function storagePath(nowMs, docId, name) {
  return `bgportal/${ukDate(nowMs)}/${docId}-${safeName(name)}`;
}

export const versionLabel = (v) => (!v ? '' : `V${v.v}${v.sub ? '_V' + v.sub : ''}`);

/** The pricebook_inbox row, as SPEC-PORTALS.md section A. */
export function inboxRow({ file, sha, size, path, nowMs, settings }) {
  let note = COLLECTED_NOTE;
  if (settings && settings.holdUntilMonday && file.lastModified) {
    const until = holdUntil(file.lastModified);
    if (until > nowMs) note = waitNote(until);
  }
  return {
    message_id: `bgportal:${file.docId}`,
    internet_message_id: null,
    received_at: iso(nowMs),
    sender: SENDER,
    subject: `British Gas portal: ${file.folder || 'Energy Quote Tools & Flatfiles'} ${versionLabel(file.version)}`.trim(),
    rule_id: null,
    supplier_key: SUPPLIER,
    kind: 'attachment',
    file_name: file.name,
    content_type: XLSX_TYPE,
    size_bytes: size,
    sha256: sha,
    storage_path: path,
    link_url: file.url,
    status: 'new',
    status_note: note,
  };
}

// ---- telling a person ------------------------------------------------------------------------
export function dedupeKey(outcome, nowMs) {
  return `bgportal:${outcome}:${ukDate(nowMs)}`;
}

const SECRETS_WHERE = 'GitHub, CESbilling repository, Settings, Secrets and variables, Actions';

/** Plain-English alert for an outcome a person has to act on. null for the quiet ones. */
export function alertFor(outcome, detail, runUrl) {
  const d = String(detail || '').trim();
  const run = runUrl ? `\n\nThe run: ${runUrl}` : '';
  const byHand = 'Until this is fixed, download this week\'s British Gas books from the portal (Documents, Energy Quote Tools & Flatfiles) and load them on the desk as before.';
  switch (outcome) {
    case 'login_failed':
      return {
        subject: 'BG portal: the automatic download could not sign in',
        body: `The automatic British Gas price book download could not sign in to the BG partner portal (bgbpartnerportal.my.site.com).`
          + (d ? `\n\nWhat happened: ${d}` : '')
          + `\n\nWhat to do: check that the BG_PORTAL_USERNAME and BG_PORTAL_PASSWORD secrets (${SECRETS_WHERE}) are the login that works when you sign in to the portal in a browser. If the BG password was changed or has expired, sign in once by hand, then put the new password in BG_PORTAL_PASSWORD.\n\n${byHand}${run}`,
      };
    case 'verification_required':
      return {
        subject: 'BG portal: the automatic download was asked for a verification code',
        body: `The BG partner portal asked the automatic download to verify its identity (a code sent by email or text), which it cannot do on its own.`
          + (d ? `\n\nWhat happened: ${d}` : '')
          + `\n\nWhat to do: sign in to the BG portal once by hand with the same login and complete the check. If it keeps asking every time, ask your British Gas account manager whether the partner login can sign in without device verification.\n\n${byHand}${run}`,
      };
    case 'layout_changed':
      return {
        subject: 'BG portal: the Documents page has changed',
        body: `The automatic British Gas download signed in, but the portal's Documents page did not look as it should, so nothing was downloaded.`
          + (d ? `\n\nWhat it found: ${d}` : '')
          + `\n\nWhat to do: British Gas have probably changed the page. Ask whoever looks after the CES pricing desk to update tools/bg-portal-pull.\n\n${byHand}${run}`,
      };
    case 'failed':
      return {
        subject: 'BG portal: the automatic download did not finish',
        body: `The automatic British Gas price book download stopped before it finished.`
          + (d ? `\n\nWhat happened: ${d}` : '')
          + `\n\nIt tries again on its next scheduled run (every two hours on weekdays). If this email keeps coming, ask whoever looks after the CES pricing desk to look at the BG portal puller runs in GitHub Actions.\n\n${byHand}${run}`,
      };
    default:
      return null;
  }
}

/** The GitHub run summary. */
export function summaryMarkdown(res) {
  const lines = [`### BG portal puller (${res.version}${res.dry ? ', dry run' : ''})`, '', `Outcome: **${res.outcome}**${res.note ? `. ${String(res.note).replace(/\n/g, ' ')}` : ''}`, ''];
  if (res.filesSeen != null) lines.push(`Documents in the folder: ${res.filesSeen}. New books stored: ${res.newFiles || 0}.`, '');
  if (res.files && res.files.length) {
    lines.push('| File | Last modified | Outcome | Note |', '|---|---|---|---|');
    for (const f of res.files) {
      lines.push(`| ${String(f.name || '').replace(/\|/g, '/')} | ${f.lastModified || ''} | ${f.outcome} | ${String(f.note || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300)} |`);
    }
  }
  return lines.join('\n');
}
