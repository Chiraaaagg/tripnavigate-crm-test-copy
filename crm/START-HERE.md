# START HERE: TripNavigate CRM on this PC

Everything runs locally: **Bitrix24 → this CRM → your local Supabase**. No other service is involved.

## Start and stop (one command each)

Open PowerShell in the `crm` folder:

```powershell
npm run local:up     # Docker Desktop -> Supabase -> CRM dev server (own window) -> checks the sync cron
npm run local:down   # stops the CRM dev server and Supabase (your data is kept)
```

Then open **http://127.0.0.1:3000** (use `127.0.0.1`, not `localhost`).

| What | Where |
|---|---|
| CRM | http://127.0.0.1:3000 |
| Emails sent by the CRM (invitations, password resets) | Mailpit: http://127.0.0.1:54324 |
| Database browser | Supabase Studio: http://127.0.0.1:54323 |

First time on a new PC: install Node.js 22.12+, Docker Desktop and the Supabase CLI, then
`npm ci`, create `.env.local` from `.env.example` (local keys from `supabase status`, your
Bitrix webhook URL, a random 32+ character `INTAKE_WORKER_SECRET`), `supabase start`,
`supabase db reset` (never run `seed-local.mjs` on this database), and `npm run bitrix:setup` once.

`local:up` also checks the automatic sync: it re-creates the 30-second cron job if needed, makes sure the
scheduler's secret matches `.env.local`, stops a leftover test server holding port 3000, and waits until one
scheduled sync succeeded (it prints the last 5 calls). Do not run `npm run build` while the dev server runs.

## Signing in as the administrator

1. Go to http://127.0.0.1:3000/sign-in, enter your admin email and password.
2. The first time, the CRM shows **"Set up your authenticator app"**: click **Set up authenticator app**,
   scan the QR code with Google Authenticator or Microsoft Authenticator, type the 6-digit code.
3. Every later sign-in asks for the 6-digit code from the app.

## 2-minute admin guide

### Read the sync status
**Admin → Bitrix sync** (`/app/admin/integration`)
- **Connection** pill: "Receiving deals" means the automatic sync ran in the last 15 minutes without errors.
- **Auto sync** line: "✓ Auto sync running · last run X s ago", or "⚠ Auto sync stopped since HH:MM" with the
  reason in plain words (stopped = no successful run for 90 seconds). Fix shown there, or run `npm run local:up`.
- **Available deals**: deals in the CRM now (same number as the Deals page), next to **Bitrix** for the current
  settings with ✓ when they match.
- **Available deals / Bitrix / Waiting to sync / Need attention**: the four counters at the top.
- **Needs attention**: every problem in plain words, with a **Retry** button where it helps.
- **Deals waiting for an owner**: deals whose Bitrix responsible person is not linked to anyone in the CRM yet,
  grouped by Bitrix user. Only administrators see these deals.

### Change what is synced
Same page, **Sync settings**:
- tick the **pipelines** and, inside each, the **stages** a new deal may come from (won/lost stages are marked);
- **Sync date: take deals created on or after**: compared with the Bitrix **creation date** from 00:00 India time.
  Moving it **later** removes older deals from the CRM for everyone (they are kept for the audit trail, not deleted);
  moving it **earlier** adds the missing deals and brings removed ones back with their owner;
- unticking a **pipeline** removes its deals; unticking a **stage** removes the deals in that stage now
  (deals that later move to won/lost stay);
- **Automatic sync on**: untick to pause, tick to resume (about every 30 seconds);
- **Save sync settings**. A full sync with Bitrix starts. **Bitrix and CRM counts** shows its progress and then
  "Bitrix: N · CRM: N · ✓ in sync" (or the exact differences). It also runs once a day by itself.
- **Sync with Bitrix now** runs one sync immediately (at most once every 5 minutes).

### Add a staff member from Bitrix
**Admin → Staff** → **Add staff from Bitrix**
1. Type part of the name or email in the search box, pick the person.
2. Choose **Branch** and **Role** (Sales, Manager, …).
3. **Invite and link to Bitrix**. The person gets the normal invitation email (on this PC: in Mailpit),
   sets a password and an authenticator. From then on they see the Bitrix deals they are responsible for.

### Give an existing staff member their Bitrix deals (grant)
**Admin → Staff** → in their row, column **Bitrix user (deal access)** → **Link Bitrix user** →
search, pick their Bitrix user → **Link and give access**. Their deals move to them at once; new
deals of that Bitrix user are assigned automatically. One Bitrix user can belong to one staff member only.

### Take access away (revoke)
- **Unlink** (same column): their deals go back to "waiting for owner" and they stop seeing them at once.
  Link again to give them back.
- **Actions → Deactivate staff member**: permanent offboarding. All their access ends at once and
  their deals go back to "waiting for owner". Deals are never deleted.

### Who sees what (enforced by the database, not just the screen)
| Person | Sees |
|---|---|
| Salesperson | only deals they own (their linked Bitrix user is the responsible) |
| Manager | own deals plus the branches/entities given in **Admin → Access grants** |
| Administrator | every deal of every branch and owner, including deals waiting for an owner |
| Purchase | assigned deals, never selling price or margin |
| Deactivated / not yet signed up | nothing |
| Everyone (administrators too) | never the deals removed by the sync date, pipeline or stage settings |

### Order of the Deals list
Deals are listed by **Bitrix deal ID, newest first**. A sync never moves a deal; only a new Bitrix deal
appears at the top. Use **Deal ID ↑** above the list for oldest first (the choice stays while paging).

### Pages update by themselves
On **Deals**, the small indicator says **Live** (changes appear within a few seconds of the sync) or
**Updating every 30 s** (fallback). No need to press refresh.

## If something is wrong
| You see | Do this |
|---|---|
| "Worker has never run" / "not running recently" | Is `npm run dev` running (its window open)? Is **Automatic sync on** ticked? Run `npm run local:up`. |
| "Bitrix refused the webhook" | The webhook in `.env.local` was deleted or lacks CRM/Users permission. Create a new one, paste it into `BITRIX_WEBHOOK_BASE_URL`, restart the dev server. |
| A person is missing from "Add staff from Bitrix" | They are not a user in Bitrix, or the webhook lacks the Users permission. |
| Invitation not arriving | On this PC every email lands in Mailpit (http://127.0.0.1:54324), never in a real inbox. |
