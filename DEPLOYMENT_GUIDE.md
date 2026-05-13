# CES Billing Portal — Live Deployment Guide
## Netlify + Postgres Database Backend

---

## What This Package Contains

```
CESbilling GitHub repository structure:
├── public/
│   └── index.html                  ← The portal (all three pages)
├── netlify/
│   └── functions/
│       ├── auth.js                 ← Login validation
│       ├── get-reports.js          ← Fetch reports for dashboard
│       ├── get-customers.js        ← Admin: list all customers
│       ├── save-customer.js        ← Admin: create / update / delete customers
│       ├── save-report.js          ← Admin: upload report + metadata
│       ├── delete-report.js        ← Admin: remove a report
│       ├── init-db.js              ← One-time database setup
│       └── package.json            ← pg (Postgres) dependency
├── netlify.toml                    ← Build + routing config
└── DEPLOYMENT_GUIDE.md             ← This file
```

---

## Step 1 — Add Two Environment Variables in Netlify

Go to: **Netlify Dashboard → cesbilling project → Project configuration → Environment variables**

Add these two variables:

| Variable name          | Value                                                                                          |
|------------------------|-----------------------------------------------------------------------------------------------|
| `NETLIFY_DATABASE_URL` | `postgresql://netlifydb_owner:npg_9lstdI8ahKQi@ep-purple-dust-aju2gpz4.c-3.us-east-2.db.netlify.com/netlifydb?sslmode=require` |
| `ADMIN_SECRET`         | `CES_ADMIN_2025_SECRET`                                                                       |

**Important:** Once deployed, change `ADMIN_SECRET` to something unique and update the matching line in `public/index.html`:
```javascript
const ADMIN_SECRET = 'CES_ADMIN_2025_SECRET'; // ← change this to match
```

Also strongly recommended: rotate your database password via Netlify Database dashboard,
as the current credentials have been shared in a chat conversation.

---

## Step 2 — Upload Files to Your GitHub Repository

1. Go to **github.com** and open your **CESbilling** repository
2. You need to create the folder structure. The easiest way:
   - Click **"Add file" → "Upload files"**
   - Drag in `public/index.html` → it will ask for the path — type `public/index.html`
   - Repeat for each file in `netlify/functions/` → path e.g. `netlify/functions/auth.js`
   - Upload `netlify.toml` to the root

   **Or using GitHub Desktop (easier for multiple files):**
   - Download GitHub Desktop from desktop.github.com
   - Clone your CESbilling repository
   - Copy all files from this package into the cloned folder
   - Commit and push — Netlify will auto-deploy within 60 seconds

3. Once pushed, Netlify automatically deploys. Watch progress under **Deploys** in your dashboard.

---

## Step 3 — Initialise the Database (run once only)

Once deployed, visit this URL in your browser to create the database tables:

```
https://cesbilling.com/.netlify/functions/init-db?secret=CES_ADMIN_2025_SECRET
```

You should see:
```json
{
  "success": true,
  "message": "Database initialised successfully",
  "customers": 2,
  "reports": 0
}
```

This creates the `customers` and `reports` tables and seeds:
- Admin account: username `admin` / password `CESadmin2025!`
- Blank Table Ltd: username `blanktable` / password `ces2025!`

**Change both passwords immediately** via the admin panel after first login.

---

## Step 4 — Verify Everything Works

1. Visit **cesbilling.com** — you should see the login page
2. Log in as `admin` / `CESadmin2025!` — you should see the admin dashboard
3. Add a test customer via the **Add Customer** tab
4. Log out and log in as the new customer — their dashboard should appear (empty reports)
5. Log back in as admin, upload a test report for that customer
6. Log in as the customer again — the report should appear

**If any step fails**, check:
- Netlify **Deploys** tab for build errors
- Netlify **Logs & metrics → Function logs** for runtime errors
- That both environment variables are set correctly (Step 1)

---

## Step 5 — Change Your Admin Secret (Security)

In `public/index.html`, find this line near the top of the script block:
```javascript
const ADMIN_SECRET = 'CES_ADMIN_2025_SECRET';
```

Change it to something long and random, e.g.:
```javascript
const ADMIN_SECRET = 'CES-xK9mP2qR7vL4nW8jT5';
```

Update the `ADMIN_SECRET` environment variable in Netlify to the same value.
Commit and push — deploy takes ~60 seconds.

---

## How It Works Going Forward

Every action in the admin panel now writes directly to your Netlify Postgres database:

| Admin action          | What happens                                              |
|-----------------------|-----------------------------------------------------------|
| Add customer          | New row in `customers` table — login works immediately    |
| Reset password        | `password_hash` updated in database                      |
| Delete customer       | Customer + all their reports removed from database        |
| Upload report         | Report metadata + HTML stored in `reports` table          |
| Delete report         | Row removed from `reports` table                          |

Every customer login reads live from the same database — identical data on every device,
every browser, with no resets when tabs are closed.

---

## Monthly Report Workflow (unchanged from before)

1. Produce the HTML validation report using the Bill Validation skill
2. Log in to cesbilling.com as admin
3. Go to **Upload Report** tab
4. Select customer, period, fill in sites/cost/issues
5. Drag in the HTML file
6. Click **Add report to portal**
7. Done — the customer can see it immediately from any device
