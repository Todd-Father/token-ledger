#!/usr/bin/env node
/**
 * serve.mjs — tiny zero-dependency static server for the dashboard.
 * Browsers block fetch() over file://, so the dashboard needs to be served
 * over http to load data.json. This does exactly that, nothing more.
 *   node scripts/serve.mjs            -> http://localhost:4319
 *   PORT=8080 node scripts/serve.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// User data (data.json, snapshots/) may live outside the package — see
// LEDGER_HOME in fetch-usage.mjs. Assets always come from the package.
const HOME = process.env.LEDGER_HOME || ROOT;
const PORT = Number(process.env.PORT || 4319);
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    // data files resolve from HOME first (falling back to the package for the
    // bundled sample); everything else is served from the package root.
    const isData = /^\/data(\.[a-z]+)?\.json$/.test(rel) || rel.startsWith("/snapshots/");
    const bases = isData && HOME !== ROOT ? [HOME, ROOT] : [ROOT];
    let body = null, ext = "." + rel.split(".").pop();
    for (const base of bases) {
      const path = normalize(join(base, rel));
      if (!path.startsWith(base)) { res.writeHead(403); return res.end("forbidden"); }
      try { body = await readFile(path); break; } catch { /* try next base */ }
    }
    if (body == null) throw new Error("not found");
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // A dashboard is already serving on this port — that's fine, not an error.
    console.log(`Token Ledger is already running → http://localhost:${PORT}`);
    console.log(`(To restart it, stop the old one:  lsof -ti:${PORT} | xargs kill)`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`Token Ledger → http://localhost:${PORT}`);
  console.log("Ctrl-C to stop.");
});
