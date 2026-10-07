# actual-autopilot

Reads bank alert emails from Gmail, adds each transaction to a self-hosted [Actual Budget](https://actualbudget.org), and fills in categories with Google Gemini on its free tier. It runs as one small Docker container next to Actual. Nothing is exposed to the internet.

## What a run does (every 2 hours by default)

1. **Ingest.** Reads your email over IMAP (read-only): every email by default, or only the senders in `ALERT_SENDERS`. Emails that don't mention a dollar amount are skipped without asking Gemini. Gemini pulls out the date, amount, payee and card, so it keeps working when a bank changes its email layout. Bank alerts, receipts and payment-portal confirmations count; statements, reminders, future-dated payments and marketing are skipped. It reuses your existing Actual payee names, and several emails about one payment (say a rent portal receipt and the bank's withdrawal notice) become one transaction through the duplicate check below. Receipts that don't name a card (Amazon orders, DoorDash, walmart.com) don't create transactions; they wait up to 30 days for the bank's charge from the same merchant (same amount, or within 20% for split shipments and tips, within 7 days) and write what was bought into its notes, e.g. "Supplements (order 113-…)" or "Chipotle: burrito bowl". The bank's raw merchant text (like `DOORDASH*CHIPOTLE`) goes into the notes too when it says more than the payee. Each email is handled once (tracked in `/data`), and each transaction goes through the duplicate check below, so a charge already imported from a bank file isn't added again.
2. **Categorize.** Collects uncategorized transactions from the last `CATEGORIZE_DAYS`, whether they came from email, a CSV import or manual entry. Sends them to Gemini with your category list and how you categorized each payee before.
3. **Apply.** Picks at or above `MIN_CONFIDENCE` get the category, and their notes end with `#autopilot` (anything the app creates or annotates does; older `auto: ...` tags are rewritten to it). Payees stick to the ones you already have in Actual: Gemini picks from your payee list (e.g. a Racetrac charge goes to your "Gas Stations" payee, with "Racetrac" in the notes), and a new payee is only made when nothing fits. The web page lists everything autopilot added in the last 30 days so you can edit the notes. Everything else keeps no category and gets `#review maybe <guess>` in its notes. Search `#review` in Actual to go through them.

Actual's own rules still run on import, so payees you already have rules for never reach Gemini.

## Setup

