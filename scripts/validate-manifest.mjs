#!/usr/bin/env node
/**
 * Validate extension.json: structure via the REAL AgentsPoppy SDK validator, and
 * listability via the SHARED listing gate (@agentspoppy/core listingGate.ts) — the ONE
 * place the fail rules live (agentspoppy docs/specs/rating-reconciliation.md, fix 3).
 *
 * THIS FILE IS A THIN LOADER, IDENTICAL IN EVERY POPPY REPO — do not add rules here.
 * A rule added locally is invisible to every other repo and to review: that is the
 * drift disease this loader exists to end. Rules go in listingGate.ts, with tests.
 *
 *   npm run validate-manifest [-- path/to/extension.json]
 *
 * Bundles from the agentspoppy checkout's TypeScript SOURCE (never a dist/), so it
 * doesn't depend on the sibling checkout's build state. Override the checkout location
 * with AGENTSPOPPY_REPO. Exit 1 on any problem — CI-friendly, every problem at once.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(process.argv[2] ?? join(root, "extension.json"));
const sdkRepo = resolve(process.env.AGENTSPOPPY_REPO ?? join(root, "..", "agentspoppy"));

async function loadFromSource(relEntry, label) {
  const entry = join(sdkRepo, relEntry);
  if (!existsSync(entry)) {
    console.error(`validate-manifest: can't find the AgentsPoppy ${label} at ${entry}.\n  Point AGENTSPOPPY_REPO at your agentspoppy checkout.`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "poppy-gate-"));
  const outfile = join(dir, "mod.mjs");
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

const { parseManifest } = await loadFromSource("packages/extension-sdk/src/index.ts", "extension SDK");
const { assessListing } = await loadFromSource("packages/core/src/listingGate.ts", "listing gate");
const { assessPermissionSet } = await loadFromSource("packages/core/src/permissions.ts", "permission assessor");

let manifest;
try {
  manifest = parseManifest(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`✗ ${manifestPath}\n  ${e.message}`);
  process.exit(1);
}
console.log(`✅ ${manifestPath} — structure OK`);

// Context: the rating the user will see (display only — the gate below is the contract;
// colour is NOT a pass/fail signal, see AGENTS.md's acceptance-test note).
const risk = assessPermissionSet(manifest.permissionSet);
for (const { grant, risk: gr } of risk.grants) {
  console.log(`   ${gr.scoped ? "·" : "!"} ${grant.service}: ${gr.level.padEnd(6)} ${gr.reason}`);
}

const gate = assessListing(manifest.permissionSet);
for (const n of gate.notes) console.log(`\n⚠️  ${n}`);
if (gate.problems.length > 0) {
  console.error(`\n✗ not listable (${gate.problems.length} problem${gate.problems.length === 1 ? "" : "s"}):`);
  for (const p of gate.problems) console.error(`   ✗ ${p}`);
  process.exit(1);
}
console.log(`\n✅ listing gate: pass — rating shown to users: ${risk.level}`);
