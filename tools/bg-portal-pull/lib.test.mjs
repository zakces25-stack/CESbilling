// lib.test.mjs - the BG portal puller's pure logic, on the real folder listing read from the portal
// on 28 Nov 2026 (36 documents, V315 to V317). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';
import { extractRows, loginState } from './portal.mjs';

const FOLDER = 'Energy Quote Tools & Flatfiles';
// [Document Name, docId, Size, Last Modified]: the portal's own listing, 28 Nov 2026.
const LISTING = [
  ['Standard_Gas_Ren_V317.xlsx', '015R500000IesycIAB', '428. KB', '27/11/2026'],
  ['Standard_Gas_Ren_V316.xlsx', '015R500000IVbc2IAD', '429. KB', '20/11/2026'],
  ['Standard_Gas_Ren_V315.xlsx', '015R500000IMfBpIAL', '428. KB', '13/11/2026'],
  ['Standard_Gas_Ren_DSC_V317.xlsx', '015R500000IetTFIAZ', '216. KB', '27/11/2026'],
  ['Standard_Gas_Ren_DSC_V316.xlsx', '015R500000IVc8HIAT', '217. KB', '20/11/2026'],
  ['Standard_Gas_Ren_DSC_V315.xlsx', '015R500000IMfADIA1', '216. KB', '13/11/2026'],
  ['Standard_Gas_Acq_V317.xlsx', '015R500000IetQ1IAJ', '217. KB', '27/11/2026'],
  ['Standard_Gas_Acq_V316.xlsx', '015R500000IVc53IAD', '218. KB', '20/11/2026'],
  ['Standard_Gas_Acq_V315.xlsx', '015R500000IMf8bIAD', '217. KB', '13/11/2026'],
  ['Standard_Gas_Acq_DSC_V317.xlsx', '015R500000IetJZIAZ', '110. KB', '27/11/2026'],
  ['Standard_Gas_Acq_DSC_V316.xlsx', '015R500000IVWMFIA5', '111. KB', '20/11/2026'],
  ['Standard_Gas_Acq_DSC_V315.xlsx', '015R500000IMYBzIAP', '110. KB', '13/11/2026'],
  ['Standard_Elec_V317.xlsx', '015R500000Iet6fIAB', '21.9 MB', '27/11/2026'],
  ['Standard_Elec_V316.xlsx', '015R500000IVc3RIAT', '21.9 MB', '20/11/2026'],
  ['Standard_Elec_V315.xlsx', '015R500000IMf29IAD', '21.9 MB', '13/11/2026'],
  ['Natural REGO_Elec_V317.xlsx', '015R500000IevjZIAR', '21.9 MB', '27/11/2026'],
  ['Natural REGO_Elec_V316.xlsx', '015R500000IVSTuIAP', '21.9 MB', '20/11/2026'],
  ['Natural REGO_Elec_V315.xlsx', '015R500000IMfF3IAL', '21.9 MB', '13/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_V317.xlsx', '015R500000IeteXIAR', '431. KB', '27/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_V316.xlsx', '015R500000IVcLCIA1', '431. KB', '20/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_V315.xlsx', '015R500000IMaqUIAT', '431. KB', '13/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_DSC_V317.xlsx', '015R500000IetZhIAJ', '216. KB', '27/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_DSC_V316.xlsx', '015R500000IVcJZIA1', '217. KB', '20/11/2026'],
  ['Gas Carbon Neutral_Gas_Ren_DSC_V315.xlsx', '015R500000IMaVWIA1', '216. KB', '13/11/2026'],
  ['Gas Carbon Neutral_Gas_Acq_V317.xlsx', '015R500000IetWTIAZ', '218. KB', '27/11/2026'],
  ['Gas Carbon Neutral_Gas_Acq_V316.xlsx', '015R500000IVcGLIA1', '219. KB', '20/11/2026'],
  ['Gas Carbon Neutral_Gas_Acq_V315.xlsx', '015R500000IMfJtIAL', '218. KB', '13/11/2026'],
  ['Gas Carbon Neutral_Gas_Acq_DSC_V317.xlsx', '015R500000IetUrIAJ', '110. KB', '27/11/2026'],
  ['Gas Carbon Neutral_Gas_Acq_DSC_V316.xlsx', '015R500000IVcEjIAL', '111. KB', '20/11/2026'],
  ['Gas Carbon Neutral_Gas_Acq_DSC_V315.xlsx', '015R500000IMfIHIA1', '110. KB', '13/11/2026'],
  ['BGB_Gas_Broker_Tool_V317.xlsx', '015R500000Iet3RIAR', '2.52 MB', '27/11/2026'],
  ['BGB_Gas_Broker_Tool_V316_V2.xlsx', '015R500000IXZUUIA5', '2.52 MB', '23/11/2026'],
  ['BGB_Gas_Broker_Tool_V315.xlsx', '015R500000IMaaMIAT', '2.52 MB', '13/11/2026'],
  ['BGB_Elec_Broker_Tool_V317.xlsb', '015R500000Iet1pIAB', '16.9 MB', '27/11/2026'],
  ['BGB_Elec_Broker_Tool_V316.xlsb', '015R500000IVVpyIAH', '16.9 MB', '20/11/2026'],
  ['BGB_Elec_Broker_Tool_V315.xlsb', '015R500000IMVAsIAP', '16.9 MB', '13/11/2026'],
];
const raw = (list = LISTING) => list.map(([name, id, size, modified]) => ({
  name, href: `/servlet/servlet.FileDownload?file=${id}`, description: '', size, type: name.split('.').pop(), folder: FOLDER, modified,
}));
const STANDARD_V317 = ['Standard_Elec_V317.xlsx', 'Standard_Gas_Acq_DSC_V317.xlsx', 'Standard_Gas_Acq_V317.xlsx',
  'Standard_Gas_Ren_DSC_V317.xlsx', 'Standard_Gas_Ren_V317.xlsx'];
