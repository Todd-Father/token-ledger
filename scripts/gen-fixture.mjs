#!/usr/bin/env node
/**
 * gen-fixture.mjs — regenerate sample.data.json.
 * Reproduces the dashboard's synthetic buildData() so the committed fixture
 * is byte-identical in shape to a live fetch. Run once; the output is checked in.
 *   node scripts/gen-fixture.mjs
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PRICE = {
  "claude-opus-4-8":  { in: 15, read: 1.5, write: 18.75, out: 75 },
  "claude-sonnet-5":  { in: 3, read: 0.30, write: 3.75, out: 15 },
  "claude-haiku-4-5": { in: 0.80, read: 0.08, write: 1.00, out: 4 },
};
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
  return { days, DAYS, source: "fixture" };
}
const data = buildData();
await writeFile(join(ROOT, "sample.data.json"), JSON.stringify(data));
console.log(`✓ Wrote sample.data.json (${data.DAYS} days).`);
