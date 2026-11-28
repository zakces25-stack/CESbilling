# BG portal puller (GitHub Actions)

Collects British Gas price books from their partner portal so nobody has to download them by hand.

British Gas stopped emailing price books and put them on the BGB (Salesforce) partner portal,
https://bgbpartnerportal.my.site.com, under Documents > Energy Quote Tools & Flatfiles. They post
the next week's books on a Friday (V317 on Fri 27 Nov 2026) for the Monday.

Every run, this:

1. Signs in to the portal in a headless Chromium with the BG login held in two GitHub secrets.
2. Opens Documents, picks the "Energy Quote Tools & Flatfiles" folder and reads every document in it
   (the page shows 10 at a time; it reads all of them).
3. Keeps only the books the desk loads (`bgportal_files`, by default the five `Standard_*` books:
   Standard_Elec and Standard_Gas Acq / Ren, with and without DSC), the newest version of each, and
   drops any it already has:
   - collected from the portal before (pricebook_inbox),
   - loaded on the desk since BG posted it (pricebook_uploads, any person or the loader),
   - older than the British Gas book that is live for that product.
4. Downloads each with the signed-in session, checks it really is an Excel file, and puts it in the
   pricing mailbox store exactly as if it had been emailed: the `pricebook-inbox` bucket plus a
   `pricebook_inbox` row (supplier `british_gas`, sender "BG partner portal").
5. Starts the Pricebook loader workflow, which loads it with the desk's own reader and the desk's own
   checks (the Supabase kick would also start it within five minutes).

It never changes a pricebook, a rate or a meter itself. The login is not in the website: anyone who
opens a page of the website could read what is in it. It is in GitHub secrets, and the IONOS Deploy
Now workflows only publish `./public`.

## Setup (once)

GitHub, CESbilling repository, Settings, Secrets and variables, Actions:

| Name | Kind | Value |
|---|---|---|
| `BG_PORTAL_USERNAME` | secret | the BG partner portal login (the one CES signs in with) |
| `BG_PORTAL_PASSWORD` | secret | its password |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | already there for the Pricebook loader |
| `SUPABASE_URL` | variable | already there for the Pricebook loader |

Commit `tools/bg-portal-pull/` and `.github/workflows/bg-portal-pull.yml` to the default branch
(a workflow can only be started once its file is there). Then run it once as a dry run (below).

If the BG password changes, update `BG_PORTAL_PASSWORD`. Nothing else needs touching.

## Running it by hand

GitHub, Actions, BG portal puller, Run workflow:

- **dry run** ticked: signs in, lists the folder, downloads the books it would take to check they are
  real Excel files, and stores nothing. The run summary says what it would have collected.
- not ticked: a normal run.

It also runs by itself every two hours on weekdays (07:10 to 19:10 UTC) and hourly on Friday
afternoons, when British Gas usually post.

Locally, with Node 22: `npm ci` in this folder, `npx playwright install chromium`, then
`SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... BG_PORTAL_USERNAME=... BG_PORTAL_PASSWORD=... DRY_RUN=true node run.mjs`.

## Outcomes (in `pricebook_portal_runs`, portal `bg`)

| Outcome | Meaning | Email |
|---|---|---|
| ok | New books stored for the loader (a note lists them; any that failed are emailed) | only for failures |
| nothing_new | Signed in, nothing new to collect | no |
| dry_run | A dry run | no |
| disabled | `bgportal_enabled` is false | no |
| login_failed | The portal refused the login (wrong or expired password, or it wants a new password) | yes, once a day |
| verification_required | The portal asked for an identity verification code | yes, once a day |
| layout_changed | The Documents page is not as expected, or no file matches `bgportal_files` | yes, once a day |
| failed | Something broke (network, the database, a download that was not a file, missing secrets) | yes, once a day |

Alert emails go into `pricebook_alerts` (source `bgportal`) and the `pricebook-notices` edge
function sends them through Resend to `pricebook_mail_config.alert_to`. Any outcome from
login_failed down also turns the GitHub run red.

## Switches (`pricebook_mail_config`)

| Key | Default | What it does |
|---|---|---|
| `bgportal_enabled` | `true` | `false` stops it (runs still start and stop at once) |
| `bgportal_folder_id` | `00l0g000001UxTlAAK` | the "Energy Quote Tools & Flatfiles" folder |
| `bgportal_files` | `^Standard_(Elec\|Gas_(Acq\|Ren)(_DSC)?)_V\d+(_V\d+)?\.xlsx$` | which documents to take (a pattern, any case) |
| `bgportal_hold_until_monday` | `false` | `true` makes each new book wait in the mailbox until 00:00 on the Monday after BG posted it |

With `bgportal_hold_until_monday` off (the default) a book posted on Friday loads on Friday, which is
what the pricing team did by hand. Turn it on to keep quoting the current week's book until Monday.

Example: `update pricebook_mail_config set value = 'true' where key = 'bgportal_hold_until_monday';`

## Tests

`npm test` in this folder (no `npm ci` needed: the tests use only Node). They run the pure logic on
the real folder listing read from the portal on 28 Nov 2026, the page-side reader on a small fake
page, and the whole run against a fake portal and an in-memory database. No browser, nothing leaves
the machine.
