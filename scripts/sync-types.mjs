#!/usr/bin/env node
/**
 * Keep the frontend's copy of the wire contract identical to the backend's.
 *
 * WHY THIS EXISTS: backend/src/types.ts and frontend/src/types.ts describe the same JSON
 * crossing the host bridge, but they are separate builds, so nothing type-checks them against
 * each other — a field added on one side is invisible on the other, and TypeScript stays happy
 * while the product quietly breaks.
 *
 * That is not hypothetical. Adding the GitHub path put `source`, `repository` and `branch` on
 * the backend's Site and not the frontend's, and every defect that followed — a connected site
 * offered the zip upload, a deploy poll that never sent the branch, a screen claiming files were
 * "sent from this computer" — was downstream of those three missing fields. Both files carried a
 * comment saying "keep them in step". A comment is not a mechanism.
 *
 * So the backend file is the source of truth and the frontend's is generated from it:
 *   node scripts/sync-types.mjs            regenerate
 *   node scripts/sync-types.mjs --check    fail if it has drifted (runs before test + build)
 *
 * Same shape as the fleet's sync-feedback-tab.mjs, for the same reason.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "backend", "src", "types.ts");
const DEST = join(root, "frontend", "src", "types.ts");

const HEADER = [
  "// GENERATED — do not edit. Run `npm run sync-types` after changing the backend's types.ts.",
  "//",
  "// This is the wire contract, copied verbatim from backend/src/types.ts. It is generated",
  "// rather than maintained because the two sides are separate builds: nothing would catch a",
  "// field that exists on one and not the other, and that drift has already cost this repo a",
  "// round of user-visible bugs.",
  "",
].join("\n");

const source = readFileSync(SOURCE, "utf8");
// Drop the source file's own header comment; the generated header replaces it.
const body = source.replace(/^\/\/[^\n]*\n(\/\/[^\n]*\n)*/, "");
const generated = `${HEADER}${body}`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(DEST, "utf8");
  } catch {
    /* missing counts as drifted */
  }
  if (current !== generated) {
    console.error(
      "sync-types: frontend/src/types.ts has drifted from backend/src/types.ts.\n" +
        "  Run `npm run sync-types` and commit the result.\n" +
        "  (This check exists because the drift it catches has shipped real bugs — see the header.)",
    );
    process.exit(1);
  }
  console.log("✓ the frontend's wire contract matches the backend's");
} else {
  writeFileSync(DEST, generated);
  console.log(`✅ frontend/src/types.ts regenerated from backend/src/types.ts`);
}
