# Token Ledger — Handoff / Status

**Purpose of this doc:** hand this work off to a fresh Claude session (e.g. on claude.ai)
to resolve the one remaining blocker — creating an **Admin API key** in the Claude
Console. Everything else is built, tested, and shipped.

**Repo:** https://github.com/Todd-Father/token-ledger (public)
**Local path:** `~/Projects/token-ledger`
**Date of handoff:** 2026-07-31

---

## What this project is

**Token Ledger** is a self-hosted dashboard for **Claude API usage and cost**. It shows:

- Overall token & cost trends (daily, stacked by token type / model / project)
- **Per-project (Anthropic workspace) breakdown** — the "project level" view
- **Efficiency levers**: cache hit rate, cache ROI, input mix, output÷input ratio,
  blended $/Mtok
- A **"Take action" recommendation engine** that reads the current numbers and
  suggests cost/quality/workflow/governance improvements ranked by estimated $ impact
- Knobs: 30/60/90-day window, service tier, group-by, tokens vs cost, and a
  prompt-caching counterfactual toggle

It runs against the **Anthropic Usage & Cost Admin API**
(`/v1/organizations/usage_report/messages` and `/v1/organizations/cost_report`).

### How it's wired

```
scripts/fetch-usage.mjs  → calls the Admin API, writes gitignored data.json
data.json                → your real usage (never committed)
index.html               → reads ./data.json on load; falls back to sample if absent
scripts/serve.mjs        → tiny static server (browsers block file:// fetch)
sample.data.json         → committed synthetic demo (generic project names)
```

`npm start` = fetch + serve, then open http://localhost:4319.
With no key, it shows demo data (badge: "Demo data"). With a valid Admin key in
`.env`, it fetches real data (badge flips to green "Live data").

---

## What's DONE ✅

- [x] Full dashboard built (`index.html`) — trends, per-project table, efficiency
      panel, recommendation engine, all knobs including 30/60/90-day windows
- [x] Live fetch script (`scripts/fetch-usage.mjs`) — pulls both endpoints,
      chunks the API's 31-day-per-request limit for 60/90-day windows, normalizes
      to the dashboard's data shape
- [x] Key-optional design — falls back to bundled sample fixture when no key is set
- [x] Static server (`scripts/serve.mjs`) and `npm start` / `npm run fetch` scripts
- [x] README, LICENSE (MIT), `.env.example`, `.gitignore`
- [x] **Privacy verified**: `.env` and `data.json` are gitignored and PROVEN
      un-committable (planted fake key + data, git refused to stage them). Usage
      never leaves the machine.
- [x] Demo screenshot + fixture use **generic project names** (web-app,
      agent-service, batch-pipeline, content-tool) — nothing identifies the real setup
- [x] Pushed to a **public** GitHub repo with topics
      (claude, anthropic, finops, dashboard, etc.)
- [x] `.env` file already created locally at `~/Projects/token-ledger/.env` with a
      blank `ANTHROPIC_ADMIN_KEY=` line, ready for the key to be pasted in
- [x] End-to-end verified via headless browser: fetch → data.json → render, no JS errors

---

## What's LEFT TO DO ⏳

### 1. Create an Admin API key  ← **THIS IS THE BLOCKER (see below)**
Needed to authenticate the fetch. Must start with `sk-ant-admin01-…`.
(A standard `sk-ant-api03-…` key does **not** work — the Usage & Cost API rejects it.)

### 2. Paste the key into `.env`
```bash
cd ~/Projects/token-ledger
open -e .env
# set the line to:  ANTHROPIC_ADMIN_KEY=sk-ant-admin01-your-key-here
# save
```
Verify (without printing the key):
```bash
grep -c '^ANTHROPIC_ADMIN_KEY=sk-ant-admin01-' .env   # should print 1
```

### 3. Fetch and view
```bash
npm start
# open http://localhost:4319 → badge should turn green "Live data"
```

### 4. (Optional) Schedule a daily refresh
A cron/launchd entry running `node scripts/fetch-usage.mjs` — see README.

---

## ⚠️ WHERE I'M STUCK — the Admin key

**I cannot find where to create the Admin key in the Claude Console.** Here is
everything established so far, so a fresh session doesn't re-tread it:

### What's confirmed true
- I am on **platform.claude.com** (the developer Console), logged in, with the
  **Admin** role (the page shows me as ADMIN under `/settings`). I am also the
  **owner** of the account.
- My org **IS eligible** for the Admin API. Proven by unauthenticated probes:
  `/v1/organizations/usage_report/messages`, `/organizations/api_keys`,
  `/organizations/workspaces`, and `/organizations/users` all return **HTTP 401
  ("x-api-key header is required")** — i.e. the endpoints exist and accept a key,
  they're not 404/unavailable. **The block is purely the Console UI, not eligibility.**
- The docs say Admin keys are created at
  **Claude Console → Settings → Admin keys**
  (`https://platform.claude.com/settings/admin-keys`) by a member with the
  **admin** role. That page's title resolves ("Admin Keys | Claude Platform"),
  so the route exists.

### The problem
- When I open `platform.claude.com/settings/admin-keys` **directly**, I get
  **"page not found."** (Likely because it's an authenticated SPA route and/or I'm
  in the wrong scope — see below.)
- My **Settings sidebar shows workspace-level items only**: "API keys" (at `/keys`,
  which explicitly says *API keys are owned by workspaces*), "Service accounts"
  (I have none), and "Workload identity" (none). **There is no "Admin keys" entry.**
- I have a **workspace named `token-ledger`**.

### The most likely cause (working theory)
The Console is **scoped into my `token-ledger` workspace**, but **Admin keys are an
org-root setting** (they're org-wide by design — one key reads all workspaces). So
the Admin-keys page never appears in a workspace-scoped sidebar. **The fix is to
switch the Console from workspace scope to organization scope** (usually a
selector/dropdown at the top-left of the Console showing the workspace/org name),
then reopen Settings — "Admin keys" should then appear.

### What I still need help with
1. **Finding the workspace → organization scope switcher** in the current Console UI
   (top-left selector, or wherever it now lives), and confirming what it's labeled.
2. If switching to org scope still shows **no "Admin keys"** section: figure out why
   an org-Admin/Owner whose API is provably eligible can't see the create-key page —
   is there a billing/setup precondition, a different menu location, or a UI bug?
3. **Confirming I do NOT need to "convert to a Team organization"** to get this.
   (Current understanding: I do NOT — the API probes prove eligibility, and
   "convert to Team" is a claude.ai chat-plan change that wouldn't add the
   Admin-keys page anyway. But please double-check against current docs/UI.)

### Do NOT do
- Do **not** create or use a standard `sk-ant-api03-…` key — wrong type, gets rejected.
- Do **not** paste any key into a chat window. Put it only in the local `.env` file.
- (A standard key was accidentally pasted into an earlier chat and should be
  **revoked** in Console → API keys if not already done.)

---

## Quick reference

| Item | Value |
| --- | --- |
| Repo | https://github.com/Todd-Father/token-ledger |
| Local | `~/Projects/token-ledger` |
| Admin key page (needs org scope) | https://platform.claude.com/settings/admin-keys |
| Required key prefix | `sk-ant-admin01-` |
| Env var | `ANTHROPIC_ADMIN_KEY` in `.env` (already created, blank) |
| Run it | `npm start` → http://localhost:4319 |
| API docs | https://platform.claude.com/docs/en/api/usage-cost-api |
| Create-key docs | https://platform.claude.com/docs/en/manage-claude/admin-api-keys |
