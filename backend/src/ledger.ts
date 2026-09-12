// The running note of what HostingPoppy created and removed in the user's account — the
// timeline under "Everything HostingPoppy created in your account — nothing hidden"
// (UX.md S9, the one screen where real AWS names are allowed).
//
// This ledger is for TRANSPARENCY ONLY, and that is a deliberate difference from
// MailPoppy's, where teardown REPLAYS the ledger to find the SES identities and DNS records
// to delete — lose that file there and live infrastructure is stranded in the account. Here
// the truth about what exists is AWS itself: every website is an Amplify app born carrying
// our tags, so "Remove everything" is a ListApps tag sweep (PLAN §2) that works perfectly on
// a machine that has never seen this file. That is what makes the two rules below safe:
//
//  - A failed write is swallowed, never thrown at the caller. The user is watching a deploy;
//    it must not fail because a line of history couldn't be saved.
//  - The file is capped. Append-only with nothing ever pruning it is a slow disk leak, and
//    the tab only ever shows recent history anyway.
//
// Entries are stored oldest-first, the way a diary reads; the view reverses them.

import type { LedgerEntry } from "./types";
import { dataPath, readJson, writeJson } from "./storage";

export const LEDGER_FILE = "ledger.json";

/**
 * Roughly a year of ordinary use for someone with a handful of websites, and a few hours of
 * a runaway loop. Old entries fall off the front rather than the back: the recent past is
 * what a transparency timeline is for.
 */
export const MAX_LEDGER_ENTRIES = 500;

const ACTIONS: ReadonlySet<string> = new Set<LedgerEntry["action"]>([
  "created",
  "removed",
  "deployed",
  "domain-attached",
  "domain-removed",
]);

/** What we are prepared to show the user as history. */
export function isLedgerEntry(value: unknown): value is LedgerEntry {
  const e = value as Partial<LedgerEntry> | null;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.at === "string" &&
    typeof e.what === "string" &&
    typeof e.action === "string" &&
    ACTIONS.has(e.action) &&
    (e.detail === undefined || typeof e.detail === "string")
  );
}

function ledgerPath(): string {
  return dataPath(LEDGER_FILE);
}

/**
 * Every entry we can still make sense of. Rows that fail the guard are dropped rather than
 * repaired: a hand-edited or half-recognised entry rendered into the Resources tab would be
 * a transparency claim we cannot stand behind, and one bad row must not hide the rest.
 */
export function readLedger(): LedgerEntry[] {
  const raw = readJson<unknown>(ledgerPath(), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLedgerEntry);
}

/** Note one thing that happened. Never throws — see the header. */
export function record(entry: Omit<LedgerEntry, "at"> & { at?: string }): void {
  recordAll([entry]);
}

/**
 * Note several things at once — one read-modify-write instead of several. Being synchronous
 * is what keeps that safe: two callers cannot interleave their read and write and lose an
 * entry between them.
 */
export function recordAll(entries: Array<Omit<LedgerEntry, "at"> & { at?: string }>): void {
  if (entries.length === 0) return;
  try {
    const now = new Date().toISOString();
    const next = [...readLedger(), ...entries.map((e) => ({ ...e, at: e.at ?? now }))];
    writeJson(ledgerPath(), next.slice(-MAX_LEDGER_ENTRIES));
  } catch {
    // Transparency is best-effort; the user's deploy is not.
  }
}
