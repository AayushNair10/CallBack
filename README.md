# Callback

My personal job-application tracker.

- **Chrome extension**: on a job posting, click the icon. It reads the company, role, location and pay range from the page, I check the fields, and save. On **jobright.ai** it saves the job by itself when I click Apply. A dashboard shows every application.
- **Applications I never saved still show up**: a "thanks for applying" email (or an OA, interview or rejection) that matches no saved job creates the job automatically.
- **Cloudflare Worker + D1** stores jobs, recruiting emails and a status history.
- **Google Apps Script** reads Gmail every 5 minutes on Google's servers (Spam folder included) and posts new mail to the Worker. It has **read-only** Gmail access and keeps working when my laptop is off.
- The Worker **classifies emails with plain rules** (no LLMs, no AI APIs), links each one to a saved job, moves the job's status forward, and **pushes a notification to my phone** via [ntfy.sh](https://ntfy.sh) for online assessments, interviews and offers.

Plain JavaScript, no frameworks, no build step, free tiers only.

## Architecture

```
  ┌────────────────────────┐                        ┌──────────────────────────┐
  │ Chrome extension       │  GET/POST/PATCH/DELETE │ Cloudflare Worker        │
  │  popup: save a job     │ ─────────────────────▶ │  src/index.js   (API)    │
  │  dashboard: jobs,      │   Bearer API_TOKEN     │  src/classify.js (rules) │
  │  emails, CSV export    │ ◀───────────────────── │  src/match.js  (aliases) │
  └────────────────────────┘                        └──────┬──────────┬────────┘
                                                           │          │
  ┌────────────────────────┐   POST /api/ingest            │ SQL      │ POST JSON
  │ Google Apps Script     │   batches of 10 messages      ▼          ▼
  │  every 5 min, on       │ ─────────────────────▶ ┌───────────┐ ┌──────────┐
  │  Google's servers      │                        │ D1 SQLite │ │ ntfy.sh  │
  │  reads Inbox + Spam    │ ◀── results ────────── │ jobs      │ └────┬─────┘
  │  (gmail.readonly)      │                        │ emails    │      │ push
  │                        │                        │ events    │      ▼
  └──────────┬─────────────┘                        └───────────┘  ┌────────┐
             │ Gmail API                                           │ phone  │
             ▼                                                     └────────┘
         ┌────────┐
         │ Gmail  │
         └────────┘
```

## Repo layout

```
extension/    Manifest V3 extension (plain ES modules, load unpacked)
worker/       Cloudflare Worker, D1 schema, classifier tests
apps-script/  Code.gs + appsscript.json: paste into a Google Apps Script project
```

## Setup

You need Node 18+, a free Cloudflare account, a Google account, Chrome, and the ntfy app on your phone.

### 1. Deploy the Worker

```sh
cd worker
npm install
npx wrangler login

# Create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create callback

# Create the tables in the remote database
npx wrangler d1 execute callback --remote --file=schema.sql

# API token shared by the extension and the Apps Script
openssl rand -hex 24          # copy the output
npx wrangler secret put API_TOKEN

# ntfy topic: anyone who knows it can read your notifications, so make it unguessable
echo "callback-$(openssl rand -hex 12)"   # copy the output
npx wrangler secret put NTFY_TOPIC

npx wrangler deploy           # prints https://callback.<your-subdomain>.workers.dev
```

Check that it's up (should print `[]`):

```sh
curl -H "Authorization: Bearer <API_TOKEN>" https://callback.<your-subdomain>.workers.dev/api/jobs
```

### 2. Phone notifications

Install **ntfy** ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/app/ntfy/id1625396347)), tap **+**, and subscribe to the exact topic you stored in `NTFY_TOPIC` on the default server `ntfy.sh`.

### 3. Gmail sync (Apps Script)

