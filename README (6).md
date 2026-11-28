# Pricebook loader (GitHub Actions)

Loads supplier pricebooks into the pricing desk without anyone pressing Load.

The `pricebook-mail` edge function already collects every supplier's books from pricingteam@ into
`pricebook_inbox` every 15 minutes. Until now only E.ON Next loaded itself (the `pricebook-autoload`
edge function). This loader does the rest. It runs on a GitHub Actions runner because a
TotalEnergies power book takes minutes of parsing, and a Supabase edge function gets two seconds of CPU.

It reads books with the desk's own reader: `public/pricing-parsers.js` and `public/pricing-7z.js`
from the same checkout the website deploys from. It stops if `pricing-parsers.js` is not the version
`pricing.html` expects, so it can never read a book differently from the desk.

## What happens to each mailbox file

Newest first, at most 12 files a run, with a 45 minute time budget (whatever is left waits for the
next run).

1. **Live mode only** (`pricebook_mail_config.notices_mode = live`): if the mailbox watcher has not
   read the email yet and it arrived under 30 minutes ago, the file is left for the next run.
2. If the watcher says the book in that email only goes live on a later date (for example BG Lite's
   "going live on 30/11/2026"), then in live mode the file waits until then, with a note on the
   mailbox row. In watch mode it loads straight away and the log says it would have waited.
3. The loader claims the file, unpacks it exactly as the desk does (7z, zip, E.ON's password zip,
   single files), routes each file inside to a product by its name, and puts it through the desk's
   checks in the desk's order: product rule, quotable, registered layout, same file already live,
   newer book already live, parse, nothing parsed, past its own end date.
4. It then compares the book with the one it would replace: share of rows refused, row count (more
   than 20% different holds it), and the median electricity rate, gas rate and standing charge (more
   than 25% different holds it).
5. It stores the receipt copy, inserts the rates, goes live, and deletes the replaced book's rates
   straight away, as the desk does.

## Outcomes (in `pricebook_autoload_runs`, version `pricebook-loader ... (GitHub)`)

| Outcome | Meaning | Mailbox row |
|---|---|---|
| loaded | Every book in the file is live (or was already live). | loaded |
| skipped | Nothing to load: older than the live book, past its end date, or not a product CES quotes. | skipped, with why |
| held | A person has to look: new layout, no product rule, file will not open, nothing parsed, or too different from the book it replaces. One alert email is sent. | new, note starts `automatic load held:` |
| failed | Something broke (usually the network or the database). Tried again on the next run. | new, note says which attempt |
| held after 3 failures | Three runs in a row failed. One alert email is sent. | new, `automatic load held: it failed 3 times` |
| waiting | The mailbox watcher has not read the email yet, or the book goes live on a later date. | new (with a `waiting until ...` note for a date) |
| busy | Someone else is loading the same file right now. | new |
| dry run | A dry run: every check, nothing loaded. | unchanged |

A held file is never picked up again by the loader. Load it by hand on the desk (Pricebooks,
Mailbox) after checking it, or re-run the workflow for that one file (below).

Alert emails go into `pricebook_alerts`; the `pricebook-notices` edge function sends them through
Resend to `pricebook_mail_config.alert_to`. The loader holds no email credentials.

## Setup (once)

1. **GitHub repository variable** `SUPABASE_URL` = `https://niadffxpxdohglcyagau.supabase.co`
   (Settings, Secrets and variables, Actions, Variables).
2. **GitHub repository secret** `SUPABASE_SERVICE_ROLE_KEY` = the service role key from Supabase
   (Project settings, API). Keep the repository private: the key can read and write everything.
3. **A GitHub token for the kick**: a fine-grained personal access token for the CESbilling
   repository only, with the single permission "Actions: Read and write". Save it in Supabase Vault
   (SQL editor): `select vault.create_secret('<the token>', 'github_loader_token');`
4. **Tell Supabase where the repository is** (SQL editor):
   `update pricebook_mail_config set value = '<owner>/CESbilling' where key = 'loader_github_repo';`
5. Commit `tools/pricebook-loader/` and `.github/workflows/pricebook-loader.yml` to the default branch.
   A workflow can only be started once its file is on the default branch.

Then run it once by hand as a dry run (below) and check the log.

## Running it by hand

GitHub, Actions, Pricebook loader, Run workflow:

- **dry run** ticked: every check on every waiting file, nothing loaded. The run summary and
  `pricebook_autoload_runs` say what would have happened.
- **inbox_id**: load just that mailbox file (its `pricebook_inbox.id`). This also works on a held
  or failed file, and skips the waits, so use it after you have checked the file.

Locally, with Node 22: `npm ci` in this folder, then
`SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=true node run.mjs`.

## Switching it off

`update pricebook_mail_config set value = 'false' where key = 'loader_enabled';` stops it loading
anything (runs still start and stop at once). To leave one supplier to people, add it to
`loader_exclude` (comma separated; `eon_next` is there by default because the E.ON edge autoload
already handles it).

Tuning: `loader_rows_change` (default 0.20) and `loader_median_change` (default 0.25).

## Tests

`npm ci && npm test` in this folder. The tests use the real `public/pricing-parsers.js` (from
`../../public`, or `PUBLIC_DIR`) on small made-up books, an in-memory copy of the database for the
whole flow, and the real supabase-js client with a recording fetch for the database requests.
Nothing leaves the machine.
