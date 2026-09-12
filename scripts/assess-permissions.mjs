#!/usr/bin/env node
/**
 * Manifest permission gate — run our extension.json's permissionSet through the REAL
 * `assessPermissionSet` from AgentsPoppy's core, and FAIL (exit 1) on any red (high)
 * finding. This is the P0 rating gate (DESIGN.md §9): HostingPoppy must rate amber/green with
 * no beyond-own findings.
 *
 * It guards specifically against the family "substring trap" (DESIGN.md §9, VM-Poppy DR3):
 * the assessor matches mutating verbs by SUBSTRING, so `GetConsoleOutput` contains "put"
 * and reads as mutating — on a "*" scope that would rate RED. Placed in a tagged-as-self
 * grant it's a benign amber. If someone moves it, this gate catches it before install.
 *
 * Run from the repo root:  npm run assess-permissions
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, "..");

// AgentsPoppy is a sibling checkout; its core package holds the assessor the host uses.
const AGENTSPOPPY = process.env.AGENTSPOPPY_DIR || resolvePath(repoRoot, "..", "agentspoppy");
const ASSESSOR = pathToFileURL(join(AGENTSPOPPY, "packages", "core", "dist", "permissions.js")).href;

// Let Node resolve core's extensionless relative imports, then load the real assessor.
register(pathToFileURL(join(here, "lib", "append-js-loader.mjs")));
const { assessPermissionSet } = await import(ASSESSOR);

const manifest = JSON.parse(readFileSync(join(repoRoot, "extension.json"), "utf8"));
const ps = manifest.permissionSet;
const actionCount = ps.grants.reduce((n, g) => n + g.actions.length, 0);
const risk = assessPermissionSet(ps);

console.log(`HostingPoppy permission set — ${ps.grants.length} grants, ${actionCount} actions`);
for (const { grant, risk: r } of risk.grants) {
  const mark = r.level === "high" ? "🔴" : r.level === "medium" ? "🟠" : "🟢";
  console.log(`  ${mark} [${r.level}] ${grant.service}:${grant.actions.join(",")} (${grant.resourceScope})`);
}
for (const w of risk.warnings) console.log(`  ⚠️  ${w}`);

/**
 * The untaggable-create gate.
 *
 * The broker compiles every action matching /:(Create|Request)/ inside a `tagged-as-self` grant
 * into a statement conditioned on `aws:RequestTag/agentspoppy:app` — the born-tagged-or-refused
 * rule. The bucket is chosen by the ACTION NAME, so an AWS API that accepts no tags can never
 * satisfy the condition and every call is refused with AccessDenied. It is invisible offline: the
 * manifest validates, the rating is amber, the unit tests pass, and the poppy fails the first
 * time a real user tries to deploy.
 *
 * HostingPoppy shipped that bug for exactly one commit (CreateDeployment and
 * CreateDomainAssociation sat in the tagged grant), so the list below is the fix made permanent:
 * a create may live in a tagged-as-self grant ONLY if its SDK request type has a `tags` field,
 * verified against @aws-sdk/client-* dist-types. Add to it only after checking the same way.
 */
const BIRTH_TAGGABLE_CREATES = new Set([
  "amplify:CreateApp",
  "amplify:CreateBranch",
]);

const untaggable = [];
for (const g of ps.grants) {
  if (g.resourceScope !== "tagged-as-self") continue;
  for (const a of g.actions) {
    const qualified = a.includes(":") ? a : `${g.service.toLowerCase()}:${a}`;
    if (/:(Create|Request)/.test(qualified) && !BIRTH_TAGGABLE_CREATES.has(qualified)) {
      untaggable.push(qualified);
    }
  }
}
if (untaggable.length > 0) {
  console.error(
    `\n❌ ${untaggable.length} create action(s) in a tagged-as-self grant are not known to accept ` +
      `tags at creation:\n   ${untaggable.join("\n   ")}\n` +
      `   IAM will refuse every one of these calls (aws:RequestTag can't match a request with no tags).\n` +
      `   Either confirm the SDK request type has a \`tags\` field and add it to BIRTH_TAGGABLE_CREATES,\n` +
      `   or move the action to a name-scoped grant.`,
  );
  process.exit(1);
}
console.log(`  ✓ every create in a tagged grant accepts tags at creation (${BIRTH_TAGGABLE_CREATES.size} known)`);

const reds = risk.grants.filter((g) => g.risk.level === "high");
if (reds.length > 0) {
  console.error(`\n❌ ${reds.length} RED finding(s): a grant can mutate resources beyond its own. Tighten resourceScope.`);
  process.exit(1);
}
console.log(`\n✅ Overall: ${risk.level.toUpperCase()} — no red findings (no risks to other resources).`);