1. Go to [script.google.com](https://script.google.com) → **New project**, name it "Callback".
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**. Back in the editor, open `appsscript.json` and replace it with [`apps-script/appsscript.json`](apps-script/appsscript.json). This enables the Gmail API service and pins the permissions to **read-only** Gmail access, external requests (to reach your Worker) and triggers.
4. **Project Settings** → **Script properties** → add:
   - `WORKER_URL` = `https://callback.<your-subdomain>.workers.dev`
   - `API_TOKEN` = the token from step 1
5. Back in the editor, pick `setup` in the function dropdown and click **Run**. The consent screen should ask only to **view** your email, connect to an external service, and run when you're not present. Google will warn that the app is unverified: Gmail access is a restricted scope and Google only verifies apps published to other people, so this always appears for a personal script. Use **Advanced → Go to Callback (unsafe)**.
   `setup()` installs an every-5-minutes trigger, starts syncing from one hour ago, and runs the first sync.
6. Optional: run `backfill()` to import the last 45 days. It doesn't send notifications and doesn't move the sync cursor. Applications from that period are created from their confirmation emails. A run stops after about 4½ minutes to stay under Apps Script's 6-minute limit; if the log says `backfill paused`, run it again and it continues where it stopped.

The **Executions** tab shows each run's log (`N new of M listed, sent N`, plus a line listing any real recruiting emails sitting in Spam).

The script stays within Gmail's rate limits: it asks the Worker which messages it already has and only downloads new ones, paces downloads, and waits and retries if Gmail still reports a quota error.

### 4. Chrome extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension/` folder.
2. Pin the Callback icon. Right-click it → **Options** to open the dashboard.
3. In **Settings**, enter the Worker URL and API token, then click **Save & test**.

Now open any job posting and click the icon. Check the fields and click **Save**. If the posting is already saved, the popup shows "Already saved (status …)" and the button changes to **Update**.

**jobright.ai**: nothing to click. When you press an **Apply** button on jobright (on a job page or in the recommendation feed), the extension reads that job and saves it as **applied**, with a green "✓ Saved to Callback" note in the corner. Chrome asks to allow the extension on jobright.ai the first time you reload it.

> The manifest grants access to `https://*.workers.dev/*`. If you put the Worker on a custom domain, add it to `host_permissions` in `extension/manifest.json`.

## How it works

### Job extraction

`extension/extract.js` runs in the page and tries, in order: schema.org `JobPosting` JSON-LD (used by Greenhouse, Lever, Ashby, Workday, and most career sites), LinkedIn's DOM, then `h1`/`og:title` and `og:site_name` or the ATS URL slug. If there's still no pay, it scans the page text for ranges like `$125K – $160K per year` or `$45.00 – $55.00/hr` and rejects implausible ones. URLs are canonicalized (tracking parameters dropped, LinkedIn `currentJobId` turned into `/jobs/view/<id>/`) so the same posting always maps to one row.

### Email filtering

Each email gets exactly one category. The first matching rule wins:

| # | Rule | Category |
|---|------|----------|
| 1 | Telegram/WhatsApp, "buy equipment", "deposit a check", "no interview required", wire transfers, gift cards, or an offer from a free-mail address | `scam` |
| 2 | Sender is a job board (LinkedIn, Indeed, …): rejection → `rejection`, "application was sent" in the subject → `application_received`, anything else | `job_alert` |
| 3 | Has a `List-Unsubscribe` header and no strong signal (rejection, receipt in subject, or an ATS/OA/scheduling platform with invite/interview wording) | `newsletter` |
| 4 | "not moving forward", "regret to inform", "position has been filled", … | `rejection` |
| 5 | "came across your profile", "exciting opportunity", … unless it mentions *your application* | `recruiter_outreach` |
| 6 | "offer letter", "extend you an offer", … | `offer` |
| 7 | OA platform invite, or "online assessment", "coding challenge", "take-home", … | `oa` |
| 8 | Scheduling platform (Calendly, GoodTime, …), or "phone screen", "virtual onsite", "share your availability", … | `interview` |
| 9 | "thank you for applying", "application received", … | `application_received` |
| 10 | Everything else | `other` |

For `oa` and `interview` emails, the first link to a known assessment or scheduling site is saved and shown as an **assessment ↗** / **schedule ↗** pill.

The dashboard hides `job_alert`, `newsletter` and `other` by default; tick **show alerts/newsletters/other** to see them. If a category is wrong, change it in the dropdown.

### How jobs get in

| Source | What happens |
|--------|--------------|
| Extension popup | You check the fields and click Save. |
| Apply on jobright.ai | Saved automatically as **applied** from jobright's job data (company, role, location, pay). |
| A confirmation, OA, interview or rejection email that matches nothing | A job is created from the email: company from the subject, sender or address, plus the role, location and posting link when the email includes them (LinkedIn "application sent" emails usually do). Pay isn't in these emails. Job alerts, newsletters, recruiter cold outreach, scams, free-mail senders and unknown senders in Spam never create jobs. OA/interview/offer emails only create one if they come from an assessment, ATS or scheduling platform or mention your application. |

The same job arriving from several sources becomes one row. Saving checks for a job at the same company with the same role, and updates it instead of adding a duplicate, unless both have different employer-site URLs (those are separate postings, such as two "SDE I" openings). A merged row keeps the employer-site URL over a LinkedIn/jobright one, and keeps its status.

Emails are matched by role as well as company. If a confirmation names a different role than the job it would match (you saved "Stripe – Data Scientist" from jobright, then applied to "Stripe – Backend Engineer" on Stripe's site), it goes to the job with that role, or becomes a new **applied** job. A later email that names the role fills it in on a job that didn't have one.

Auto-created jobs say "Added automatically from an email" in their notes. Their details come from parsing the email text, so check them in the dashboard; an odd email can occasionally produce a wrong company or role.

### Status tracking

Matched emails move the job forward only: `saved → applied → oa → interview → offer`. A rejection always applies. Every change, automatic or manual, is appended to the `events` table with the email that caused it.

### Aliases

Each job stores comma-separated aliases used to match emails. They're generated from the company name with legal suffixes removed (`Amazon.com Services LLC` → `amazon`) and from the ATS slug in the URL (`capitalone.wd12.myworkdayjobs.com` → `capitalone`). A match scores +10 if an alias appears as a word in the sender name, subject or body, +20 if the sender's domain contains it, then +1 per role word in the subject and +1 if the job isn't rejected. Ties go to the newest application.

If a company emails under another name (Meta vs. Facebook, a parent company, a staffing agency), edit the small aliases field under the company name in the dashboard. You can also link any email to a job by hand with the **Link to job…** dropdown, which advances the job's status too.

### Notifications

Only `oa`, `interview` and `offer` emails trigger a push, only if they're less than 24 hours old, and at most once per Gmail thread:

| Situation | Priority | Title |
|-----------|----------|-------|
| Matched to a saved job | 4 (offer: 5) | `Interview: Stripe – Backend Engineer` |
| Unmatched, sent from an OA/ATS/scheduling platform | 3 | `Unmatched · Online assessment: HackerRank` |
| Unmatched, from a company domain, not in Spam | 2 | `Check · Interview: Jane at Acme` |
| Free-mail sender, or an unknown sender found in Spam | none | |

Tapping the notification opens the thread in Gmail. If there's an assessment or scheduling link, the notification gets an **Open assessment** / **Open scheduler** button.

**Not getting notifications?** Ask the Worker to send a test and report what ntfy answered:

```sh
curl -X POST -H "Authorization: Bearer <API_TOKEN>" https://callback.<your-subdomain>.workers.dev/api/notify-test
```

- `"problem": "NTFY_TOPIC is not set"`: run `npx wrangler secret put NTFY_TOPIC`.
- `"ok": true` but nothing on the phone: the topic in the app doesn't match. Compare it with `topic_hint`, or set the secret again and resubscribe.
- `ntfy_status` 429 or similar: ntfy.sh is rate-limiting the shared Cloudflare network. Create a free ntfy.sh account, make an access token, and store it with `npx wrangler secret put NTFY_TOKEN`; the Worker then sends as you. `npx wrangler tail` shows ntfy's reply for every notification.

### Spam

Gmail sometimes files real OA invites in Spam, so the script reads the Spam folder too. Because it's read-only, it never moves anything: a spam message that's matched to a saved job, or that comes from a known OA/ATS/scheduling platform, is still classified, still moves the job's status, and still notifies you, with "(Found in your Spam folder)" in the notification. The dashboard marks it **was in spam**. The Worker returns a `rescue` flag for these, and the Apps Script logs them. Unknown senders found in Spam never notify.

## Privacy

- The Apps Script has **read-only** Gmail access (`gmail.readonly`): it can't send, delete, label or move mail.
- Email **bodies are never stored**. The Apps Script sends the first 6,000 characters for classification; the Worker keeps only metadata (sender, subject, date, category, matched job, OA/scheduling link, spam flag).
- Everything lives in your own Cloudflare account and Google account. No third-party services see your mail except ntfy.sh, which receives the subject line of OA/interview/offer emails. Use a long random topic, or [self-host ntfy](https://docs.ntfy.sh/install/) and set `NTFY_URL` in `wrangler.toml`.
- Every API request needs the bearer token. The dashboard renders email content with `textContent` only and only allows `http(s)` links.

## Development

```sh
cd worker
npm install
npm test                       # classifier and matcher tests (node:test)

# Local Worker with a local D1 database
npx wrangler d1 execute callback --local --file=schema.sql
printf 'API_TOKEN=devtoken\n' > .dev.vars     # git-ignored
npm run dev                    # http://localhost:8787
```

Try it with curl:

```sh
H='Authorization: Bearer devtoken'
curl -H "$H" -H 'Content-Type: application/json' localhost:8787/api/jobs \
  -d '{"company":"Stripe","role":"Backend Engineer","url":"https://boards.greenhouse.io/stripe/jobs/1"}'

curl -H "$H" -H 'Content-Type: application/json' localhost:8787/api/ingest -d '{
  "notify": false,
  "messages": [{"gmail_id":"m1","thread_id":"t1","from":"HackerRank <support@hackerrank.com>",
    "subject":"Stripe invited you to a test","body":"You have been invited... https://www.hackerrank.com/test/abc",
    "date":"2026-11-03T12:00:00Z","in_spam":true}]
}'
```

To test notifications locally, add `NTFY_TOPIC=…` to `.dev.vars` (and optionally `NTFY_URL=` pointing at a local server).

The extension has no build step: edit the files and click the reload icon on `chrome://extensions`.

### API

All routes need `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/jobs[?url=…]` | Newest-updated first |
| POST | `/api/jobs` | Upsert by `url`; never overwrites status, aliases or applied date |
| PATCH | `/api/jobs/:id` | Any of company, role, location, pay_*, currency, url, aliases, status, notes, applied_at |
| DELETE | `/api/jobs/:id` | Also deletes its history; linked emails are kept and unlinked |
| GET | `/api/emails?limit=100&all=1` | `all=1` includes alerts, newsletters and other |
| PATCH | `/api/emails/:id` | `{category?, job_id?}`; linking advances the job |
| POST | `/api/ingest` | Used by the Apps Script; creates jobs for unmatched application emails |
| POST | `/api/known` | `{ids}` → which Gmail ids are already stored (lets the Apps Script skip them) |
| POST | `/api/notify-test` | Sends a test push and returns ntfy's response |

### Free-tier budget

The Apps Script sends batches of 10 messages, so each ingest request stays well under D1's 50-queries-per-request limit (3 queries per batch, plus at most 3 per new email). A 5-minute trigger is 288 runs a day, which fits comfortably in Apps Script's daily trigger quota and the Workers free plan.

## Ideas for later

- **OA deadline reminders**: parse "complete within 7 days" and send a reminder before the deadline.
- **Funnel charts** from the `events` table: applied → OA → interview → offer conversion, time-to-response per company.
- **Recruiter finder**: for a saved job, suggest who at the company to reach out to.
- Follow-up nudges for applications with no response after N weeks.
- Weekly digest notification.
