// run.mjs - the BG portal puller (CES, 28 Nov 2026).
//
// CES, 28 Nov 2026: "British Gas has also moved their pricebooks onto their portal instead of emailing"
// and "lets get the bg login details plugged into the site as its not against their terms and
// conditions". The login is NOT in the website (anyone who opens a page can read what is in it). It is
// in two GitHub secrets, BG_PORTAL_USERNAME and BG_PORTAL_PASSWORD, and this runs on a GitHub Actions
// runner (.github/workflows/bg-portal-pull.yml).
//
// WHAT IT DOES, each run:
//   1. Reads its switches from pricebook_mail_config (bgportal_enabled, bgportal_folder_id,
//      bgportal_files, bgportal_hold_until_monday).
//   2. Signs in to https://bgbpartnerportal.my.site.com in a headless Chromium, opens Documents, picks
//      the "Energy Quote Tools & Flatfiles" folder and reads every document in it.
//   3. Keeps the books the desk loads (bgportal_files: the five Standard_* books), the newest version of
//      each, and drops any it already has: collected before (pricebook_inbox), loaded on the desk since
//      BG posted it (pricebook_uploads), or older than the book that is live.
//   4. Downloads each one with the signed-in session, checks it really is an xlsx, and puts it in the
//      pricing mailbox store exactly as if it had been emailed: the pricebook-inbox bucket plus a
//      pricebook_inbox row (supplier british_gas). The pricebook loader then loads it with the desk's
//      own reader and the desk's own checks. With bgportal_hold_until_monday on, the row waits until
//      00:00 on the Monday after BG posted it.
//   5. Logs the run in pricebook_portal_runs. A failed sign-in, a verification code request, a changed
//      page or a crash queues ONE alert email a day per kind (pricebook_alerts; the pricebook-notices
//      function sends it).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BG_PORTAL_USERNAME, BG_PORTAL_PASSWORD (required);
// DRY_RUN=true (sign in and decide, store nothing); BG_PORTAL_BASE (tests only); GITHUB_* (summary,
// output new_files, the run link in alerts).

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './lib.mjs';
import { createStore } from './store.mjs';
import { openPlaywrightPortal } from './portal.mjs';

function runUrl(env) {
  return env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
}

/**
 * One run. d = {env, store, openPortal: async () => portal, now: () => ms, log}.
 * portal = {login({username, password}), listDocuments({folderId}), download(url), close()}.
 * Returns {version, dry, outcome, note, filesSeen, newFiles, files: [{name, lastModified, outcome, note}]}.
 */
