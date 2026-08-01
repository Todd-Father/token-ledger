/**
 * pricing.mjs — the single source of truth for per-model prices.
 *
 * Consumed by scripts/fetch-usage.mjs and scripts/gen-fixture.mjs, and embedded
 * into data.json (as `prices`) so the dashboard prices live data from the same
 * table. index.html keeps a small inline fallback for the offline demo — a CI
 * test (test/parity.test.mjs) fails if that fallback drifts from this file.
 *
 * Rates are USD per million tokens. read = cache read (~0.1× input),
 * write = 5-minute cache write (~1.25× input).
 * Source: https://platform.claude.com/docs (Pricing). Last verified: 2026-08-01.
 *
 * NOTE on Sonnet 5: the docs list an introductory $2/$10 rate through
 * 2026-08-31 ($3/$15 after). This org's Cost API billing was verified at the
 * full $3/$15 on 2026-07-31, so we price it flat — the reconcile canary in
 * fetch-usage.mjs warns loudly if that ever stops matching the real bill.
 */

export const PRICE_META = { verified: "2026-08-01", currency: "USD/Mtok" };

export const PRICE = {
  // current models
  "claude-fable-5":    { in: 10,   read: 1.00,  write: 12.50, out: 50 },
  "claude-opus-5":     { in: 5,    read: 0.50,  write: 6.25,  out: 25 },
  "claude-opus-4-8":   { in: 5,    read: 0.50,  write: 6.25,  out: 25 },
  "claude-opus-4-7":   { in: 5,    read: 0.50,  write: 6.25,  out: 25 },
  "claude-opus-4-6":   { in: 5,    read: 0.50,  write: 6.25,  out: 25 },
  "claude-sonnet-5":   { in: 3,    read: 0.30,  write: 3.75,  out: 15 }, // billing-verified 2026-07-31
  "claude-sonnet-4-6": { in: 3,    read: 0.30,  write: 3.75,  out: 15 },
  "claude-haiku-4-5":  { in: 1,    read: 0.10,  write: 1.25,  out: 5 },
  // legacy models still billable in a 90-day window
  "claude-opus-4-5":   { in: 5,    read: 0.50,  write: 6.25,  out: 25 },
  "claude-opus-4-1":   { in: 15,   read: 1.50,  write: 18.75, out: 75 },
  "claude-opus-4-0":   { in: 15,   read: 1.50,  write: 18.75, out: 75 },
  "claude-sonnet-4-5": { in: 3,    read: 0.30,  write: 3.75,  out: 15 },
  "claude-sonnet-4-0": { in: 3,    read: 0.30,  write: 3.75,  out: 15 },
  "claude-3-7-sonnet": { in: 3,    read: 0.30,  write: 3.75,  out: 15 },
  "claude-3-5-haiku":  { in: 0.80, read: 0.08,  write: 1.00,  out: 4 },
  "claude-3-haiku":    { in: 0.25, read: 0.03,  write: 0.30,  out: 1.25 },
};

export const DEFAULT_MODEL = "claude-sonnet-5";

/* Ordered matchers: first hit wins, so version-specific patterns must come
 * before their family fallback. Handles raw API model ids with date suffixes
 * (e.g. "claude-opus-4-1-20250805") and bare aliases alike. */
const MATCHERS = [
  [/fable|mythos/, "claude-fable-5"],
  [/opus-5/, "claude-opus-5"],
  [/opus-4-8/, "claude-opus-4-8"],
  [/opus-4-7/, "claude-opus-4-7"],
  [/opus-4-6/, "claude-opus-4-6"],
  [/opus-4-5/, "claude-opus-4-5"],
  [/opus-4-1/, "claude-opus-4-1"],
  [/opus-4/, "claude-opus-4-0"],       // dated id "claude-opus-4-20250514"
  [/opus/, "claude-opus-5"],           // unknown opus → current opus rates
  [/sonnet-5/, "claude-sonnet-5"],
  [/sonnet-4-6/, "claude-sonnet-4-6"],
  [/sonnet-4-5/, "claude-sonnet-4-5"],
  [/sonnet-4/, "claude-sonnet-4-0"],   // dated id "claude-sonnet-4-20250514"
  [/3-7-sonnet/, "claude-3-7-sonnet"],
  [/sonnet/, "claude-sonnet-5"],
  [/haiku-4-5/, "claude-haiku-4-5"],
  [/3-5-haiku/, "claude-3-5-haiku"],
  [/3-haiku/, "claude-3-haiku"],
  [/haiku/, "claude-haiku-4-5"],
];

const _warnedModels = new Set();

export function normalizeModel(m) {
  if (!m) return DEFAULT_MODEL;
  const s = String(m).toLowerCase();
  for (const [re, key] of MATCHERS) if (re.test(s)) return key;
  if (!_warnedModels.has(m)) {
    _warnedModels.add(m);
    console.warn(`⚠ Unknown model "${m}" — no price on file; using ${DEFAULT_MODEL} pricing as a guess.`);
    console.warn(`  Add it to PRICE in scripts/lib/pricing.mjs for accurate costs.`);
  }
  return DEFAULT_MODEL;
}

/* Date-aware price lookup. dateStr ("YYYY-MM-DD") is accepted so callers can
 * price each day at the rate that applied on that day; no dated overrides are
 * active right now (see the Sonnet 5 note above), but the signature stays so a
 * future price change is a data edit, not a plumbing change. */
export function priceFor(model, dateStr) { // eslint-disable-line no-unused-vars
  return PRICE[normalizeModel(model)] || PRICE[DEFAULT_MODEL];
}