const names = (rows) => rows.map((r) => r.name).sort();

test('settings: the defaults, and overrides from pricebook_mail_config', () => {
  const s = L.settingsFrom({});
  assert.equal(s.enabled, true);
  assert.equal(s.folderId, '00l0g000001UxTlAAK');
  assert.equal(s.holdUntilMonday, false);
  assert.ok(s.filesRe.test('Standard_Elec_V317.xlsx'));
  assert.ok(s.filesRe.test('standard_gas_acq_dsc_v317.XLSX'), 'case-insensitive');
  assert.ok(s.filesRe.test('Standard_Gas_Ren_V316_V2.xlsx'));
  assert.ok(!s.filesRe.test('Natural REGO_Elec_V317.xlsx'));
  assert.ok(!s.filesRe.test('Gas Carbon Neutral_Gas_Ren_V317.xlsx'));
  assert.ok(!s.filesRe.test('BGB_Gas_Broker_Tool_V317.xlsx'));
  assert.ok(!s.filesRe.test('BGB_Elec_Broker_Tool_V317.xlsb'));
  const o = L.settingsFrom({ bgportal_enabled: 'false', bgportal_hold_until_monday: 'TRUE', bgportal_folder_id: ' X ', bgportal_files: '^Natural' });
  assert.equal(o.enabled, false);
  assert.equal(o.holdUntilMonday, true);
  assert.equal(o.folderId, 'X');
  assert.ok(o.filesRe.test('natural REGO_Elec_V317.xlsx'));
  const bad = L.settingsFrom({ bgportal_files: '([' });
  assert.equal(bad.warnings.length, 1);
  assert.ok(bad.filesRe.test('Standard_Elec_V317.xlsx'), 'a broken pattern falls back to the default');
});

