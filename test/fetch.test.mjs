import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDays, computePriceDrift, detectSpendAnomaly } from "../scripts/fetch-usage.mjs";

/* ---------- buildDays: raw API buckets -> dashboard shape ---------- */

const usageRow = (over = {}) => ({
  workspace_id: "wrkspc_A",
  model: "claude-sonnet-5",
  service_tier: "standard",
  api_key_id: "key_prod",
  uncached_input_tokens: 2_000_000,
  cache_read_input_tokens: 6_000_000,
  cache_creation_input_tokens: 500_000,
  output_tokens: 1_000_000,
  ...over,
});

function sampleInput() {
  return {
    usage: [
      { starting_at: "2026-07-01T00:00:00Z", results: [
        usageRow(),
        usageRow({ api_key_id: "key_dev", service_tier: "batch",
          uncached_input_tokens: 1_000_000, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0, output_tokens: 500_000 }),
      ]},
      { starting_at: "2026-07-02T00:00:00Z", results: [usageRow()] },
    ],
    cost: [
      { starting_at: "2026-07-01T00:00:00Z", results: [
        { workspace_id: "wrkspc_A", amount: "452.79" }, // cents -> $4.5279
      ]},
    ],
    wsNameMap: new Map([["wrkspc_A", "My App"]]),
    keyNameMap: new Map([["key_prod", "prod-app"], ["key_dev", "local-dev-testing"]]),
  };
}

test("buildDays produces sorted days with tokens in millions", () => {
  const data = buildDays(sampleInput());
  assert.equal(data.DAYS, 2);
  assert.deepEqual(data.days.map((d) => d.date), ["2026-07-01", "2026-07-02"]);
  const p = data.days[0].projs[0];
  assert.equal(p.name, "My App");
  assert.equal(p.id, "wrkspc_A");
  assert.equal(p.tok.fresh, 3);        // 2M + 1M tokens -> 3 Mtok
  assert.equal(p.tok.cacheRead, 6);
  assert.equal(p.tok.cacheCreate, 0.5);
  assert.equal(p.tok.output, 1.5);
});

test("buildDays converts Cost API cents to dollars and attaches per-day actuals", () => {
  const data = buildDays(sampleInput());
  assert.ok(Math.abs(data.days[0].actualCostDay - 4.5279) < 1e-9);
  assert.ok(Math.abs(data.days[0].projs[0].actualCost - 4.5279) < 1e-9);
  assert.equal(data.days[1].actualCostDay, null); // no cost row for day 2
});

test("buildDays classifies dev vs prod from API key names", () => {
  const data = buildDays(sampleInput());
  const p = data.days[0].projs[0];
  // dev slice: 1M fresh + 0.5M out = 1.5 Mtok of 11 Mtok total
  assert.ok(Math.abs(p.env.dev - 1.5 / 11) < 1e-9);
  assert.ok(Math.abs(p.env.dev + p.env.prod - 1) < 1e-9);
});

test("buildDays computes service-tier fractions", () => {
  const data = buildDays(sampleInput());
  const p = data.days[0].projs[0];
  assert.ok(Math.abs(p.tiers.batch - 1.5 / 11) < 1e-9);
  assert.ok(Math.abs(p.tiers.standard - 9.5 / 11) < 1e-9);
  assert.equal(p.tiers.priority, 0);
});

test("buildDays embeds the price table for the dashboard", () => {
  const data = buildDays(sampleInput());
  assert.ok(data.prices && data.prices["claude-sonnet-5"]);
  assert.equal(data.source, "live");
});

test("buildDays normalizes dated model ids to versioned price keys", () => {
  const input = sampleInput();
  input.usage = [{ starting_at: "2026-07-01T00:00:00Z", results: [
    usageRow({ model: "claude-opus-4-1-20250805" }),
  ]}];
  const data = buildDays(input);
  assert.equal(data.days[0].projs[0].model, "claude-opus-4-1");
});

/* ---------- computePriceDrift (the canary) ---------- */

function driftFixture(billedPerDay) {
  // 1 Mtok fresh @ $3 + 1 Mtok output @ $15 = $18/day recomputed
  return { days: [{
    date: "2026-07-01", actualCostDay: billedPerDay,
    projs: [{ model: "claude-sonnet-5",
      tok: { fresh: 1, cacheRead: 0, cacheCreate: 0, output: 1 },
      tiers: { standard: 1, batch: 0, priority: 0 } }],
  }] };
}

test("canary passes when recomputed cost matches billing", () => {
  const r = computePriceDrift(driftFixture(18));
  assert.equal(r.comparable, true);
  assert.equal(r.ok, true);
  assert.ok(r.driftPct < 0.001);
});

test("canary flags a stale price map", () => {
  const r = computePriceDrift(driftFixture(36)); // real bill is 2× our table
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.driftPct - 50) < 0.001);
});

test("canary applies the batch-tier discount when recomputing", () => {
  const fix = driftFixture(9); // all-batch: 18 × 0.5
  fix.days[0].projs[0].tiers = { standard: 0, batch: 1, priority: 0 };
  const r = computePriceDrift(fix);
  assert.equal(r.ok, true);
  assert.ok(r.driftPct < 0.001);
});

test("canary declines to judge without billing data", () => {
  const fix = driftFixture(null);
  const r = computePriceDrift(fix);
  assert.equal(r.comparable, false);
  assert.equal(r.ok, true);
});

/* ---------- detectSpendAnomaly ---------- */

const day = (date, cost) => ({ date, actualCostDay: cost, projs: [] });

test("spend anomaly fires on a >3x spike over the trailing average", () => {
  const data = { days: [day("2026-07-01", 1), day("2026-07-02", 1), day("2026-07-03", 1), day("2026-07-04", 10)] };
  const hit = detectSpendAnomaly(data, { todayKey: "2026-07-05" });
  assert.ok(hit);
  assert.equal(hit.latest.date, "2026-07-04");
  assert.ok(Math.abs(hit.avg - 1) < 1e-9);
});

test("spend anomaly stays quiet on normal variation", () => {
  const data = { days: [day("2026-07-01", 1), day("2026-07-02", 1), day("2026-07-03", 1), day("2026-07-04", 1.4)] };
  assert.equal(detectSpendAnomaly(data, { todayKey: "2026-07-05" }), null);
});

test("spend anomaly respects the absolute LEDGER_ALERT_USD limit", () => {
  const data = { days: [day("2026-07-01", 1), day("2026-07-02", 1), day("2026-07-03", 1), day("2026-07-04", 2)] };
  assert.equal(detectSpendAnomaly(data, { todayKey: "2026-07-05" }), null); // 2 < max(1, 3×1)
  assert.ok(detectSpendAnomaly(data, { todayKey: "2026-07-05", absLimit: 1.5 }));
});

test("spend anomaly ignores today's incomplete day", () => {
  const data = { days: [day("2026-07-01", 1), day("2026-07-02", 1), day("2026-07-03", 1), day("2026-07-04", 50)] };
  // "today" IS the spike day -> it's incomplete, so it must not be judged
  assert.equal(detectSpendAnomaly(data, { todayKey: "2026-07-04" }), null);
});
