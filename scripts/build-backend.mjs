#!/usr/bin/env node
// Bundle the HostingPoppy backend into the single CJS file AgentsPoppy's SHARED Node
// runtime executes (extension.json `backend.runtime: "node22"` — agentspoppy
// docs/RUNTIMES.md, rule R1: a poppy ships its own code and never a runtime).
//
// There is no generated template or Lambda zip to embed here: HostingPoppy provisions
// Amplify Hosting through the SDK, so the bundle is nothing but our own source plus the
// AWS SDK client it calls (DESIGN.md §3). That is also why this poppy has no
// stale-embedded-bundle trap — the family's most expensive recurring gotcha.
import * as esbuild from "esbuild";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "backend", "index.cjs");

await esbuild.build({
  entryPoints: [join(root, "backend", "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  logLevel: "warning",
});
console.log(`✅ backend bundle → ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`);
