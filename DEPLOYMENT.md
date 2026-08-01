# Running Token Ledger

Token Ledger is designed to run **locally**. Your usage data is private, and
running on `localhost` guarantees it never leaves your machine — the fetched
`data.json` is gitignored and stays on disk.

This document covers how to run it locally. Hosting it on a public server is
intentionally out of scope: your real usage data should not be exposed to a
network, and the tool needs nothing more than a local process to work.

---

## Run it

```bash
cd /path/to/token-ledger
npm run fetch     # pull latest usage → data.json (gitignored, stays local)
npm run serve     # → http://localhost:4319
```

Then open **http://localhost:4319** in your browser. Press `Ctrl-C` in the
terminal to stop the server.

With no API key configured, `npm run fetch` writes the bundled sample fixture
instead, so the dashboard still works end-to-end with demo data. See the
[README](README.md) for how to add an Admin key for real data.

---

## Make it one command (optional)

Add an alias to your shell profile (e.g. `~/.zshrc` or `~/.bashrc`):

```bash
# Token Ledger — fetch latest usage + serve the dashboard
alias ledger='(cd /path/to/token-ledger && node scripts/fetch-usage.mjs && node scripts/serve.mjs)'
```

Reload your shell (`source ~/.zshrc`) or open a new terminal, then type `ledger`
to fetch fresh data and start the server. If a server is already running on the
port, `serve.mjs` detects it and points you at the existing URL instead of
erroring.

---

## Keep data current automatically (optional)

If you'd rather `data.json` refresh on a schedule without running the fetch by
hand, add a cron entry. This refreshes the data file only — you still open the
page in a browser when you want to look.

```bash
# crontab -e  — refresh every morning at 6am
0 6 * * * cd /path/to/token-ledger && /usr/bin/node scripts/fetch-usage.mjs >> fetch.log 2>&1
```

On macOS you can use `launchd` instead if you prefer. Either way, this gives you
always-current data without any hosting.

---

## Change the port (optional)

The server listens on `4319` by default. Override it with the `PORT` environment
variable:

```bash
PORT=8080 npm run serve   # → http://localhost:8080
```

---

## Privacy notes

- `data.json` (your fetched usage) and `.env` (your Admin key) are **gitignored**
  by default — they are never committed.
- Do not commit or publish `data.json`. It contains your usage, cost, and
  workspace names. If you add new data files, add them to `.gitignore` too.
- The dashboard is a single static HTML file with no external requests — no CDNs,
  fonts, or trackers. It works fully offline once served.
