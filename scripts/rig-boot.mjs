#!/usr/bin/env node
/**
 * Boot the built backend the way AgentsPoppy boots it — CONFINED — and prove it works.
 *
 * A poppy that declares `"isolation": "strict"` is run by the host under Node's permission
 * model, and that model is allowlist-only: the backend may read its own install folder, and
 * read+write its data folder and the OS temp dir. Everything else — the user's home, and
 * `~/.aws/credentials` above all — is denied by the RUNTIME, not by our good behaviour.
 *
 * The flags below are copied from the host's own `confinementOptions`
 * (agentspoppy/packages/broker/src/extensions/backend-host.ts). Two subtleties are load-bearing
 * and both cost the family a debugging session when missed:
 *   - the permission model resolves symlinks, and macOS's temp dir IS one
 *     (/var/folders/… → /private/var/folders/…), so both spellings must be granted;
 *   - a bare directory grants only the directory entry — `dir/*` is how this model spells
 *     "and everything inside it".
 *
 * Run:  node scripts/rig-boot.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "backend", "index.cjs");
if (!existsSync(entry)) {
  console.error("rig-boot: backend/index.cjs is missing — run `npm run build:backend` first.");
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "hostingpoppy-rig-"));
const tmp = tmpdir();

const grantsFor = (kind, dir) => {
  const paths = new Set([dir]);
  try {
    paths.add(realpathSync(dir));
  } catch {
    /* not created yet — the literal path is still worth granting */
  }
  return [...paths].flatMap((p) => [`--allow-fs-${kind}=${p}`, `--allow-fs-${kind}=${join(p, "*")}`]);
};

const nodeOptions = [
  "--permission",
  ...[root, dataDir, tmp].flatMap((p) => grantsFor("read", p)),
  ...[dataDir, tmp].flatMap((p) => grantsFor("write", p)),
].join(" ");

/**
 * A stand-in for the host's credential minter. The rig never hands out real AWS credentials —
 * it answers 403, which is also a useful test: every AWS-touching route must degrade into a
 * calm sentence rather than an unhandled rejection.
 */
const broker = createServer((_req, res) => {
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: "the rig grants no AWS access" }));
});
await new Promise((r) => broker.listen(0, "127.0.0.1", r));
const brokerPort = broker.address().port;

const port = 41731;
const bootstrap = {
  connectionId: "rig-connection",
  credentialsUrl: `http://127.0.0.1:${brokerPort}/credentials`,
  credentialsToken: "rig-token",
  port,
  dataDir,
  account: { accountId: "000000000000", region: "eu-west-1" },
};

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, NODE_OPTIONS: nodeOptions, AGENTSPOPPY_BOOTSTRAP: JSON.stringify(bootstrap) },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n--- backend output ---\n${out.trim() || "(nothing)"}`);
  child.kill();
  broker.close();
  process.exit(1);
};

const deadline = Date.now() + 15_000;
let meta = null;
for (;;) {
  if (child.exitCode !== null) fail(`the backend exited with code ${child.exitCode} instead of listening.`);
  if (Date.now() > deadline) fail("the backend never answered on its port within 15s.");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/meta`);
    if (res.ok) {
      meta = await res.json();
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

console.log("✅ confined boot: the backend started under --permission and answered /meta");
console.log(`   ${JSON.stringify(meta)}`);

// With no AWS access the rig's broker refuses every mint, so this must come back as a calm
// sentence with an ordinary status — never a crash, and never a raw AWS stack trace.
const sites = await fetch(`http://127.0.0.1:${port}/sites`);
const body = await sites.text();
if (child.exitCode !== null) fail("listing sites without AWS access killed the backend.");
if (/\bat .*\(.*:\d+:\d+\)/.test(body)) fail(`a raw stack trace reached the client:\n${body}`);
console.log(`✅ no AWS access degrades calmly: ${sites.status} ${body.slice(0, 160)}`);

child.kill();
broker.close();
console.log("\n✅ rig passed");