test('versions, products and document ids', () => {
  assert.deepEqual(L.versionOf('Standard_Elec_V317.xlsx'), { v: 317, sub: 0 });
  assert.deepEqual(L.versionOf('BGB_Gas_Broker_Tool_V316_V2.xlsx'), { v: 316, sub: 2 });
  assert.deepEqual(L.versionOf('Standard_Elec_V317 (1).xlsx'), { v: 317, sub: 0 });
  assert.equal(L.versionOf('Standard_Elec.xlsx'), null);
  assert.ok(L.compareVersion({ v: 317, sub: 0 }, { v: 316, sub: 2 }) > 0);
  assert.ok(L.compareVersion({ v: 316, sub: 2 }, { v: 316, sub: 0 }) > 0);
  assert.equal(L.compareVersion(null, null), 0);
  assert.ok(L.compareVersion({ v: 1, sub: 0 }, null) > 0);
  assert.equal(L.productOf('Standard_Gas_Acq_DSC_V317.xlsx'), 'standard_gas_acq_dsc');
  assert.equal(L.productOf('Standard_Gas_Acq_V317.xlsx'), 'standard_gas_acq');
  assert.equal(L.productOf('BGB_Gas_Broker_Tool_V316_V2.xlsx'), 'bgb_gas_broker_tool');
  assert.equal(L.productOf('Natural REGO_Elec_V317.xlsx'), 'natural_rego_elec');
  assert.equal(L.productOf('Standard_Elec_V317 (1).xlsx'), 'standard_elec');
  assert.equal(L.docIdOf('/servlet/servlet.FileDownload?file=015R500000IesycIAB'), '015R500000IesycIAB');
  assert.equal(L.docIdOf('https://x/servlet/servlet.FileDownload?file=015R500000IesycIAB&oid=1'), '015R500000IesycIAB');
  assert.equal(L.docIdOf('/servlet/servlet.FileDownload'), null);
});

test('dates: dd/mm/yyyy, UK midnight and the Monday after', () => {
  assert.equal(L.parseUkDate('27/11/2026'), '2026-11-27');
  assert.equal(L.parseUkDate('1/2/2027'), '2027-02-01');
  assert.equal(L.parseUkDate('31/02/2026'), null);
  assert.equal(L.parseUkDate('2026-11-27'), null);
  assert.equal(L.firstMondayOnOrAfter('2026-11-27'), '2026-11-30');      // Friday
  assert.equal(L.firstMondayOnOrAfter('2026-11-30'), '2026-11-30');      // Monday gives itself
  assert.equal(L.firstMondayOnOrAfter('2026-11-29'), '2026-11-30');      // Sunday
  assert.equal(L.firstMondayOnOrAfter('2026-12-28'), '2026-12-28');
  assert.equal(L.firstMondayOnOrAfter('2026-12-31'), '2027-01-04');      // across the year
  assert.equal(L.iso(L.holdUntil('2026-11-27')), '2026-11-30T00:00:00.000Z');   // GMT
  assert.equal(L.iso(L.holdUntil('2026-06-05')), '2026-06-07T23:00:00.000Z');   // BST: 00:00 UK is 23:00 UTC
  assert.equal(L.iso(L.ukMidnight('2026-03-29')), '2026-03-29T00:00:00.000Z');  // clocks go forward at 01:00
  assert.equal(L.iso(L.ukMidnight('2026-10-25')), '2026-10-24T23:00:00.000Z');  // still BST at midnight
  assert.equal(L.ukDateByRule(Date.parse('2026-06-07T23:30:00Z')), '2026-06-08');
  assert.equal(L.tsMs('2026-11-28T13:06:34.191122+00:00'), Date.parse('2026-11-28T13:06:34.191Z'));
  assert.equal(L.tsMs('2026-11-28 13:06:34.191122+00'), Date.parse('2026-11-28T13:06:34.191Z'));
  assert.ok(Number.isNaN(L.tsMs(null)));
});

test('the waiting note is the loader\'s form, and reads back', () => {
  const until = L.holdUntil('2026-11-27');
  const note = L.waitNote(until);
  assert.match(note, /^waiting until Mon 30 Nov 00:00: /);
  assert.match(note, /\[until=2026-11-30T00:00:00\.000Z\]$/);
  assert.equal(L.waitUntilOf(note), until);
  assert.equal(L.waitUntilOf('collected from the BG partner portal'), null);
});

test('the real listing: all 36 rows tidy, the five Standard V317 books are the candidates', () => {
  const rows = L.normaliseRows(raw());
  assert.equal(rows.length, 36);
  const elec = rows.find((r) => r.name === 'Standard_Elec_V317.xlsx');
  assert.equal(elec.docId, '015R500000Iet6fIAB');
  assert.equal(elec.url, 'https://bgbpartnerportal.my.site.com/servlet/servlet.FileDownload?file=015R500000Iet6fIAB');
  assert.equal(elec.lastModified, '2026-11-27');
  assert.equal(elec.product, 'standard_elec');
  const c = L.chooseFiles(rows, L.settingsFrom({}), {});
  assert.deepEqual(names(c.candidates), STANDARD_V317);
  assert.deepEqual(names(c.wanted), STANDARD_V317);
  assert.equal(c.skipped.length, 0);
});

