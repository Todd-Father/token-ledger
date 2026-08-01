#!/usr/bin/env node
/**
 * gen-fixture.mjs — regenerate the committed demo fixtures.
 *   node scripts/gen-fixture.mjs
 *
 * Writes two files, both synthetic and safe to publish:
 *   sample.data.json       — Claude API shape (billed cost, workspaces)
 *   sample.code.data.json  — Claude Code shape (list-price value, project dirs)
 *
 * Together they let the public demo show the source switcher and the
 * API-vs-Claude-Code comparison. The Claude Code fixture is modeled on the
 * real shape of that data: very high cache-read share, a mix of 5m/1h cache
 * writes, no billed cost (estCostDay only), dev-only environment, and null
 * project ids (local directories aren't API workspaces).
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRICE, PRICE_META } from "./lib/pricing.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = [
  { id: "wrkspc_01example01", name: "web-app", color: "#c1852c", weight: 0.34, model: "claude-sonnet-5", cacheAff: 0.78, ioBias: 0.55 },
  { id: "wrkspc_01example02", name: "agent-service", color: "#2f8f6e", weight: 0.11, model: "claude-opus-4-8", cacheAff: 0.62, ioBias: 0.70 },
  { id: "wrkspc_01example03", name: "batch-pipeline", color: "#2f6f8f", weight: 0.27, model: "claude-sonnet-5", cacheAff: 0.85, ioBias: 0.40 },
  { id: "wrkspc_01example04", name: "content-tool", color: "#9a5bc4", weight: 0.14, model: "claude-haiku-4-5", cacheAff: 0.30, ioBias: 1.30 },
  { id: null, name: "default (console)", color: "#82869a", weight: 0.14, model: "claude-opus-4-8", cacheAff: 0.20, ioBias: 0.85 },
];
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function buildData() {
  const r = rng(1337);
  const DAYS = 90;
  const days = [];
  for (let d = 0; d < DAYS; d++) {
    const dow = (d + 3) % 7;
    const weekday = dow >= 1 && dow <= 5;
    const base = weekday ? 1 : 0.42;
    const growth = 1 + d * 0.006; // gentler across 90 days
    const jitter = 0.8 + r() * 0.45;
    const dayScale = base * growth * jitter;
    const projs = PROJECTS.map((p) => {
      const inputM = p.weight * 42 * dayScale * (0.8 + r() * 0.5);
      const aff = Math.min(0.95, p.cacheAff * (0.85 + r() * 0.3));
      const cacheRead = inputM * aff;
      const fresh = inputM * (1 - aff);
      const cacheCreate = cacheRead * (0.06 + r() * 0.05);
      const output = inputM * p.ioBias * (0.7 + r() * 0.5) * 0.5;
      const batchShare = p.name.includes("batch") ? 0.35 : p.name.includes("content") ? 0.15 : 0.05;
      const priShare = p.name.includes("agent") ? 0.25 : 0.03;
      // dev share: web-app/batch are prod-heavy; agent-service is a dev/experimentation
      // workload; content-tool splits; default (console) is mostly dev (Workbench/agent).
      const devShare = p.name.includes("agent") ? 0.65
        : p.name.includes("default") ? 0.80
        : p.name.includes("content") ? 0.40
        : p.name.includes("batch") ? 0.10
        : 0.20; // web-app: mostly prod
      // add mild daily wobble so the split isn't a flat line
      const dev = Math.max(0, Math.min(1, devShare + (r() - 0.5) * 0.15));
      return {
        id: p.id, name: p.name, color: p.color, model: p.model,
        tok: { fresh, cacheRead, cacheCreate, output },
        tiers: { batch: batchShare, priority: priShare, standard: 1 - batchShare - priShare },
        env: { dev, prod: 1 - dev },
      };
    });
    // Synthetic authoritative cost: token-estimate + a small realistic drift
    // (~+8–12%, standing in for tax / pricing-model differences) so the demo's
    // reconciliation panel has a believable computed-vs-actual gap.
    const estDay = projs.reduce((s, pr) => {
      const p = PRICE[pr.model] || PRICE["claude-sonnet-5"];
      const t = pr.tok;
      const tierMul = pr.tiers.standard + pr.tiers.batch * 0.5 + pr.tiers.priority;
      return s + (t.fresh * p.in + t.cacheRead * p.read + t.cacheCreate * p.write + t.output * p.out) * tierMul;
    }, 0);
    const drift = 1 + 0.08 + r() * 0.05;
    days.push({ dayIndex: d, weekday, projs, actualCostDay: +(estDay * drift).toFixed(2) });
  }
  return { days, DAYS, source: "fixture", prices: PRICE, priceMeta: PRICE_META };
}
/* ---------- Claude Code fixture ----------
 * Local project directories, not API workspaces: id is null, environment is
 * 100% dev, and there is no billed cost — only estCostDay (list-price value).
 * Cache-read share is deliberately very high (~0.93–0.96), which is what real
 * Claude Code sessions look like once a project's context is warm. */