1. **Bank alerts.** Turn on alerts for every purchase (threshold $0) on each card and checking account. For Capital One that's Profile > Alerts, and for Chase it's Profile > Alerts > Account alerts. Point them at the Gmail account this reads.
2. **Gmail app password.** At https://myaccount.google.com/apppasswords (this needs 2-Step Verification). IMAP is on by default for Gmail.
3. **Gemini API key (free).** See [Gemini free tier](#gemini-free-tier) below for the steps and the privacy trade-off.
4. **Configure.** Copy `.env.example` to `.env` and fill it in. `ACCOUNT_MAP` maps the last 4 digits in an email to the exact account name in Actual.
5. **Run.** Either:
   - **Komodo:** create a Stack from this Git repo (compose file `compose.yaml`) and paste the `.env` contents into the stack's Environment, or
   - **Any Docker host:** `docker compose up -d --build`.
6. **Check the dry run.** `DRY_RUN=true` is the default. Watch the logs (`docker logs -f actual-autopilot`) for a run, and if the imports and categories look right, set `DRY_RUN=false` and redeploy.

Pushing to `main` also builds `<dockerhub-user>/actual-autopilot:latest` (amd64 and arm64) and pushes it to Docker Hub through GitHub Actions. It needs a repo variable `DOCKERHUB_USERNAME` and a repo secret `DOCKERHUB_TOKEN` (a Docker Hub access token with Read & Write). To have Komodo pull the image instead of building, switch `compose.yaml` from `build: .` to that image.

## Bank export files

Mount a folder at `/import` and drop files downloaded from your bank into it: QFX/OFX (best, since they carry the bank's own IDs), QIF, or CSV. Within a few minutes each file is imported into the right account and moved to `/done` (as `YYYY-MM-DD_<name>`). Files the app can't fully handle go to `/done/failed` with the reason in the logs; fix the problem and drop the file in again.

The account is picked from, in order: a card or account number column in the CSV (Capital One), the account number inside a QFX/OFX, a 4-digit number in the file name that's in `ACCOUNT_MAP` (Chase names files `Chase1234_Activity...`), or an Actual account name in the file name (`travel-card.csv`).

CSV layouts recognized by their headers: Capital One cards and 360 accounts, Chase cards and checking, and anything else with a date, a description, and either an amount or debit/credit columns.

Duplicates are checked before importing, across emails, files, and Actual's own Import button: same bank transaction ID, or the same amount in the same account within 4 days. So a pending charge from an email alert and the posted line from a later QFX end up as one transaction, and re-dropping a file adds nothing. One limit: two identical charges (same amount, same account, within 4 days) can be taken for one when only one is in Actual yet, so give those a look.

## Web page

The container serves a small page on port 8080 (`WEB_PORT`; `0` turns it off):

- **Header:** when the last run finished (and whether it had errors), when the next one is, and **Scan now**.
- **To check:** one list of what needs your eyes: transactions Gemini wasn't sure how to categorize (marked *Needs category*, with its guess selected, how sure it was and why), then transactions autopilot added or annotated in the last 30 days (marked *New*). Set the category and notes and press **Done** (or Enter in the notes box); the row is saved to Actual and leaves the list for good. **Skip** leaves a *Needs category* row uncategorized (it gets `#review-skipped` so Gemini doesn't try again). **Mark all done** clears the list with what's shown.
- **Export:** download a CSV or summary for a period (see Exports below).
- **Activity:** the recent log lines.

There is no login unless you set `WEB_PASSWORD` (any username). Don't expose the page outside your network without one.

## Exports (for you, scripts, or an AI assistant)

Every transaction in a date range as CSV (date, account, payee, transfer, category group, category, amount, notes, cleared, off budget, id), plus a summary: income, spending, saved (categories in a group named like "Savings" or "Investments"), net, spending by category, top payees, uncategorized and waiting-for-review counts, and every account's balance. Transfers between budget accounts are listed but left out of income and spending; a transfer to an off-budget account counts under its category.

Periods: `mtd` (default), `last-month`, `ytd`, `last-year`, `last-30` (any number of days), a month like `2026-09`, or `from`/`to` dates.

**From the web page or your network:** the Export panel, or
`/api/export.csv?period=last-month`, `/api/export.json?from=2026-09-01&to=2026-09-30`, `/api/summary?period=ytd`.

**By email, for anything that can read your Gmail but can't reach your network** (a phone, a cloud AI assistant with a Gmail connector):

- Every morning (`EXPORT_EMAIL_SCHEDULE`, default 6:30) the app emails you month to date (on the 1st, all of last month). Subject `[autopilot] Export <from> to <to> (...)`; the summary and the CSV are in the body between `----- BEGIN CSV -----` and `----- END CSV -----`, and attached.
- Send yourself an email with a subject like `autopilot: export last-month`, `autopilot: export 2026-09-01 2026-09-30`, `autopilot: summary ytd`, `autopilot: scan` or `autopilot: status`, and the app replies in the same thread within `REQUEST_POLL_MINUTES`. Only mail in your Sent folder counts, so nobody else can send it commands.
- The app's emails and your requests get the `Autopilot` label and are archived, so they don't fill the inbox. Gmail search: `label:autopilot subject:"[autopilot] Export"`.

## Gemini free tier

The app uses Gemini's free tier, so it costs nothing as long as the key's Google Cloud project has **no billing account**. Without billing, Google can't charge you: over a limit, requests just fail with a 429 until the limit resets.

**Privacy:** on the free tier Google may use what you send to improve its products, and human reviewers may read it. Here that's your bank alert emails (merchant, amount, date, last 4 of the card) and your payee and category names. If that's not OK, turn billing on for the project (paid-tier data isn't used that way) and set a budget alert, or set `CATEGORIZE=false` and `EMAIL_INGEST=false` to run without AI.

**Create the key:**

1. Go to https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key**. Let it create a new project, or pick one that has no billing account.
3. Copy the key into `GEMINI_API_KEY`.
4. Check the project's plan on that page says **Free**. If it says a paid tier, remove billing from the project, or make a new one for this key.

**Staying under the limits.** Free-tier limits are per project and per model, and Google changes them now and then; see yours at https://aistudio.google.com/rate-limit. The app paces itself with `GEMINI_RPM` (default 10 requests a minute) and `GEMINI_RPD` (default 200 a day, reset at midnight Pacific). Keep both below what that page shows. Past `GEMINI_RPD` it stops calling Gemini until the next day, and after any 429 it waits 15 minutes. Emails and transactions that miss out are picked up on a later run. Each new alert email is one request and each batch of up to 40 transactions to categorize is one more, so a typical day is a few dozen requests. The daily count starts over if the container restarts, but with no billing that can only cause 429s, never a bill.

## Backups

Mount a folder at `/backups` to get one zip of the whole budget per day (after the first run of the day), the same file as Actual's Settings > Export. Restore it from Actual's budget list with Import file > Actual. The newest `BACKUP_KEEP` are kept.

The container runs as uid 1000, so the import, done, and backup folders on the host must be writable by that uid. The startup log says so if they aren't.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ACTUAL_SERVER_URL` | required | LAN URL, e.g. `https://192.168.1.10:5006` |
| `ACTUAL_PASSWORD` | required | Actual server password |
| `ACTUAL_SYNC_ID` | required | Settings > Show advanced settings > Sync ID |
| `ACTUAL_E2E_PASSWORD` | | only for end-to-end encrypted budgets |
| `NODE_EXTRA_CA_CERTS` | | path to Actual's CA cert if it's self-signed |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | | email ingest is skipped if unset |
| `ALERT_SENDERS` | all mail | comma-separated senders to limit email reading to; empty or `*` = all |
| `LOOKBACK_DAYS` | `3` | how far back each run looks in Gmail |
| `ACCOUNT_MAP` | `{}` | `{"1234": "Checking"}`; a non-digit key names a merchant whose emails go to that account when they don't show one of your cards, e.g. `"DoorDash": "Credit Card"` for Google Pay orders |
| `GEMINI_API_KEY` | required | from https://aistudio.google.com/apikey, on a project without billing |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | any model with a free tier, e.g. `gemini-3.5-flash` for more judgment (lower free limits) |
| `GEMINI_RPM` | `10` | max requests per minute; keep below your free-tier limit |
| `GEMINI_RPD` | `200` | max requests per day (midnight Pacific); keep below your free-tier limit |
| `CATEGORIZE` | `true` | set `false` to only import |
| `CATEGORIZE_DAYS` | `30` | |
| `MIN_CONFIDENCE` | `0.8` | |
| `IMPORT_DIR` | `/import` | bank export drop folder; skipped if not mounted |
| `DONE_DIR` | `/done` | imported files move here; problem files go to `done/failed` |
| `IMPORT_POLL_MINUTES` | `5` | how often to check the drop folder between runs; `0` = only on schedule |
| `BACKUP_DIR` | `/backups` | daily budget backup; skipped if not mounted |
| `BACKUP_KEEP` | `30` | number of backups to keep |
| `WEB_PORT` | `8080` | web page port; `0` = off |
| `WEB_PASSWORD` | | require this password for the web page |
| `EXPORT_EMAIL_SCHEDULE` | `30 6 * * *` | cron for the daily export email; `off` = none |
| `EMAIL_REQUESTS` | `true` | answer `autopilot: ...` emails you send yourself |
| `REQUEST_POLL_MINUTES` | `5` | how often to check for those |
| `EXPORT_LABEL` | `Autopilot` | Gmail label for the app's own emails |
| `GMAIL_SENT_MAILBOX` | `[Gmail]/Sent Mail` | where requests are read from (change if Gmail isn't in English) |
| `DRY_RUN` | `true` | nothing is written to Actual and files stay in the drop folder; every email in `LOOKBACK_DAYS` is re-checked (cached Gemini answers are reused) and the run ends with a "Dry-run preview" listing each row it would create (`[new]`) or the existing row it matched and the notes it would write (`[exists]`) |
| `SCHEDULE` | `0 */2 * * *` | cron |
| `RUN_ONCE` | `false` | run one pass and exit |
| `TZ` | `America/New_York` | |

## Development

```bash
npm install
npm test
cp .env.example .env   # fill in
set -a; . ./.env; set +a; DATA_DIR=./data npm run once
```
