#!/usr/bin/env node
/**
 * fetch-usage.mjs — pull your Claude usage & cost from the Admin API and
 * write a data.json the dashboard reads.
 *
 * Usage:
 *   node scripts/fetch-usage.mjs            # uses ANTHROPIC_ADMIN_KEY from .env
 *   node scripts/fetch-usage.mjs --days 14  # override the window
 *   node scripts/fetch-usage.mjs --fixture  # force the bundled sample (no key needed)
 *
 * With no key set, it falls back to the sample fixture so the dashboard still
 * works end-to-end. Your real data.json is gitignored and never leaves your machine.
 *
 * Docs: https://platform.claude.com/docs/en/api/usage-cost-api
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/* ---------- tiny .env loader (no dependency) ---------- */
async function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  const txt = await readFile(p, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let [, k, v] = m;
    v = v.replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

/* ---------- args ---------- */
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

/* ---------- pricing (per Mtok, USD) — keep in sync with the dashboard ----------
 * Source: https://platform.claude.com/docs (Pricing). Last verified: 2026-07-31.
 * NOTE: Sonnet 5 pricing RISES on 2026-09-01 ($2→$3 in, $10→$15 out, etc.).
 * priceFor(model, dateStr) handles that switch per-day automatically.
 * The reconcile check in main() warns if these numbers drift from real billing.
 */
const PRICE = {
  "claude-opus-4-8":  { in: 5,  read: 0.50, write: 6.25,  out: 25 },
  "claude-sonnet-5":  { in: 3,  read: 0.30, write: 3.75,  out: 15 }, // billing-verified 2026-07-31
  "claude-haiku-4-5": { in: 1,  read: 0.10, write: 1.25,  out: 5  },
  "claude-fable-5":   { in: 10, read: 1.00, write: 12.50, out: 50 },
};
const PRICE_SONNET5_FROM_SEPT2026 = { in: 3, read: 0.30, write: 3.75, out: 15 };
const SONNET5_PRICE_CHANGE = "2026-09-01";
// Date-aware lookup. dateStr is "YYYY-MM-DD" (a day bucket); omit for "today".
function priceFor(model, dateStr) {
  const norm = normalizeModel(model);
  if (norm === "claude-sonnet-5") {
    const d = dateStr || new Date().toISOString().slice(0, 10);
    if (d >= SONNET5_PRICE_CHANGE) return PRICE_SONNET5_FROM_SEPT2026;
  }
  return PRICE[norm] || PRICE["claude-sonnet-5"];
}
const _warnedModels = new Set();
function normalizeModel(m) {
  if (!m) return "claude-sonnet-5";
  const s = m.toLowerCase();
  if (s.includes("fable")) return "claude-fable-5";
  if (s.includes("opus")) return "claude-opus-4-8";
  if (s.includes("haiku")) return "claude-haiku-4-5";
  if (s.includes("sonnet")) return "claude-sonnet-5";
  if (!_warnedModels.has(m)) {
    _warnedModels.add(m);
    console.warn(`⚠ Unknown model "${m}" — no price on file; using Sonnet pricing as a guess.`);
    console.warn(`  Add it to PRICE in scripts/fetch-usage.mjs AND index.html for accurate costs.`);
  }
  return m;
}

/* ---------- palette assignment for projects (stable by name) ---------- */
const PALETTE = ["#c1852c", "#2f8f6e", "#2f6f8f", "#9a5bc4", "#c9524f", "#4a9d7f", "#d98b4a", "#7c6ff0"];
function colorFor(idx, isDefault) {
  return isDefault ? "#82869a" : PALETTE[idx % PALETTE.length];
}

const API = "https://api.anthropic.com/v1/organizations";
const HEADERS = () => ({
  "anthropic-version": "2023-06-01",
  "x-api-key": process.env.ANTHROPIC_ADMIN_KEY,
  "User-Agent": "token-ledger/1.0.0 (https://github.com/)",
});

/* ---------- DEV vs PROD classification ----------
 * The Usage & Cost API has no "environment" dimension, so we infer it from the
 * API key's NAME. Keys whose name matches the DEV pattern are development;
 * everything else is production. ENV_OVERRIDES lets you correct known exceptions
 * by exact key name (e.g. a key used for local agent/Claude Code work that isn't
 * named "dev"). Edit ENV_OVERRIDES to match your own keys.
 */
const DEV_PATTERN = /dev|local|test|preview|staging|sandbox|scratch/i;
const ENV_OVERRIDES = {
  // exact key name -> "dev" | "prod"
  // Example: "my-claude-code-key": "dev", // Claude Code / local agent work, not a prod app
};
function classifyEnv(keyName) {
  if (!keyName) return "prod"; // Workbench / unattributed -> treat as prod by default
  if (keyName in ENV_OVERRIDES) return ENV_OVERRIDES[keyName];
  return DEV_PATTERN.test(keyName) ? "dev" : "prod";
}

/* ---------- paginated GET ---------- */
async function getAll(path, params) {
  const results = [];
  let page = null;
  for (let guard = 0; guard < 60; guard++) {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, x));
      else url.searchParams.set(k, v);
    }
    if (page) url.searchParams.set("page", page);

    // Retry 429 (rate limit) and transient 5xx with backoff: 2s, 4s, 8s.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, { headers: HEADERS() });
      if (res.ok) break;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = 2000 * 2 ** attempt;
        console.warn(`  (API ${res.status} on ${path} — retrying in ${wait / 1000}s…)`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    results.push(...(json.data || []));
    if (json.has_more && json.next_page) page = json.next_page;
    else break;
  }
  return results;
}

