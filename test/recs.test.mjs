import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

/* Evaluates index.html's inline <script> in a VM with a minimal DOM stand-in,
 * then drives aggregate() + buildRecs() directly. This keeps the money math in
 * the dashboard under test without splitting the single-file architecture. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeElement() {
  const handler = {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return undefined;
      return element;
    },
    set() { return true; },
    apply() { return element; },
  };
  const element = new Proxy(function () {}, handler);
  return element;
}

function makeContext() {
  const el = makeElement();
  const store = new Map();
  const sandbox = {
    console,
    document: {
      getElementById: () => el,
      querySelector: () => el,
      querySelectorAll: () => el,
      createElement: () => el,
      documentElement: el,
      body: el,
      addEventListener: () => {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    fetch: () => Promise.reject(new Error("offline (test)")),
    __out: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "index.html should contain an inline <script>");
  vm.runInContext(script, sandbox);
  return sandbox;
}

// 30 identical days: one Opus-heavy low-cache project, one Sonnet project.
function fixture({ actualMultiple = null } = {}) {
  const days = [];
  for (let i = 0; i < 30; i++) {
    const projs = [
      { id: "wrkspc_A", name: "opus-app", color: "#c1852c", model: "claude-opus-4-8",
        tok: { fresh: 10, cacheRead: 1, cacheCreate: 0.5, output: 3 },
        tiers: { standard: 1, batch: 0, priority: 0 }, env: { dev: 0.2, prod: 0.8 } },
      { id: "wrkspc_B", name: "sonnet-app", color: "#2f8f6e", model: "claude-sonnet-5",
        tok: { fresh: 20, cacheRead: 2, cacheCreate: 1, output: 4 },
        tiers: { standard: 1, batch: 0, priority: 0 }, env: { dev: 0.2, prod: 0.8 } },
    ];
    // recomputed cost/day at list price: opus 128.625 + sonnet 124.35 = 252.975
    const est = 252.975;
    days.push({
      dayIndex: i, weekday: true, date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      projs, actualCostDay: actualMultiple == null ? null : est * actualMultiple,
    });
  }
  return { days, DAYS: 30, source: "live" };
}

let ctx;
before(() => { ctx = makeContext(); });

function runRecs(dataOpts = {}, setup = "") {
  ctx.__fixture = fixture(dataOpts);
  vm.runInContext(`
    DATA = __fixture;
    S.days = 30; S.tier = "all"; S.env = "all"; S.caching = true;
    ASSUME = { ...ASSUME_DEFAULTS };
    ${setup}
    __out.r = buildRecs(aggregate());
  `, ctx);
  return ctx.__out.r;
}

test("dashboard script evaluates against the DOM stub", () => {
  assert.equal(typeof ctx.__out, "object");
  assert.equal(vm.runInContext("typeof buildRecs", ctx), "function");
  assert.equal(vm.runInContext("typeof aggregate", ctx), "function");
});

test("low cache hit + heavy Opus + all-standard tiers trigger the three big cost recs", () => {
  const { recs } = runRecs();
  const ids = recs.map((r) => r.id);
  assert.ok(ids.includes("cache-prefixes"), `expected cache rec in ${ids}`);
  assert.ok(ids.includes("right-size"), `expected right-size rec in ${ids}`);
  assert.ok(ids.includes("batch-tier"), `expected batch rec in ${ids}`);
});

test("quantified recs carry a stated assumption and a positive dollar impact", () => {
  const { recs } = runRecs();
  for (const id of ["cache-prefixes", "right-size", "batch-tier"]) {
    const r = recs.find((x) => x.id === id);
    assert.ok(r.impact > 0, `${id} should have a positive impact`);
    assert.match(r.assume, /assumes/, `${id} should state its assumption`);
  }
});

test("dollar impacts scale with the tunable assumptions", () => {
  const base = runRecs().recs.find((r) => r.id === "right-size").impact;
  const doubled = runRecs({}, "ASSUME.downshiftShare = ASSUME_DEFAULTS.downshiftShare * 2;")
    .recs.find((r) => r.id === "right-size").impact;
  assert.ok(Math.abs(doubled / base - 2) < 1e-9, `right-size impact should double (got ×${doubled / base})`);

  const cacheBase = runRecs().recs.find((r) => r.id === "cache-prefixes").impact;
  const cacheHalf = runRecs({}, "ASSUME.cacheConvertible = ASSUME_DEFAULTS.cacheConvertible / 2;")
    .recs.find((r) => r.id === "cache-prefixes").impact;
  assert.ok(Math.abs(cacheHalf / cacheBase - 0.5) < 1e-9, "cache impact should halve");
});

test("savings are restated in billed dollars when the Cost API disagrees with the estimate", () => {
  const est = runRecs({ actualMultiple: null }).recs.find((r) => r.id === "cache-prefixes").impact;
  const real = runRecs({ actualMultiple: 2 }).recs.find((r) => r.id === "cache-prefixes").impact;
  assert.ok(Math.abs(real / est - 2) < 1e-6,
    `impact should scale by the billed/estimated ratio (got ×${real / est})`);
});

test("modeling caching OFF surfaces the turn-it-back-on rec with the counterfactual delta", () => {
  const { recs } = runRecs({}, "S.caching = false;");
  const r = recs.find((x) => x.id === "caching-off");
  assert.ok(r, "caching-off rec should appear when the toggle is off");
  assert.ok(r.impact > 0);
});

test("recs rank dollar-quantified items first", () => {
  const { recs } = runRecs();
  const firstUnquantified = recs.findIndex((r) => typeof r.impact !== "number" || !(r.impact > 0));
  const lastQuantified = recs.reduce((acc, r, i) => (r.impact > 0 ? i : acc), -1);
  assert.ok(firstUnquantified === -1 || lastQuantified < firstUnquantified,
    "every $-quantified rec should sort before qualitative ones");
});

test("payloadTotal uses billed cost when present and the estimate otherwise", () => {
  vm.runInContext(`
    __out.billed = payloadTotal({ days: [
      { actualCostDay: 10, estCostDay: 99 }, { actualCostDay: 5, estCostDay: 99 } ] });
    __out.est = payloadTotal({ days: [
      { actualCostDay: null, estCostDay: 7 }, { actualCostDay: null, estCostDay: 3 } ] });
    __out.mixed = payloadTotal({ days: [ { actualCostDay: 4 }, { estCostDay: 6 } ] });
  `, ctx);
  assert.equal(ctx.__out.billed, 15, "billed cost wins over the estimate");
  assert.equal(ctx.__out.est, 10);
  assert.equal(ctx.__out.mixed, 10);
});

test("the comparison never sums the two sources", () => {
  // Guard against a future refactor quietly adding billed $ to list-price value.
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const start = html.indexOf("function renderComparison");
  const body = html.slice(start, html.indexOf("\n}", start));
  assert.ok(body.includes("apiTot") && body.includes("codeTot"), "should read both totals");
  assert.ok(!/apiTot\s*\+\s*codeTot|codeTot\s*\+\s*apiTot/.test(body),
    "must never add billed dollars to subscription list-price value");
  assert.ok(body.includes("never added together"), "should state the units differ");
});

test("Claude Code data suppresses per-token billing recs that don't apply to subscriptions", () => {
  const api = runRecs();
  assert.ok(api.recs.some((r) => r.id === "batch-tier"), "batch rec should fire for API data");
  const code = runRecs({}, 'DATA.source = "claude-code";');
  const ids = code.recs.map((r) => r.id);
  assert.ok(!ids.includes("batch-tier"), "no Batch tier on subscription usage");
  assert.ok(!ids.includes("chargeback"), "no workspace chargeback on local Claude Code data");
  const alert = code.recs.find((r) => r.id === "spend-alert");
  if (alert) assert.equal(alert.applied, true, "anomaly alert is built into the scanner");
});

test("projDayCost prices 1-hour cache writes at 2× input when the split is present", () => {
  ctx.__fixture = fixture();
  vm.runInContext(`
    DATA = __fixture; DATA.prices = null;
    const base = { model: "claude-opus-4-8",
      tok: { fresh: 0, cacheRead: 0, cacheCreate: 1, cacheCreate1h: 0, output: 0 },
      tiers: { standard: 1, batch: 0, priority: 0 } };
    __out.c5m = projDayCost(base, "all", true, "all").cost;
    __out.c1h = projDayCost({ ...base, tok: { ...base.tok, cacheCreate1h: 1 } }, "all", true, "all").cost;
  `, ctx);
  assert.ok(Math.abs(ctx.__out.c5m - 6.25) < 1e-9); // 1.25 × $5
  assert.ok(Math.abs(ctx.__out.c1h - 10) < 1e-9);   // 2.00 × $5
});

test("live pricing uses the table embedded in data.json over the inline fallback", () => {
  ctx.__fixture = fixture();
  vm.runInContext(`
    DATA = __fixture;
    DATA.prices = { "claude-opus-4-8": { in: 99, read: 9.9, write: 123, out: 495 } };
    __out.p = priceForDay("claude-opus-4-8");
  `, ctx);
  assert.equal(ctx.__out.p.in, 99);
  vm.runInContext(`DATA.prices = null; __out.p2 = priceForDay("claude-opus-4-8");`, ctx);
  assert.equal(ctx.__out.p2.in, 5); // falls back to the inline table
});