export async function runPull(d) {
  const env = d.env || {};
  const secrets = [env.BG_PORTAL_PASSWORD, env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
  const say = (s) => (d.log || (() => {}))(L.mask(s, secrets));
  const started = d.now();
  const dry = L.truthy(env.DRY_RUN);
  const res = { version: L.VERSION, dry, outcome: 'failed', note: '', filesSeen: null, newFiles: 0, files: [] };
  let portal = null;

  const finish = async (outcome, note) => {
    res.outcome = outcome;
    res.note = L.mask(String(note || ''), secrets).slice(0, 500);
    if (L.ALERT_OUTCOMES.includes(outcome) && !dry) {
      const a = L.alertFor(outcome, res.note, runUrl(env));
      try {
        const queued = await d.store.alert(a.subject, a.body, L.dedupeKey(outcome, d.now()));
        say(queued ? `Alert queued: ${a.subject}` : 'Alert already sent today for this, not sent again.');
      } catch (e) { say(`Could not queue the alert: ${e.message}`); }
    }
    await d.store.logRun({
      portal: L.PORTAL, started_at: L.iso(started), finished_at: L.iso(d.now()), outcome,
      files_seen: res.filesSeen, files_new: res.newFiles, note: res.note || null, version: L.VERSION, dry_run: dry,
    });
    say(`Outcome: ${outcome}${res.note ? `. ${res.note}` : ''}`);
    return res;
  };

  try {
    const cfg = await d.store.config();
    const settings = L.settingsFrom(cfg);
    for (const w of settings.warnings) say(w);
    if (!settings.enabled) return await finish('disabled', 'bgportal_enabled is false in pricebook_mail_config');

    const username = String(env.BG_PORTAL_USERNAME || '').trim();
    const password = String(env.BG_PORTAL_PASSWORD || '');
    if (!username || !password) {
      return await finish('failed', 'the BG_PORTAL_USERNAME and BG_PORTAL_PASSWORD GitHub secrets are not both set, so it could not sign in');
    }

    portal = await d.openPortal();
    say(`Signing in to the BG portal as ${username}${dry ? ' (dry run)' : ''}`);
    const li = await portal.login({ username, password });
    if (!li || !li.ok) {
      const outcome = li && li.outcome === 'verification_required' ? 'verification_required' : 'login_failed';
      return await finish(outcome, (li && li.message) || 'the portal did not let it in');
    }

    let listing, rows;
    try {
      listing = await portal.listDocuments({ folderId: settings.folderId });
      rows = L.normaliseRows(listing && listing.rows);
    } catch (e) {
      if (e instanceof L.LayoutError || (e && e.name === 'LayoutError')) return await finish('layout_changed', e.message);
      throw e;
    }
    res.filesSeen = rows.length;
    say(`${rows.length} documents in ${listing.folderLabel || 'the folder'} (read via ${listing.how || 'the page'})`);

    const uploads = await d.store.bgUploads();
    const first = L.chooseFiles(rows, settings, { uploads, collected: new Set() });
    const collected = await d.store.collectedDocIds(first.candidates.map((r) => r.docId));
    const { candidates, wanted, skipped } = L.chooseFiles(rows, settings, { uploads, collected });
    if (!candidates.length) return await finish('layout_changed', `no document in the folder matches bgportal_files (${settings.filesRe.source})`);
    for (const s of skipped) {
      res.files.push({ name: s.row.name, lastModified: s.row.lastModified, outcome: 'skipped', note: s.why });
      say(`${s.row.name}: skipped, ${s.why}`);
    }

    const errors = [];
    for (const f of wanted) {
      const item = { name: f.name, lastModified: f.lastModified, outcome: '', note: '' };
      res.files.push(item);
      try {
        const dl = await portal.download(f.url);
        if (!dl || dl.status !== 200) throw new Error(`the portal answered ${dl ? dl.status : 'nothing'} for the download`);
        if (!L.isXlsx(dl.bytes)) throw new Error(`the download is not an Excel file (the portal sent ${dl.contentType || 'something else'}), so the session may have ended`);
        const sha = L.sha256Hex(dl.bytes);
        if (await d.store.inboxHasSha(sha)) {
          item.outcome = 'skipped'; item.note = 'the same file is already in the mailbox store';
          say(`${f.name}: ${item.note}`);
          continue;
        }
        const now = d.now();
        const path = L.storagePath(now, f.docId, f.name);
        const row = L.inboxRow({ file: f, sha, size: dl.bytes.length, path, nowMs: now, settings });
        if (dry) {
          item.outcome = 'would collect';
          item.note = `${(dl.bytes.length / 1048576).toFixed(1)} MB; mailbox note: ${row.status_note}`;
          say(`${f.name}: would collect (${item.note})`);
          continue;
        }
        const up = await d.store.upload(path, dl.bytes, L.XLSX_TYPE);
        const ins = await d.store.insertInbox(row);
        if (ins.duplicate) {
          if (!up.existed) await d.store.removeObject(path);
          item.outcome = 'skipped'; item.note = 'the same file is already in the mailbox store';
          say(`${f.name}: ${item.note}`);
          continue;
        }
        item.outcome = 'collected';
        item.note = row.status_note;
        res.newFiles++;
        say(`${f.name}: collected (${(dl.bytes.length / 1048576).toFixed(1)} MB), ${row.status_note}`);
      } catch (e) {
        item.outcome = 'error';
        item.note = L.mask(String(e && e.message || e), secrets).slice(0, 300);
        errors.push(`${f.name}: ${item.note}`);
        say(`${f.name}: ${item.note}`);
      }
    }

    if (errors.length) {
      const note = (res.newFiles ? `stored ${res.newFiles}, but ` : '') + errors.join('; ');
      if (res.newFiles) {
        // The new books still go to the loader; the failures still need a person to hear about them.
        if (!dry) {
          const a = L.alertFor('failed', note, runUrl(env));
          await d.store.alert(a.subject, a.body, L.dedupeKey('failed', d.now())).catch(() => false);
        }
        return await finish('ok', note);
      }
      return await finish('failed', note);
    }
    if (dry) {
      const n = res.files.filter((x) => x.outcome === 'would collect').length;
      return await finish('dry_run', n ? `would collect ${n}: ${res.files.filter((x) => x.outcome === 'would collect').map((x) => x.name).join(', ')}` : 'nothing new to collect');
    }
    if (res.newFiles) {
      return await finish('ok', `collected ${res.files.filter((x) => x.outcome === 'collected').map((x) => x.name).join(', ')}`);
    }
    return await finish('nothing_new', candidates.length ? `newest: ${candidates.map((c) => c.name).join(', ')}` : '');
  } catch (e) {
    return await finish('failed', String(e && e.message || e));
  } finally {
    if (portal) await Promise.resolve(portal.close()).catch(() => {});
  }
}

export const exitCodeFor = (outcome) => (L.OK_OUTCOMES.includes(outcome) ? 0 : 1);

async function main() {
  const env = process.env;
  if (!process.env.TZ) process.env.TZ = 'Europe/London';
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (repository variable and secret).');
    process.exit(2);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const openPortal = async () => {
    const { chromium } = await import('playwright');
    return openPlaywrightPortal({ chromium, base: env.BG_PORTAL_BASE || L.BASE });
  };
  console.log(`${L.VERSION}${L.truthy(env.DRY_RUN) ? ', DRY RUN' : ''}`);
  const res = await runPull({ env, store: createStore(sb), openPortal, now: () => Date.now(), log: (s) => console.log(s) });
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, L.summaryMarkdown(res) + '\n'); } catch (_) { /* the summary is a nicety */ }
  }
  if (env.GITHUB_OUTPUT) {
    try { appendFileSync(env.GITHUB_OUTPUT, `new_files=${res.newFiles || 0}\noutcome=${res.outcome}\n`); } catch (_) { /* nicety */ }
  }
  process.exit(exitCodeFor(res.outcome));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error('bg-portal-pull stopped:', L.mask(e && e.message || e, [process.env.BG_PORTAL_PASSWORD, process.env.SUPABASE_SERVICE_ROLE_KEY]));
    process.exit(1);
  });
}