/* ---------- window helpers ---------- */
function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
function dayKeyFromBucket(startISO) {
  return startISO.slice(0, 10); // YYYY-MM-DD
}

/* ============================================================
   LIVE FETCH -> normalized {days, DAYS} matching the dashboard.
   Token counts are converted to MILLIONS (dashboard's unit).
   ============================================================ */
// The daily-bucket usage endpoint caps at 31 buckets/request, so windows >31d
// are fetched as consecutive ≤31-day chunks and concatenated.
async function getChunked(path, days, extraParams) {
  const CHUNK = 31;
  const all = [];
  for (let offset = days; offset > 0; offset -= CHUNK) {
    const spanStart = offset;
    const spanEnd = Math.max(0, offset - CHUNK);
    const rows = await getAll(path, {
      starting_at: isoDaysAgo(spanStart),
      ending_at: isoDaysAgo(spanEnd),
      ...extraParams,
    });
    all.push(...rows);
  }
  return all;
}

// Map workspace IDs to their friendly names via the List Workspaces endpoint.
// Returns Map(id -> name). Non-fatal: if it fails, we fall back to short IDs.
async function fetchWorkspaceNames() {
  const map = new Map();
  try {
    const rows = await getAll("workspaces", { limit: 100 });
    for (const w of rows) if (w && w.id) map.set(w.id, w.name || w.id);
  } catch (e) {
    console.warn(`  (couldn't fetch workspace names: ${e.message} — falling back to IDs)`);
  }
  return map;
}

// Map API key IDs to their names (for DEV/PROD classification). Non-fatal.
async function fetchKeyNames() {
  const map = new Map();
  try {
    const rows = await getAll("api_keys", { limit: 100 });
    for (const k of rows) if (k && k.id) map.set(k.id, k.name || k.id);
  } catch (e) {
    console.warn(`  (couldn't fetch key names for dev/prod split: ${e.message})`);
  }
  return map;
}