test('choose: a _V2 beats the plain file of the same version; newer beats older', () => {
  const rows = L.normaliseRows(raw([
    ['Standard_Elec_V316.xlsx', '015R500000IVc3RIAT', '21.9 MB', '20/11/2026'],
    ['Standard_Elec_V316_V2.xlsx', '015R500000IVc3RIAX', '21.9 MB', '23/11/2026'],
    ['Standard_Elec_V315.xlsx', '015R500000IMf29IAD', '21.9 MB', '13/11/2026'],
  ]));
  const c = L.chooseFiles(rows, L.settingsFrom({}), {});
  assert.deepEqual(names(c.wanted), ['Standard_Elec_V316_V2.xlsx']);
});

test('choose: skips what is already collected, already loaded since BG posted it, or older than live', () => {
  const rows = L.normaliseRows(raw());
  const s = L.settingsFrom({});
  // Zak loaded V317 by hand on Sat 28 Nov 13:05 (after BG posted it on Fri 27 Nov).
  const loadedByHand = STANDARD_V317.map((n) => ({ source_filename: n, status: 'live', uploaded_at: '2026-11-28T13:06:30.042799+00:00', uploaded_by_name: 'Zak Ilic' }));
  let c = L.chooseFiles(rows, s, { uploads: loadedByHand });
  assert.equal(c.wanted.length, 0);
  assert.equal(c.skipped.length, 5);
  assert.match(c.skipped[0].why, /^already loaded on 2026-11-28 by Zak Ilic$/);
  // The same name loaded BEFORE BG posted this copy (a re-post) is fetched again; sha decides later.
  const earlier = [{ source_filename: 'Standard_Elec_V317.xlsx', status: 'live', uploaded_at: '2026-11-26T09:00:00+00:00' }];
  c = L.chooseFiles(rows, s, { uploads: earlier });
  assert.ok(names(c.wanted).includes('Standard_Elec_V317.xlsx'));
  // A failed upload does not count as having it.
  c = L.chooseFiles(rows, s, { uploads: [{ source_filename: 'Standard_Elec_V317.xlsx', status: 'failed', uploaded_at: '2026-11-28T10:00:00Z' }] });
  assert.ok(names(c.wanted).includes('Standard_Elec_V317.xlsx'));
  // Already collected from the portal.
  c = L.chooseFiles(rows, s, { collected: new Set(['015R500000Iet6fIAB']) });
  assert.equal(c.wanted.length, 4);
  assert.equal(c.skipped[0].why, 'already collected from the portal');
  // A newer book already live for that product.
  c = L.chooseFiles(rows, s, { uploads: [{ source_filename: 'Standard_Gas_Acq_V318.xlsx', status: 'live', uploaded_at: '2026-12-04T15:00:00Z' }] });
  assert.ok(!names(c.wanted).includes('Standard_Gas_Acq_V317.xlsx'));
  assert.match(c.skipped.find((x) => x.row.name === 'Standard_Gas_Acq_V317.xlsx').why, /newer book is already live \(Standard_Gas_Acq_V318\.xlsx\)/);
  // ... but a newer one for ANOTHER product does not block it.
  assert.ok(names(c.wanted).includes('Standard_Gas_Acq_DSC_V317.xlsx'));
});

test('normaliseRows: a page that is not the documents list is a LayoutError', () => {
  assert.throws(() => L.normaliseRows([]), L.LayoutError);
  assert.throws(() => L.normaliseRows([{ name: 'x', href: '/something/else' }]), /download link/);
  assert.throws(() => L.normaliseRows([{ name: 'x.xlsx', href: '/servlet/servlet.FileDownload?file=015R500000IesycIAB', modified: 'yesterday' }]), /Last Modified/);
});

