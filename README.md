# 🪙 Token Ledger

A local-first dashboard for your **Claude** token usage — tokens, cost,
per-project breakdown, and efficiency recommendations that tell you *what to
actually do* to spend less without hurting quality.

Two data sources, same dashboard:

- **Claude Code** — reads the session transcripts already on your machine
  (`~/.claude/projects`). **No key, no account setup, no config.** Shows the
  list-price value of what your subscription actually consumes.
- **Claude API (org accounts)** — pulls org-wide usage and billed cost from the
  [Anthropic Usage & Cost Admin API](https://platform.claude.com/docs/en/api/usage-cost-api),
  reconciled against your real invoice.

Neither one? It ships with a realistic sample so you can see everything first.

![token ledger](docs/preview.png)

**[Live demo →](https://todd-father.github.io/token-ledger/)** — the full
dashboard running on the synthetic sample. *(Activates once GitHub Pages is
enabled for the repo: Settings → Pages → Source: GitHub Actions.)*

---

## Your data stays yours

This is the important part, so it's first:

- The **tool** is public — clone it, read it, fork it.
- Your **usage numbers are not.** Fetched data lands in `data.json`
  (gitignored), your key stays in `.env` (gitignored), and the Claude Code
  scanner only ever *reads* your local transcripts. Nothing about your
  account, spend, projects, or sessions leaves your computer.

---

## Quick start

```bash
npx token-ledger
# → scans your Claude Code sessions (or uses the sample), serves the
#   dashboard at http://localhost:4319, and opens it
```

Until the package lands on the npm registry, run it straight from GitHub:

```bash
npx -y github:Todd-Father/token-ledger
```

*(npm 12+ blocks git packages by default — prefix with `npm_config_allow_git=true` there.)*

Or from a clone:

```bash
git clone <your-fork-url> token-ledger
cd token-ledger
npm start
```

Source selection is automatic: an Admin key in `.env` → org API data; no key
but Claude Code on this machine → your local sessions; neither → the bundled
sample (badge reads **Demo data**). Force a source with `--claude-code` or
`--fixture`, or `npm run fetch:code`.

> Installed via `npx`? Your data lives in `~/.token-ledger` (override with
> `LEDGER_HOME`), so it survives npm cache cleanups. Put your `.env` there.

---

## Going live with the Admin API (org accounts)

The dashboard reads a `data.json` produced by `scripts/fetch-usage.mjs`. To fill
it with *your* numbers:

### 1. You need an Admin key — which needs an organization

The Usage & Cost API requires an **Admin key** (`sk-ant-admin01-…`), which is
different from a normal API key and is **only available to organization
accounts.**

If you're on an individual account, create an org first — it's free and doesn't
change your billing:

> **Claude Console → Settings → Organization**

Then create the Admin key:

> **Console → Settings → Admin keys**

*(Claude Enterprise / claude.ai orgs use a separate Analytics API key instead —
see the [docs](https://platform.claude.com/docs/en/api/usage-cost-api#which-api-do-you-need).)*

### 2. Add the key

```bash
cp .env.example .env
# edit .env and paste your key into ANTHROPIC_ADMIN_KEY=
```

### 3. Fetch and view

```bash
npm run fetch     # pulls up to 90 days of your usage + cost
npm run serve     # → http://localhost:4319
```

The badge flips to **Live data** with the fetch timestamp. Re-run `npm run fetch`
whenever you want fresh numbers (data is available within ~5 min of an API call).

---

## What's in the dashboard

**Overall**
- **Usage value (list price)** — the authoritative figure from the Cost API: the
  list-price value of tokens consumed. The dashboard trusts this over a hardcoded
  price table (which can be wildly off if you use models/rates it doesn't know).

  > **Credit vs. invoice:** the Cost API reports usage *value* at published rates,
  > not necessarily what you were charged. On a **prepaid-credit** account this value
  > is drawn down from your credit balance; on committed-use/discounted plans your
  > invoice may be lower. The API has no endpoint for your credit balance — enter it
  > in the **Credit balance** field to get a **runway estimate** (days left at your
  > current burn rate).
- Total tokens (in/out), cache hit rate, cache savings, prod-vs-dev split
- A daily stacked trend chart — regroup by **token type**, **model**, **project**,
  or **environment**; flip between **tokens** and **cost**
- **Monthly budget** — set a target and the dashboard projects your run-rate against
  it (a "Budget pace" tile that goes amber/red) and draws a daily-budget line on the
  cost chart

**Efficiency levers** — the numbers that move cost without touching output quality:
- **Cache hit rate** (share of input served from cache at ~10% of the price)
- **Cache ROI** ($ saved per $ spent writing to cache)
- **Input mix** (fresh vs cached — fresh is billed at full rate)
- **Output ÷ input ratio** (flags context-heavy work that's prime for caching)
- **Blended cost per million tokens**

**Project level** — one row per Anthropic workspace, sortable, with inline cache-hit
bars so the worst offenders read at a glance.

**Take action** — a recommendation engine that reads *your* current numbers and only
surfaces the levers that apply, ranked by estimated dollar impact. Covers API cost
levers (caching, batch tier, model right-sizing), response-quality levers, Claude Code
skills/workflow, and governance (spend alerts, per-workspace chargeback).

The dollar figures are **estimates, not measurements** — each quantified card states
the assumption it leans on (e.g. "assumes 55% of fresh input can become cache reads"),
and an **Assumptions** panel in that section lets you tune every constant to match
your own workloads. Figures recompute instantly; your settings persist locally.

### Knobs

- **Window:** 30 / 60 / 90 days
- **Service tier:** all / standard / batch / priority
- **Group trend by:** token type / model / project
- **Value:** tokens or cost
- **Prompt caching on/off** — models the counterfactual: what you'd pay with no caching

---

## How it works

```
scripts/fetch-usage.mjs      ── source selection + Admin API fetch (chunked
                                ≤31d/request); normalizes to millions of
                                tokens per day × project × token-type ↓
scripts/lib/claude-code.mjs  ── the Claude Code adapter: scans
                                ~/.claude/projects transcripts, dedups
                                per-message usage, folds to the same shape
scripts/lib/pricing.mjs      ── the one per-model price table (embedded
                                into data.json on every fetch)
data.json                    ── your data (gitignored)
index.html                   ── fetches ./data.json on load; falls back to
                                the built-in sample if absent
scripts/serve.mjs            ── tiny static server (browsers block file:// fetch)
sample.data.json             ── committed demo fixture (safe, synthetic)
```

**Claude Code specifics:** usage is read per assistant message (deduped — the
transcript format writes each message several times), 1-hour cache writes are
priced at their real 2×-input rate, and since subscription plans have no
per-token invoice, every dollar figure is the **list-price value** of the
tokens consumed (the same framing ccusage uses). Recommendations that only
exist for API billing (Batch tier, workspace chargeback) are suppressed.

Token-type fields from the API — `uncached_input_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, `output_tokens` — map 1:1 onto the chart stacks and
every efficiency meter. The dashboard recomputes cost from tokens (using the prices in
`fetch-usage.mjs`) so the caching/tier toggles can show live counterfactuals; the
authoritative Cost API figure is also stored per project-day for reconciliation.

> **Pricing note:** per-model prices live in one place — `scripts/lib/pricing.mjs`,
> with per-version entries (Opus 4.1 is priced 3× Opus 4.8, old Haiku differs from
> new, etc.). Every fetch embeds the table into `data.json`, so the dashboard prices
> live data from the same numbers, and a reconcile canary warns on every fetch if
> they drift from your real bill. `index.html` keeps a small inline fallback for the
> offline demo — CI fails if it drifts from `pricing.mjs`.

---

## Keeping it current (optional)

Want `data.json` to refresh unattended? Add a cron / launchd entry that runs the
fetch on a cadence — once daily is plenty:

```bash
# crontab -e   — refresh every morning at 6am
0 6 * * * cd /path/to/token-ledger && /usr/bin/node scripts/fetch-usage.mjs >> fetch.log 2>&1
```

---

## Security notes

- The Admin key is read only from `.env`, never hardcoded, never logged.
- `.env`, `data.json`, and snapshots are gitignored by default — check `.gitignore`
  before committing if you add new data files.
- The dashboard is a single static HTML file with **no external requests** (no CDNs,
  fonts, or trackers) — everything is inline. It works fully offline once served.
- Treat the Admin key like a password: it can read your whole org's usage and cost.
  Scope it to read-only if your org supports scoped Admin keys.

---

## Tests

```bash
npm test          # node's built-in test runner — no dependencies
```

Covers the money math end to end: price normalization (dated model ids → versioned
rates), the API-bucket fold (tokens→millions, cents→dollars, dev/prod and tier
splits), the price-drift canary, spend-anomaly detection, the recommendation engine
(triggering, assumption scaling, billed-dollar reconciliation), and a parity check
that fails if the dashboard's inline price fallback drifts from `scripts/lib/pricing.mjs`.
CI runs the suite plus a no-key fixture smoke test on every push.

---

## License

MIT — see [LICENSE](LICENSE).