async function fetchLive(days) {
  // Friendly names first, so the project table reads cleanly, plus key names
  // for the DEV/PROD split.
  const wsNameMap = await fetchWorkspaceNames();
  const keyNameMap = await fetchKeyNames();

  // Usage: one row per (time bucket × model × workspace × service_tier × api_key)
  // api_key_id is included so we can classify each slice as dev vs prod by key name.
  const usage = await getChunked("usage_report/messages", days, {
    bucket_width: "1d",
    group_by: ["model", "workspace_id", "service_tier", "api_key_id"],
  });

  // Cost: authoritative USD, per (bucket × workspace × description). Daily only.
  const cost = await getChunked("cost_report", days, {
    group_by: ["workspace_id", "description"],
  });

  // ---- index cost by day+workspace, and by day, for reconciliation ----
  // The Cost API `amount` is USD in CENTS (a decimal string, e.g. "452.79" = $4.53).
  // Verified empirically: 1.3M tokens over 7 days priced ~$4.53 by hand vs the API's
  // "452.79" — exactly 100×. So divide by 100 to get dollars.
  const CENTS = 100;
  const costIdx = new Map();     // `${day}|${ws}` -> usd  (authoritative, per project-day)
  const costByDay = new Map();   // day -> usd             (authoritative daily total)
  for (const bucket of cost) {
    const day = dayKeyFromBucket(bucket.starting_at || bucket.start_time || "");
    for (const item of bucket.results || []) {
      const ws = item.workspace_id ?? "__default__";
      const usd = (Number(item.amount ?? item.cost ?? 0)) / CENTS; // cents -> dollars
      costIdx.set(`${day}|${ws}`, (costIdx.get(`${day}|${ws}`) || 0) + usd);
      costByDay.set(day, (costByDay.get(day) || 0) + usd);
    }
  }

  // ---- fold usage into day -> workspace -> tokens/tiers ----
  const dayMap = new Map(); // day -> Map(ws -> agg)
  const wsNames = new Map(); // ws -> {name, model(top)}

  for (const bucket of usage) {
    const day = dayKeyFromBucket(bucket.starting_at || bucket.start_time || "");
    if (!dayMap.has(day)) dayMap.set(day, new Map());
    const wsBucket = dayMap.get(day);

    for (const item of bucket.results || []) {
      const ws = item.workspace_id ?? "__default__";
      const model = normalizeModel(item.model);
      const tier = (item.service_tier || "standard").toLowerCase();
      const env = classifyEnv(keyNameMap.get(item.api_key_id)); // "dev" | "prod"

      // token fields (absolute counts) -> millions
      const fresh = num(item.uncached_input_tokens) / 1e6;
      const cacheRead = num(item.cache_read_input_tokens) / 1e6;
      const cacheCreate = num(item.cache_creation_input_tokens) / 1e6;
      const output = num(item.output_tokens) / 1e6;

      if (!wsBucket.has(ws)) {
        wsBucket.set(ws, {
          id: ws === "__default__" ? null : ws,
          model, // dominant model set below
          tok: { fresh: 0, cacheRead: 0, cacheCreate: 0, output: 0 },
          tierTok: { standard: 0, batch: 0, priority: 0 },
          envTok: { dev: 0, prod: 0 }, // total tokens split by inferred environment
          modelTok: {},
        });
      }
      const agg = wsBucket.get(ws);
      agg.tok.fresh += fresh;
      agg.tok.cacheRead += cacheRead;
      agg.tok.cacheCreate += cacheCreate;
      agg.tok.output += output;
      const totTok = fresh + cacheRead + cacheCreate + output;
      const tierName = tier === "batch" ? "batch" : tier === "priority" ? "priority" : "standard";
      agg.tierTok[tierName] += totTok;
      agg.envTok[env] += totTok;
      agg.modelTok[model] = (agg.modelTok[model] || 0) + totTok;

      // remember a human name for the workspace: real name from the API,
      // else a shortened id.
      if (!wsNames.has(ws))
        wsNames.set(ws, ws === "__default__" ? "default (console)" : (wsNameMap.get(ws) || shortWs(ws)));
    }
  }

  // ---- assign stable colors per workspace ----
  const wsList = [...wsNames.keys()].filter((w) => w !== "__default__").sort();
  const colorMap = new Map();
  wsList.forEach((w, i) => colorMap.set(w, colorFor(i, false)));
  colorMap.set("__default__", "#82869a");

  // ---- build the ordered days array ----
  const sortedDays = [...dayMap.keys()].sort();
  const outDays = sortedDays.map((day, dayIndex) => {
    const wsBucket = dayMap.get(day);
    const projs = [...wsBucket.entries()].map(([ws, agg]) => {
      // dominant model
      const model =
        Object.entries(agg.modelTok).sort((a, b) => b[1] - a[1])[0]?.[0] || agg.model;
      const tierTotal =
        agg.tierTok.standard + agg.tierTok.batch + agg.tierTok.priority || 1;
      const tiers = {
        standard: agg.tierTok.standard / tierTotal,
        batch: agg.tierTok.batch / tierTotal,
        priority: agg.tierTok.priority / tierTotal,
      };
      const envTotal = agg.envTok.dev + agg.envTok.prod || 1;
      const env = { dev: agg.envTok.dev / envTotal, prod: agg.envTok.prod / envTotal };
      return {
        id: agg.id,
        name: wsNames.get(ws),
        color: colorMap.get(ws),
        model,
        tok: agg.tok,
        tiers,
        env, // fraction of this project-day's tokens that were dev vs prod

        // authoritative cost from the Cost API (dollars) for this project-day, if present.
        // The dashboard recomputes cost from tokens for its counterfactuals, but we stash
        // the real number so a future view can reconcile against billing.
        actualCost: costIdx.get(`${day}|${ws === "__default__" ? "__default__" : agg.id}`) ?? null,
      };
    });
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    // actualCostDay = authoritative billed USD for this day (all workspaces),
    // straight from the Cost API — the number the dashboard reconciles against.
    return { dayIndex, weekday: dow >= 1 && dow <= 5, date: day, projs,
             actualCostDay: costByDay.get(day) ?? null };
  });

  return { days: outDays, DAYS: outDays.length, source: "live", generatedAt: new Date().toISOString() };
}