const CODE_PROJECTS = [
  { name: "token-ledger",    color: "#c1852c", weight: 0.30, model: "claude-fable-5",   cacheAff: 0.955, ioBias: 0.030 },
  { name: "storefront",      color: "#2f8f6e", weight: 0.24, model: "claude-sonnet-5",  cacheAff: 0.945, ioBias: 0.025 },
  { name: "data-pipeline",   color: "#2f6f8f", weight: 0.18, model: "claude-sonnet-5",  cacheAff: 0.960, ioBias: 0.020 },
  { name: "mobile-app",      color: "#9a5bc4", weight: 0.15, model: "claude-opus-4-8",  cacheAff: 0.930, ioBias: 0.035 },
  { name: "infra-scripts",   color: "#c9524f", weight: 0.08, model: "claude-haiku-4-5", cacheAff: 0.905, ioBias: 0.040 },
  { name: "docs-site",       color: "#4a9d7f", weight: 0.05, model: "claude-sonnet-5",  cacheAff: 0.920, ioBias: 0.030 },
];

function buildCodeData({ days: DAYS = 45, endDate = "2026-07-31" } = {}) {
  const r = rng(90210);
  const end = new Date(endDate + "T00:00:00Z");
  const days = [];
  for (let d = 0; d < DAYS; d++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - (DAYS - 1 - d));
    const date = dt.toISOString().slice(0, 10);
    const dow = dt.getUTCDay();
    const weekday = dow >= 1 && dow <= 5;
    // Coding sessions are bursty: some days are idle, weekdays dominate.
    const idle = r() < (weekday ? 0.10 : 0.55);
    const dayScale = idle ? 0 : (weekday ? 1 : 0.45) * (0.55 + r() * 1.5);
    if (!dayScale) continue; // no sessions that day — the timeline has real gaps

    let estCostDay = 0;
    const projs = CODE_PROJECTS.map((p) => {
      // Only some projects are touched on a given day.
      if (r() > (0.35 + p.weight)) return null;
      const inputM = p.weight * 260 * dayScale * (0.6 + r() * 0.9); // Mtok — cache reads dominate
      const aff = Math.min(0.985, p.cacheAff * (0.99 + r() * 0.02));
      const cacheRead = inputM * aff;
      const fresh = inputM * (1 - aff);
      const cacheCreate = cacheRead * (0.015 + r() * 0.02);
      const cacheCreate1h = cacheCreate * (0.55 + r() * 0.35); // Claude Code writes many 1h entries
      const output = inputM * p.ioBias * (0.7 + r() * 0.6);
      const tok = { fresh, cacheRead, cacheCreate, cacheCreate1h, output };
      const pr = PRICE[p.model] || PRICE["claude-sonnet-5"];
      const cc5m = Math.max(0, cacheCreate - cacheCreate1h);
      estCostDay += fresh * pr.in + cacheRead * pr.read +
        cc5m * pr.write + cacheCreate1h * pr.write * 1.6 + output * pr.out;
      return {
        id: null, name: p.name, color: p.color, model: p.model, tok,
        tiers: { standard: 1, batch: 0, priority: 0 },
        env: { dev: 1, prod: 0 },
        actualCost: null,
      };
    }).filter(Boolean);
    if (!projs.length) continue;

    days.push({ dayIndex: days.length, weekday, date, projs,
                actualCostDay: null, estCostDay: +estCostDay.toFixed(4) });
  }
  days.forEach((d, i) => { d.dayIndex = i; });
  return { days, DAYS: days.length, source: "claude-code", prices: PRICE, priceMeta: PRICE_META };
}

const data = buildData();
await writeFile(join(ROOT, "sample.data.json"), JSON.stringify(data));
console.log(`✓ Wrote sample.data.json (${data.DAYS} days, Claude API shape).`);

const codeData = buildCodeData();
await writeFile(join(ROOT, "sample.code.data.json"), JSON.stringify(codeData));
const codeTotal = codeData.days.reduce((s, d) => s + d.estCostDay, 0);
console.log(`✓ Wrote sample.code.data.json (${codeData.DAYS} active days, ~$${codeTotal.toFixed(0)} list-price value).`);
