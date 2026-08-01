import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, foldClaudeCode } from "../scripts/lib/claude-code.mjs";

/* ---------- parseLine ---------- */

const entryLine = (over = {}, usageOver = {}) => JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-15T12:00:00.000Z",
  requestId: "req_1",
  cwd: "/Users/me/Projects/my-app",
  uuid: "uuid-1",
  message: {
    id: "msg_1",
    model: "claude-fable-5",
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 20_000,
      output_tokens: 500,
      service_tier: "standard",
      cache_creation: { ephemeral_1h_input_tokens: 15_000, ephemeral_5m_input_tokens: 5_000 },
      ...usageOver,
    },
  },
  ...over,
});

test("parseLine extracts a normalized usage entry", () => {
  const e = parseLine(entryLine(), "-Users-me-Projects-my-app");
  assert.equal(e.date, "2026-07-15");
  assert.equal(e.model, "claude-fable-5");
  assert.equal(e.fresh, 100);
  assert.equal(e.cacheRead, 30_000);
  assert.equal(e.cacheCreate, 20_000);
  assert.equal(e.cacheCreate1h, 15_000);
  assert.equal(e.output, 500);
  assert.equal(e.key, "msg_1:req_1");
  assert.equal(e.cwd, "/Users/me/Projects/my-app");
});

test("parseLine skips non-usage lines cheaply", () => {
  assert.equal(parseLine('{"type":"user","message":{}}', "d"), null);
  assert.equal(parseLine('{"type":"queue-operation"}', "d"), null);
  assert.equal(parseLine("not json at all", "d"), null);
  assert.equal(parseLine(JSON.stringify({ type: "assistant", message: { id: "m" } }), "d"), null); // no usage
});

test("parseLine skips synthetic error placeholders", () => {
  const line = entryLine().replace('"claude-fable-5"', '"<synthetic>"');
  assert.equal(parseLine(line, "d"), null);
});

/* ---------- foldClaudeCode ---------- */

const NOW = new Date("2026-07-20T00:00:00Z");

function e(over = {}) {
  return {
    key: "msg_1:req_1", date: "2026-07-15", model: "claude-fable-5",
    dirName: "-Users-me-Projects-my-app", cwd: "/Users/me/Projects/my-app",
    tier: "standard",
    fresh: 1_000_000, cacheRead: 2_000_000, cacheCreate: 500_000, cacheCreate1h: 0,
    output: 250_000,
    ...over,
  };
}

test("fold dedups identical message writes, keeping one", () => {
  const data = foldClaudeCode([e(), e(), e()], { days: 30, now: NOW });
  assert.equal(data.DAYS, 1);
  assert.equal(data.days[0].projs[0].tok.fresh, 1); // 1 Mtok, counted once
});

test("fold converts to millions and groups by day × project", () => {
  const data = foldClaudeCode([
    e(),
    e({ key: "m2:r2", date: "2026-07-16" }),
    e({ key: "m3:r3", dirName: "-other", cwd: "/Users/me/other-app" }),
  ], { days: 30, now: NOW });
  assert.equal(data.DAYS, 2);
  assert.deepEqual(data.days.map((d) => d.date), ["2026-07-15", "2026-07-16"]);
  assert.equal(data.days[0].projs.length, 2);
  assert.equal(data.days[1].projs.length, 1);
  const p = data.days[0].projs.find((x) => x.name === "my-app");
  assert.equal(p.tok.cacheRead, 2);
  assert.equal(p.tok.output, 0.25);
});

test("fold names projects from the majority cwd basename", () => {
  const data = foldClaudeCode([
    e(),
    e({ key: "m2:r2", cwd: "/Users/me/Projects/my-app" }),
    e({ key: "m3:r3", cwd: "/tmp/elsewhere" }),
  ], { days: 30, now: NOW });
  assert.equal(data.days[0].projs[0].name, "my-app");
});

test("fold drops entries outside the window", () => {
  const data = foldClaudeCode([e(), e({ key: "old:r", date: "2026-01-01" })], { days: 30, now: NOW });
  assert.equal(data.DAYS, 1);
});

test("fold prices 1-hour cache writes at 2× input in the estimate", () => {
  // fable-5: in=10. 1 Mtok of cache write.
  const all5m = foldClaudeCode([e({ fresh: 0, cacheRead: 0, output: 0, cacheCreate: 1_000_000, cacheCreate1h: 0 })],
    { days: 30, now: NOW });
  const all1h = foldClaudeCode([e({ fresh: 0, cacheRead: 0, output: 0, cacheCreate: 1_000_000, cacheCreate1h: 1_000_000 })],
    { days: 30, now: NOW });
  assert.ok(Math.abs(all5m.days[0].estCostDay - 12.5) < 1e-9);  // 1.25 × $10
  assert.ok(Math.abs(all1h.days[0].estCostDay - 20) < 1e-9);    // 2.00 × $10
  assert.equal(all1h.days[0].projs[0].tok.cacheCreate1h, 1);    // split carried through
});

test("fold marks Claude Code data as subscription usage (no billed actuals, dev env, null ids)", () => {
  const data = foldClaudeCode([e()], { days: 30, now: NOW });
  const day = data.days[0];
  assert.equal(day.actualCostDay, null);
  assert.ok(day.estCostDay > 0);
  const p = day.projs[0];
  assert.equal(p.actualCost, null);
  assert.equal(p.id, null); // null id → recs show Claude Code guidance, not API snippets
  assert.deepEqual(p.env, { dev: 1, prod: 0 });
});

test("fold embeds source metadata and the price table", () => {
  const data = foldClaudeCode([e()], { days: 30, now: NOW });
  assert.equal(data.source, "claude-code");
  assert.ok(data.prices["claude-fable-5"]);
});

test("fold picks the dominant model per project-day", () => {
  const data = foldClaudeCode([
    e({ fresh: 100_000 }),
    e({ key: "m2:r2", model: "claude-haiku-4-5", fresh: 90_000_000, cacheRead: 0, cacheCreate: 0, output: 0 }),
  ], { days: 30, now: NOW });
  assert.equal(data.days[0].projs[0].model, "claude-haiku-4-5");
});
