# actual-autopilot

Reads bank alert emails from Gmail, adds each transaction to a self-hosted [Actual Budget](https://actualbudget.org), and fills in categories with Claude. It runs as one small Docker container next to Actual. Nothing is exposed to the internet.

## What a run does (every 2 hours by default)

1. **Ingest.** Reads alert emails from the senders in `ALERT_SENDERS` over IMAP (read-only). Claude pulls out the date, amount, payee and card, so it keeps working when a bank changes its email layout. Statements, reminders and "upcoming payment" emails are skipped. Each transaction is imported with the Gmail message id as `imported_id`, so nothing is ever added twice.
2. **Categorize.** Collects uncategorized transactions from the last `CATEGORIZE_DAYS`, whether they came from email, a CSV import or manual entry. Sends them to Claude with your category list and how you categorized each payee before.
3. **Apply.** Picks at or above `MIN_CONFIDENCE` get the category and an `auto: Claude` note. Everything else keeps no category and gets `#review maybe <guess>` in its notes. Search `#review` in Actual to go through them.

Actual's own rules still run on import, so payees you already have rules for never reach Claude.

## Setup

1. **Bank alerts.** Turn on alerts for every purchase (threshold $0) on each card and checking account. For Capital One that's Profile > Alerts, and for Chase it's Profile > Alerts > Account alerts. Point them at the Gmail account this reads.
2. **Gmail app password.** At https://myaccount.google.com/apppasswords (this needs 2-Step Verification). IMAP is on by default for Gmail.
3. **Claude API key.** At https://console.anthropic.com. It's pay-as-you-go and separate from a Claude.ai subscription. Set a monthly spend limit there.
4. **Configure.** Copy `.env.example` to `.env` and fill it in. `ACCOUNT_MAP` maps the last 4 digits in an email to the exact account name in Actual.
5. **Run.** Either:
   - **Komodo:** create a Stack from this Git repo (compose file `compose.yaml`) and paste the `.env` contents into the stack's Environment, or
   - **Any Docker host:** `docker compose up -d --build`.
6. **Check the dry run.** `DRY_RUN=true` is the default. Watch the logs (`docker logs -f actual-autopilot`) for a run, and if the imports and categories look right, set `DRY_RUN=false` and redeploy.

Pushing to `main` also builds `<dockerhub-user>/actual-autopilot:latest` (amd64 and arm64) and pushes it to Docker Hub through GitHub Actions. It needs a repo variable `DOCKERHUB_USERNAME` and a repo secret `DOCKERHUB_TOKEN` (a Docker Hub access token with Read & Write). To have Komodo pull the image instead of building, switch `compose.yaml` from `build: .` to that image.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ACTUAL_SERVER_URL` | required | LAN URL, e.g. `https://192.168.1.10:5006` |
| `ACTUAL_PASSWORD` | required | Actual server password |
| `ACTUAL_SYNC_ID` | required | Settings > Show advanced settings > Sync ID |
| `ACTUAL_E2E_PASSWORD` | | only for end-to-end encrypted budgets |
| `NODE_EXTRA_CA_CERTS` | | path to Actual's CA cert if it's self-signed |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | | email ingest is skipped if unset |
| `ALERT_SENDERS` | Capital One, Chase, Amex, Discover, Citi, Venmo, PayPal | comma-separated |
| `LOOKBACK_DAYS` | `3` | how far back each run looks in Gmail |
| `ACCOUNT_MAP` | `{}` | `{"1234": "Checking"}` |
| `ANTHROPIC_API_KEY` | required | |
| `CLAUDE_MODEL` | `claude-opus-5-5` | `claude-haiku-4-5` costs less |
| `CLAUDE_EFFORT` | `low` | |
| `CATEGORIZE` | `true` | set `false` to only import |
| `CATEGORIZE_DAYS` | `30` | |
| `MIN_CONFIDENCE` | `0.8` | |
| `DRY_RUN` | `true` | |
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