/* ============================================================
   PRICE-ACCURACY CHECK ("canary")
   Recomputes each day's cost from tokens at the PRICE-map rates and compares
   the total against the Cost API's authoritative billed total (actualCostDay).
   If they diverge beyond tolerance, the PRICE map is stale — warn loudly.
   This is what keeps the dashboard honest when Anthropic changes prices.
   ============================================================ */
function checkPriceAccuracy(data, tolerancePct = 20) {
  let recomputed = 0;
  let billed = 0;
  for (const day of data.days) {
    if (day.actualCostDay == null) continue; // no billing truth for this day
    billed += day.actualCostDay;
    for (const p of day.projs) {
      const pr = priceFor(p.model, day.date);
      // Same blended tier weighting the dashboard uses (batch = half price).
      const tierMul =
        (p.tiers?.standard ?? 1) * 1 + (p.tiers?.batch ?? 0) * 0.5 + (p.tiers?.priority ?? 0) * 1;
      recomputed +=
        (p.tok.fresh * pr.in +
          p.tok.cacheRead * pr.read +
          p.tok.cacheCreate * pr.write +
          p.tok.output * pr.out) * tierMul;
    }
  }
  if (billed < 0.01) return; // nothing meaningful to compare
  const driftPct = Math.abs(recomputed - billed) / billed * 100;
  if (driftPct > tolerancePct) {
    console.warn("");
    console.warn(`⚠ PRICE MAP DRIFT DETECTED: recomputed cost ($${recomputed.toFixed(2)}) differs from`);
    console.warn(`  billed cost ($${billed.toFixed(2)}) by ${driftPct.toFixed(0)}% (tolerance ${tolerancePct}%).`);
    console.warn(`  Anthropic's prices have likely changed. Update the PRICE map in BOTH:`);
    console.warn(`    • scripts/fetch-usage.mjs`);
    console.warn(`    • index.html`);
    console.warn(`  Current rates: https://platform.claude.com/docs (Pricing)`);
    console.warn("");
  } else {
    console.log(`✓ Price check: recomputed cost within ${driftPct.toFixed(1)}% of billed — PRICE map looks accurate.`);
  }
}

const num = (v) => (v == null ? 0 : Number(v) || 0);
// Fallback label when a workspace has no name (shouldn't happen with List Workspaces):
// e.g. "wrkspc_018VcMkB…" — recognizable without being the full 30-char id.
const shortWs = (id) => (typeof id === "string" && id.length > 16 ? id.slice(0, 15) + "…" : id);

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  await loadEnv();
  const days = Number(opt("days", process.env.LEDGER_DAYS || 90));
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  const outPath = join(ROOT, "data.json");

  if (flag("fixture") || !key) {
    if (!flag("fixture")) {
      console.log("• No ANTHROPIC_ADMIN_KEY set — using the bundled sample fixture.");
      console.log("  (Set an Admin key in .env to pull your real usage. Needs an org account.)");
    } else {
      console.log("• --fixture: writing the bundled sample instead of calling the API.");
    }
    const fixture = await readFile(join(ROOT, "sample.data.json"), "utf8");
    const parsed = JSON.parse(fixture);
    parsed.source = "fixture";
    parsed.generatedAt = new Date().toISOString();
    await writeFile(outPath, JSON.stringify(parsed));
    console.log(`✓ Wrote ${outPath} (${parsed.DAYS} days, sample data).`);
    console.log("  Open index.html to view.");
    return;
  }

  if (!key.startsWith("sk-ant-admin01-")) {
    console.warn("⚠ ANTHROPIC_ADMIN_KEY doesn't look like an Admin key (expected sk-ant-admin01-…).");
    console.warn("  The Usage & Cost API rejects standard API keys. Continuing anyway…");
  }

  console.log(`• Fetching ${days} days of usage & cost from the Admin API…`);
  try {
    const data = await fetchLive(days);
    if (!data.DAYS) {
      console.warn("⚠ API returned no buckets for this window. Nothing written.");
      console.warn("  Check the date range, or that this org has API traffic.");
      return;
    }
    await writeFile(outPath, JSON.stringify(data));
    checkPriceAccuracy(data);
    console.log(`✓ Wrote ${outPath} (${data.DAYS} days of your live data).`);
    console.log("  This file is gitignored — it stays on your machine.");
    console.log("  Open index.html to view.");
  } catch (err) {
    console.error(`✗ Fetch failed: ${err.message}`);
    console.error("  Falling back to the bundled sample so the dashboard still opens.");
    const fixture = JSON.parse(await readFile(join(ROOT, "sample.data.json"), "utf8"));
    fixture.source = "fixture";
    fixture.generatedAt = new Date().toISOString();
    await writeFile(outPath, JSON.stringify(fixture));
    process.exitCode = 1;
  }
}

main();