test('the pricebook_inbox row, with and without the Monday hold', () => {
  const [f] = L.normaliseRows(raw([['Standard_Elec_V317.xlsx', '015R500000Iet6fIAB', '21.9 MB', '27/11/2026']]));
  const now = Date.parse('2026-11-27T13:40:00Z');
  const path = L.storagePath(now, f.docId, f.name);
  assert.equal(path, 'bgportal/2026-11-27/015R500000Iet6fIAB-Standard_Elec_V317.xlsx');
  const r = L.inboxRow({ file: f, sha: 'ab'.repeat(32), size: 22963200, path, nowMs: now, settings: L.settingsFrom({}) });
  assert.deepEqual(r, {
    message_id: 'bgportal:015R500000Iet6fIAB', internet_message_id: null, received_at: '2026-11-27T13:40:00.000Z',
    sender: 'BG partner portal (bgbpartnerportal.my.site.com)', subject: 'British Gas portal: Energy Quote Tools & Flatfiles V317',
    rule_id: null, supplier_key: 'british_gas', kind: 'attachment', file_name: 'Standard_Elec_V317.xlsx',
    content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 22963200,
    sha256: 'ab'.repeat(32), storage_path: path,
    link_url: 'https://bgbpartnerportal.my.site.com/servlet/servlet.FileDownload?file=015R500000Iet6fIAB',
    status: 'new', status_note: 'collected from the BG partner portal',
  });
  const held = L.inboxRow({ file: f, sha: 'x', size: 1, path, nowMs: now, settings: L.settingsFrom({ bgportal_hold_until_monday: 'true' }) });
  assert.equal(L.waitUntilOf(held.status_note), Date.parse('2026-11-30T00:00:00Z'));
  // Collected on the Monday itself: nothing to wait for.
  const monday = L.inboxRow({ file: f, sha: 'x', size: 1, path, nowMs: Date.parse('2026-11-30T08:00:00Z'), settings: L.settingsFrom({ bgportal_hold_until_monday: 'true' }) });
  assert.equal(monday.status_note, 'collected from the BG partner portal');
  assert.equal(L.safeName('Natural REGO_Elec V317 (1).xlsx'), 'Natural_REGO_Elec_V317_1_.xlsx');
});

test('bytes, hashes and masking', () => {
  assert.ok(L.isXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])));
  assert.ok(!L.isXlsx(new TextEncoder().encode('<html>Login | Partner Portal</html>')));
  assert.ok(!L.isXlsx(null));
  assert.equal(L.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(L.mask('pw is Hunter2!! and Hunter2!!', ['Hunter2!!']), 'pw is *** and ***');
  assert.equal(L.mask('nothing', ['', null, 'ab']), 'nothing');
});

test('alerts: plain English, one a day per kind', () => {
  const now = Date.parse('2026-11-27T13:40:00Z');
  assert.equal(L.dedupeKey('login_failed', now), 'bgportal:login_failed:2026-11-27');
  const a = L.alertFor('login_failed', 'Your login attempt has failed.', 'https://github.com/x/y/actions/runs/1');
  assert.match(a.subject, /could not sign in/);
  assert.match(a.body, /BG_PORTAL_PASSWORD/);
  assert.match(a.body, /Your login attempt has failed\./);
  assert.match(a.body, /actions\/runs\/1/);
  assert.match(L.alertFor('verification_required', '').body, /verification/i);
  assert.match(L.alertFor('layout_changed', 'no folder').body, /tools\/bg-portal-pull/);
  assert.match(L.alertFor('failed', 'boom').body, /next scheduled run/);
  assert.equal(L.alertFor('ok'), null);
  for (const o of L.ALERT_OUTCOMES) {
    const x = L.alertFor(o, 'd');
    assert.ok(!(x.subject + x.body).includes(String.fromCharCode(0x2014)), 'no em dashes in an alert');
  }
});

test('summary markdown', () => {
  const md = L.summaryMarkdown({ version: L.VERSION, dry: true, outcome: 'dry_run', note: 'would collect 1', filesSeen: 36, newFiles: 0,
    files: [{ name: 'Standard_Elec_V317.xlsx', lastModified: '2026-11-27', outcome: 'would collect', note: '21.9 MB | x' }] });
  assert.match(md, /BG portal puller \(bg-portal-pull 2026-11-28\.1, dry run\)/);
  assert.match(md, /Documents in the folder: 36/);
  assert.match(md, /\| Standard_Elec_V317\.xlsx \| 2026-11-27 \| would collect \| 21\.9 MB \/ x \|/);
});

