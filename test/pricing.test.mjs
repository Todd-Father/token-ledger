import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICE, DEFAULT_MODEL, normalizeModel, priceFor } from "../scripts/lib/pricing.mjs";

test("every price entry is complete and internally consistent", () => {
  for (const [model, p] of Object.entries(PRICE)) {
    for (const f of ["in", "read", "write", "out"]) {
      assert.equal(typeof p[f], "number", `${model}.${f} must be a number`);
      assert.ok(p[f] > 0, `${model}.${f} must be positive`);
    }
    // cache read ≈ 10% of input, cache write (5m) ≈ 125% of input
    assert.ok(Math.abs(p.read / p.in - 0.1) < 0.03, `${model}: read should be ~0.1× input`);
    assert.ok(Math.abs(p.write / p.in - 1.25) < 0.06, `${model}: write should be ~1.25× input`);
    assert.ok(p.out > p.in, `${model}: output rate should exceed input rate`);
  }
});

test("normalizeModel maps dated API ids to versioned price keys", () => {
  assert.equal(normalizeModel("claude-opus-4-1-20250805"), "claude-opus-4-1");
  assert.equal(normalizeModel("claude-opus-4-20250514"), "claude-opus-4-0");
  assert.equal(normalizeModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModel("claude-sonnet-4-20250514"), "claude-sonnet-4-0");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(normalizeModel("claude-3-5-haiku-20241022"), "claude-3-5-haiku");
  assert.equal(normalizeModel("claude-3-haiku-20240307"), "claude-3-haiku");
  assert.equal(normalizeModel("claude-3-7-sonnet-20250219"), "claude-3-7-sonnet");
});

test("normalizeModel maps bare aliases and families", () => {
  assert.equal(normalizeModel("claude-fable-5"), "claude-fable-5");
  assert.equal(normalizeModel("claude-mythos-5"), "claude-fable-5"); // same rates
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(normalizeModel("CLAUDE-SONNET-5"), "claude-sonnet-5"); // case-insensitive
});

test("distinct versions get distinct prices where rates differ", () => {
  // Opus 4.1 is 3× the price of Opus 4.8 — collapsing them would misprice by 3×
  assert.equal(priceFor("claude-opus-4-1-20250805").in, 15);
  assert.equal(priceFor("claude-opus-4-8").in, 5);
  assert.equal(priceFor("claude-3-5-haiku-20241022").in, 0.8);
  assert.equal(priceFor("claude-haiku-4-5").in, 1);
});

test("unknown / missing models fall back to the default model's rates", () => {
  assert.equal(normalizeModel(null), DEFAULT_MODEL);
  assert.equal(normalizeModel(undefined), DEFAULT_MODEL);
  assert.equal(normalizeModel("some-future-model"), DEFAULT_MODEL);
  assert.deepEqual(priceFor("some-future-model"), PRICE[DEFAULT_MODEL]);
});

test("family fallbacks price unknown versions at the current model's rates", () => {
  assert.equal(normalizeModel("claude-opus-9"), "claude-opus-5");
  assert.equal(normalizeModel("claude-sonnet-9"), "claude-sonnet-5");
  assert.equal(normalizeModel("claude-haiku-9"), "claude-haiku-4-5");
});
