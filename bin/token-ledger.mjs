#!/usr/bin/env node
/**
 * token-ledger CLI — the npx entry point.
 *
 *   npx token-ledger                # fetch (auto-source) + serve + open browser
 *   npx token-ledger fetch          # refresh data only
 *   npx token-ledger serve          # serve the dashboard only
 *
 * Flags pass through to the fetch: --claude-code, --fixture, --days N.
 * Data source auto-detection: an Admin key in $LEDGER_HOME/.env → org API
 * data; otherwise local Claude Code sessions (~/.claude/projects); otherwise
 * the bundled sample. Nothing ever leaves the machine.
 *
 * User data lives in LEDGER_HOME (default ~/.token-ledger) so it survives
 * npx cache churn: data.json, snapshots/, and your .env go there.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

if (!process.env.LEDGER_HOME) {
  process.env.LEDGER_HOME = join(homedir(), ".token-ledger");
}

const cmd = process.argv.slice(2).find((a) => !a.startsWith("--")) || "start";
const PORT = Number(process.env.PORT || 4319);

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(opener, [url], { detached: true, stdio: "ignore" }).unref(); } catch {}
}

if (cmd === "fetch" || cmd === "start") {
  const { main } = await import("../scripts/fetch-usage.mjs");
  await main();
}

if (cmd === "serve" || cmd === "start") {
  await import("../scripts/serve.mjs"); // starts listening on import
  setTimeout(() => openBrowser(`http://localhost:${PORT}`), 300);
}

if (!["fetch", "serve", "start"].includes(cmd)) {
  console.error(`Unknown command "${cmd}". Usage: token-ledger [fetch|serve|start] [--claude-code|--fixture|--days N]`);
  process.exitCode = 1;
}