// ---- the page-side reader, on a tiny fake DOM ---------------------------------------------------
function fakeDom(list, { dataTable = true, headers = true } = {}) {
  const cellsFor = (r) => ['View', r.name, '', r.size, r.type, r.folder, r.modified].map((t) => ({ textContent: t }));
  const trs = raw(list).map((r) => {
    const a = { getAttribute: (k) => (k === 'href' ? r.href : null) };
    const tds = cellsFor(r);
    return { querySelectorAll: (s) => (s === 'td' ? tds : []), querySelector: (s) => (/FileDownload/.test(s) ? a : null) };
  });
  const ths = ['Action', 'Document Name', 'Description', 'Size', 'Type', 'Folder Name', 'Last Modified'].map((t) => ({ textContent: t }));
  const table = {
    textContent: (headers ? 'Action Document Name Description Size Type Folder Name Last Modified ' : '') + list.map((x) => x[0]).join(' '),
    querySelector: (s) => (/FileDownload/.test(s) ? trs[0].querySelector(s) : null),
    querySelectorAll: (s) => (s === 'thead th' ? (headers ? ths : []) : s === 'tbody tr' ? trs.slice(0, 10) : []),
  };
  const doc = { querySelectorAll: (s) => (s === 'table' ? [{ textContent: 'layout', querySelector: () => null, querySelectorAll: () => [] }, table] : []) };
  const jq = (t) => ({ DataTable: () => ({ rows: () => ({ nodes: () => ({ toArray: () => (t === table ? trs : []) }) }) }) });
  jq.fn = { dataTable: { isDataTable: (t) => t === table } };
  return { doc, win: dataTable ? { jQuery: jq } : {} };
}

test('extractRows reads all 36 rows through the DataTable, not just the 10 on screen', () => {
  const { doc, win } = fakeDom(LISTING);
  const out = extractRows(doc, win);
  assert.equal(out.how, 'datatable');
  assert.equal(out.rows.length, 36);
  assert.deepEqual(out.rows[12], { name: 'Standard_Elec_V317.xlsx', href: '/servlet/servlet.FileDownload?file=015R500000Iet6fIAB',
    description: '', size: '21.9 MB', type: 'xlsx', folder: FOLDER, modified: '27/11/2026' });
  assert.equal(L.normaliseRows(out.rows).length, 36);
});

test('extractRows without the DataTable reads the DOM rows; without headers it falls back to positions', () => {
  let { doc, win } = fakeDom(LISTING, { dataTable: false });
  let out = extractRows(doc, win);
  assert.equal(out.how, 'dom');
  assert.equal(out.rows.length, 10);
  ({ doc, win } = fakeDom(LISTING, { headers: false }));
  out = extractRows(doc, win);
  assert.match(out.how, /positions/);
  assert.equal(out.rows[0].name, 'Standard_Gas_Ren_V317.xlsx');
  assert.equal(out.rows[0].modified, '27/11/2026');
  const empty = extractRows({ querySelectorAll: () => [] }, {});
  assert.deepEqual(empty, { rows: [], headers: [], how: '' });
});

test('loginState: in, still on the login page, verification, password change', () => {
  assert.equal(loginState('https://bgbpartnerportal.my.site.com/home/home.jsp', 'Logout', false), 'in');
  assert.equal(loginState('https://bgbpartnerportal.my.site.com/login', 'Your login attempt has failed.', true), 'login_page');
  assert.equal(loginState('https://bgbpartnerportal.my.site.com/_ui/identity/verification/method/EmailVerificationFinishUi', '', false), 'verification_required');
  assert.equal(loginState('https://bgbpartnerportal.my.site.com/somewhere', 'Verify Your Identity', false), 'verification_required');
  assert.equal(loginState('https://bgbpartnerportal.my.site.com/_ui/system/security/ChangePassword', '', false), 'password_change');
});
