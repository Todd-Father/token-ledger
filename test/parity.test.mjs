import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRICE } from "../scripts/lib/pricing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* index.html carries a small inline fallback price table for the offline demo.
 * The authoritative table is scripts/lib/pricing.mjs (embedded into data.json).
 * This test fails if the fallback silently drifts from the source of truth. */

function extractInlinePrice(html) {
  const start = html.indexOf("const PRICE = {");
  assert.ok(start > -1, "index.html should contain an inline PRICE fallback");
  const end = html.indexOf("};", start);
  const block = html.slice(start, end);
  const entries = {};
  const re = /"(claude-[a-z0-9-]+)":\s*\{\s*in:\s*([\d.]+),\s*read:\s*([\d.]+),\s*write:\s*([\d.]+),\s*out:\s*([\d.]+)/g;
  for (const m of block.matchAll(re)) {
    entries[m[1]] = { in: +m[2], read: +m[3], write: +m[4], out: +m[5] };
  }
  return entries;
}

test("index.html inline price fallback matches scripts/lib/pricing.mjs", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const inline = extractInlinePrice(html);
  assert.ok(Object.keys(inline).length >= 3, "inline fallback should define at least the current models");
  for (const [model, p] of Object.entries(inline)) {
    assert.ok(PRICE[model], `inline model "${model}" is missing from pricing.mjs — add it there or remove it from index.html`);
    assert.deepEqual(p, PRICE[model], `inline price for "${model}" drifted from pricing.mjs`);
  }
});

test("committed sample fixture embeds the current price table", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "sample.data.json"), "utf8"));
  assert.ok(fixture.prices, "sample.data.json should embed `prices` — regenerate with: node scripts/gen-fixture.mjs");
  for (const [model, p] of Object.entries(fixture.prices)) {
    assert.deepEqual(p, PRICE[model], `fixture price for "${model}" drifted — regenerate with: node scripts/gen-fixture.mjs`);
  }
});
