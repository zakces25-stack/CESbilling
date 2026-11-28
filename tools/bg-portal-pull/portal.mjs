// portal.mjs - the browser side of the BG portal puller (CES, 28 Nov 2026).
//
// The BGB partner portal is a Salesforce Classic community (Visualforce pages), mapped by hand on
// 28 Nov 2026 with CES signed in:
//   Login     https://bgbpartnerportal.my.site.com/login : input#username, input#password, input#Login.
//             Anonymous pages redirect there; a protected page answers 401 and a script redirect.
//   Documents /apex/BGB_Document?sfdc.tabName=01r0g000000Q9EE : a folder <select> whose id ends in
//             ":SelectFolder" (00l0g000001UxTlAAK = "Energy Quote Tools & Flatfiles") and a "Go!" button.
//             The folder then shows a jQuery DataTable (10 of 36 rows on screen): Action (View link) |
//             Document Name | Description | Size | Type | Folder Name | Last Modified (dd/mm/yyyy).
//   Download  the View link, /servlet/servlet.FileDownload?file=015..., with the session cookie:
//             200, content-disposition inline; filename="Standard_Gas_Acq_DSC_V317.xlsx", a real xlsx.
//
// Playwright is passed in (run.mjs imports it), so the tests load this file without a browser.
// Nothing here prints the password: it is typed into the page and nowhere else.

import { BASE, LOGIN_PATH, DOCS_PATH, LayoutError } from './lib.mjs';

/**
 * Runs IN THE PAGE (page.evaluate serialises it, so it must not use anything from this module).
 * Every row of the documents table, through the DataTable API when the page has it (the screen only
 * holds 10 rows), else the rows in the DOM. doc and win default to the page's own.
 */
export function extractRows(doc, win) {
  const d = doc || document;
  const w = win || window;
  const out = { rows: [], headers: [], how: '' };
  const tables = Array.prototype.slice.call(d.querySelectorAll('table'));
  const tbl = tables.find((t) => /Document Name/i.test(t.textContent || '') && t.querySelector('a[href*="servlet.FileDownload"]'))
    || tables.find((t) => t.querySelector('a[href*="servlet.FileDownload"]'));
  if (!tbl) return out;
  out.headers = Array.prototype.slice.call(tbl.querySelectorAll('thead th')).map((th) => String(th.textContent || '').trim());
  let trs = null;
  const $ = w && (w.jQuery || w.$j || w.$);
  try {
    if ($ && $.fn && $.fn.dataTable && $.fn.dataTable.isDataTable(tbl)) {
      trs = $(tbl).DataTable().rows().nodes().toArray();
      out.how = 'datatable';
    }
  } catch (e) { trs = null; }
  if (!trs) {
    trs = Array.prototype.slice.call(tbl.querySelectorAll('tbody tr'));
    out.how = 'dom';
  }
  const find = (re) => out.headers.findIndex((h) => re.test(h));
  let iName = find(/document name/i), iDesc = find(/description/i), iSize = find(/^size/i), iType = find(/^type/i),
    iFolder = find(/folder/i), iMod = find(/last modified/i);
  for (const tr of trs) {
    const tds = Array.prototype.slice.call(tr.querySelectorAll('td'));
    if (iName < 0 && tds.length >= 7) { iName = 1; iDesc = 2; iSize = 3; iType = 4; iFolder = 5; iMod = 6; out.how += '+positions'; }
    const a = tr.querySelector('a[href*="servlet.FileDownload"]');
    const cell = (i) => (i >= 0 && tds[i] ? String(tds[i].textContent || '').trim() : '');
    out.rows.push({ name: cell(iName), href: a ? a.getAttribute('href') : '', description: cell(iDesc), size: cell(iSize),
      type: cell(iType), folder: cell(iFolder), modified: cell(iMod) });
  }
  return out;
}

/**
 * Where a sign-in attempt ended up. 'in' | 'login_page' | 'verification_required' | 'password_change'.
 * formShown: the username and password boxes are still on the page.
 */
export function loginState(url, text, formShown) {
  let path = '';
  try { const u = new URL(url); path = u.pathname + u.search; } catch (_) { path = String(url || ''); }
  if (/\/_ui\/identity\/verification/i.test(path) || /verify your identity/i.test(String(text || ''))) return 'verification_required';
  if (/changepassword|change your password|password has expired/i.test(path + ' ' + String(text || ''))) return 'password_change';
  return formShown ? 'login_page' : 'in';
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}
async function loginFormShown(page) {
  const [u, p] = await Promise.all([page.locator('#username').count().catch(() => 0), page.locator('#password').count().catch(() => 0)]);
  return u > 0 && p > 0;
}

