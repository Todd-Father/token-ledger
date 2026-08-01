/**
 * claude-code.mjs — local Claude Code adapter.
 *
 * Reads the session transcripts Claude Code keeps under ~/.claude/projects/
 * (one directory per project, one <uuid>.jsonl per session) and folds the
 * per-message token usage into the same data.json shape the Admin API fetch
 * produces — so the dashboard works with zero keys and zero setup for anyone
 * who uses Claude Code.
 *
 * Notes on the format (verified against real transcripts):
 *  - usage lives on `type:"assistant"` entries at message.usage, with the
 *    model id at message.model and an ISO timestamp on the entry.
 *  - The same logical message is written multiple times (once per content
 *    block) with an IDENTICAL usage object — entries must be deduped on
 *    (message.id, requestId), keeping the first.
 *  - `<synthetic>` model entries are error placeholders with no real usage.
 *  - Cache writes are split 5-minute vs 1-hour (usage.cache_creation.*);
 *    1-hour writes bill at 2× input vs 1.25× for 5-minute, so the split is
 *    carried through (tok.cacheCreate1h) for accurate cost estimates.
 *  - There is no billed-cost ground truth here (subscription plans have no
 *    per-token invoice), so actualCost/actualCostDay stay null and every
 *    dollar figure is the LIST-PRICE VALUE of the tokens consumed — the same
 *    framing ccusage uses. estCostDay carries the adapter's own estimate for
 *    the history/anomaly features.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { PRICE, PRICE_META, normalizeModel, priceFor } from "./pricing.mjs";
import { colorFor, DEFAULT_COLOR } from "./palette.mjs";

export const DEFAULT_ROOT = join(homedir(), ".claude", "projects");

const num = (v) => (v == null ? 0 : Number(v) || 0);

/* Parse one transcript line into a usage entry, or null. Exported for tests. */
export function parseLine(line, dirName) {
  if (!line.includes('"assistant"')) return null;
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type !== "assistant") return null;
  const msg = d.message;
  const u = msg && msg.usage;
  if (!u) return null;
  const model = msg.model;
  if (!model || model === "<synthetic>") return null;
  const ts = d.timestamp;
  if (!ts || ts.length < 10) return null;
  const cc = u.cache_creation || {};
  return {
    key: `${msg.id || d.uuid}:${d.requestId || ""}`,
    date: ts.slice(0, 10),
    model: normalizeModel(model),
    dirName,
    cwd: d.cwd || null,
    tier: (u.service_tier || "standard").toLowerCase(),
    fresh: num(u.input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    cacheCreate1h: num(cc.ephemeral_1h_input_tokens),
    output: num(u.output_tokens),
  };
}

/* Scan every project's session files. Files whose mtime predates the window
 * are skipped without being read. */
export async function scanClaudeCode({ root = DEFAULT_ROOT, days = 90, now = new Date() } = {}) {
  const cutoffMs = now.getTime() - days * 86400_000;
  const entries = [];
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch { return entries; } // no ~/.claude/projects — not a Claude Code machine
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(root, dir.name);
    let files;
    try { files = await readdir(dirPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const p = join(dirPath, file);
      try {
        const st = await stat(p);
        if (!st.isFile() || st.mtimeMs < cutoffMs) continue;
        const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
        for await (const line of rl) {
          const e = parseLine(line, dir.name);
          if (e) entries.push(e);
        }
      } catch { /* unreadable file — skip */ }
    }
  }
  return entries;
}

/* Pure fold: entries -> the dashboard's data.json shape. */
export function foldClaudeCode(entries, { days = 90, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const seen = new Set();
  const dayMap = new Map();   // date -> Map(dirName -> agg)
  const cwdVotes = new Map(); // dirName -> Map(basename(cwd) -> count)

  for (const e of entries) {
    if (e.date < cutoff) continue;
    if (seen.has(e.key)) continue; // duplicate write of the same message
    seen.add(e.key);

    if (e.cwd) {
      if (!cwdVotes.has(e.dirName)) cwdVotes.set(e.dirName, new Map());
      const votes = cwdVotes.get(e.dirName);
      const name = basename(e.cwd);
      votes.set(name, (votes.get(name) || 0) + 1);
    }

    if (!dayMap.has(e.date)) dayMap.set(e.date, new Map());
    const wsBucket = dayMap.get(e.date);
    if (!wsBucket.has(e.dirName)) {
      wsBucket.set(e.dirName, {
        tok: { fresh: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, output: 0 },
        tierTok: { standard: 0, batch: 0, priority: 0 },
        modelTok: {},
        estCost: 0,
      });
    }
    const agg = wsBucket.get(e.dirName);
    agg.tok.fresh += e.fresh / 1e6;
    agg.tok.cacheRead += e.cacheRead / 1e6;
    agg.tok.cacheCreate += e.cacheCreate / 1e6;
    agg.tok.cacheCreate1h += e.cacheCreate1h / 1e6;
    agg.tok.output += e.output / 1e6;
    const tot = (e.fresh + e.cacheRead + e.cacheCreate + e.output) / 1e6;
    const tierName = e.tier === "batch" ? "batch" : e.tier === "priority" ? "priority" : "standard";
    agg.tierTok[tierName] += tot;
    agg.modelTok[e.model] = (agg.modelTok[e.model] || 0) + tot;
    // per-entry list-price estimate at the entry's own model, 1h-write aware
    const pr = priceFor(e.model, e.date);
    const cc5m = Math.max(0, e.cacheCreate - e.cacheCreate1h);
    agg.estCost += (e.fresh * pr.in + e.cacheRead * pr.read +
      cc5m * pr.write + e.cacheCreate1h * pr.write * 1.6 + e.output * pr.out) / 1e6;
  }

  // display name per project dir: majority basename(cwd), else the raw dir name
  const nameOf = (dirName) => {
    const votes = cwdVotes.get(dirName);
    if (!votes || !votes.size) return dirName;
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  // stable colors, sorted by dir name
  const allDirs = [...new Set([...dayMap.values()].flatMap((m) => [...m.keys()]))].sort();
  const colorMap = new Map(allDirs.map((d, i) => [d, colorFor(i, false)]));

  const sortedDays = [...dayMap.keys()].sort();
  const outDays = sortedDays.map((date, dayIndex) => {
    const wsBucket = dayMap.get(date);
    let estCostDay = 0;
    const projs = [...wsBucket.entries()].map(([dirName, agg]) => {
      const model = Object.entries(agg.modelTok).sort((a, b) => b[1] - a[1])[0]?.[0] || "claude-sonnet-5";
      const tierTotal = agg.tierTok.standard + agg.tierTok.batch + agg.tierTok.priority || 1;
      estCostDay += agg.estCost;
      return {
        id: null, // null id = "not an API workspace" — recs show Claude Code guidance
        name: nameOf(dirName),
        color: colorMap.get(dirName) || DEFAULT_COLOR,
        model,
        tok: agg.tok,
        tiers: {
          standard: agg.tierTok.standard / tierTotal,
          batch: agg.tierTok.batch / tierTotal,
          priority: agg.tierTok.priority / tierTotal,
        },
        env: { dev: 1, prod: 0 }, // local Claude Code work is development by definition
        actualCost: null,         // no invoice exists — subscription usage
      };
    });
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    return { dayIndex, weekday: dow >= 1 && dow <= 5, date, projs,
             actualCostDay: null, estCostDay };
  });

  return {
    days: outDays, DAYS: outDays.length,
    source: "claude-code", generatedAt: new Date().toISOString(),
    prices: PRICE, priceMeta: PRICE_META,
  };
}