/** Sign in. {ok:true} or {ok:false, outcome:'login_failed'|'verification_required', message}. */
export async function login(page, { username, password, base = BASE, timeoutMs = 60000 }) {
  await page.goto(base + LOGIN_PATH, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  if (!(await loginFormShown(page))) throw new LayoutError('the BG login page has no username and password boxes');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([
    page.waitForURL((u) => !/^\/login(\/|$)/i.test(u.pathname), { timeout: timeoutMs }).catch(() => null),
    page.click('#Login'),
  ]);
  // Salesforce goes through frontdoor.jsp and a script redirect before the home page settles.
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const url = page.url();
  const text = await bodyText(page);
  const state = loginState(url, text, await loginFormShown(page));
  if (state === 'verification_required') {
    return { ok: false, outcome: 'verification_required', message: 'the portal asked for an identity verification code' };
  }
  if (state === 'password_change') {
    return { ok: false, outcome: 'login_failed', message: 'the portal wants the password changed before it lets anyone in' };
  }
  if (state === 'login_page') {
    const err = await page.locator('#error, .loginError, #errorMessage').first().innerText({ timeout: 2000 }).catch(() => '');
    return { ok: false, outcome: 'login_failed', message: String(err || '').trim().slice(0, 300) || 'the portal stayed on the login page' };
  }
  return { ok: true, url };
}

/**
 * Open the folder and read every document in it. Throws LayoutError when the page is not as mapped.
 * Returns {rows (raw, for lib.normaliseRows), folderLabel, how, headers}.
 */
export async function listDocuments(page, { folderId, base = BASE, timeoutMs = 60000 }) {
  await page.goto(base + DOCS_PATH, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  if (await loginFormShown(page)) throw new LayoutError('the portal signed the session out when the Documents page opened');
  const select = page.locator('select[id$=":SelectFolder"]').first();
  try {
    await select.waitFor({ state: 'attached', timeout: Math.min(timeoutMs, 30000) });
  } catch (_) {
    throw new LayoutError('the folder list is not on the Documents page');
  }
  const opt = await select.evaluate((s, id) => {
    const want = String(id || '');
    const o = Array.prototype.slice.call(s.options).find((x) => x.value === want || x.value.slice(0, 15) === want.slice(0, 15));
    return o ? { value: o.value, label: String(o.text || '').trim() } : null;
  }, folderId);
  if (!opt) throw new LayoutError(`folder ${folderId} is not in the folder list`);
  await select.selectOption(opt.value);
  let go = page.locator('input[value="Go!"]');
  if (!(await go.count())) go = page.getByRole('button', { name: 'Go!' });
  if (!(await go.count())) throw new LayoutError('the Go! button is not on the Documents page');
  await go.first().click();

  // The click posts the page back; read until this folder's rows are there (or time runs out).
  const deadline = Date.now() + Math.min(timeoutMs, 45000);
  let res = null;
  while (Date.now() < deadline) {
    res = await page.evaluate(extractRows).catch(() => null);
    if (res && res.rows.length && res.rows.every((r) => !r.folder || r.folder === opt.label)) break;
    await page.waitForTimeout(750);
  }
  if (!res || !res.rows.length) throw new LayoutError(`no documents appeared after choosing the ${opt.label} folder`);
  if (res.rows.some((r) => r.folder && r.folder !== opt.label)) throw new LayoutError(`the list shows another folder, not ${opt.label}`);
  return { rows: res.rows, folderLabel: opt.label, how: res.how, headers: res.headers };
}

/** GET a document with the signed-in session. */
export async function download(context, url, { timeoutMs = 180000 } = {}) {
  const r = await context.request.get(url, { timeout: timeoutMs, maxRedirects: 5 });
  const h = r.headers();
  return { status: r.status(), contentType: h['content-type'] || '', disposition: h['content-disposition'] || '', bytes: await r.body() };
}

/** The portal object run.mjs uses: {login, listDocuments, download, close}. */
export async function openPlaywrightPortal({ chromium, base = BASE, timeoutMs = 60000, headless = true }) {
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(timeoutMs);
    const page = await context.newPage();
    return {
      login: (creds) => login(page, { ...creds, base, timeoutMs }),
      listDocuments: (o) => listDocuments(page, { ...o, base, timeoutMs }),
      download: (url) => download(context, url),
      close: () => browser.close(),
    };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
