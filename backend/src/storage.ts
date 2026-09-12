// WHERE HostingPoppy keeps the little it has to remember between launches.
//
// HostingPoppy is CONFINED from its very first release (extension.json
// `backend.isolation: "strict"`): Node's permission model lets this process read only its
// own install folder and write only the private folder the host hands us in
// AGENTSPOPPY_BOOTSTRAP (`dataDir`), plus the OS temp dir. The user's home directory might
// as well not exist.
//
// That is why this file is so much shorter than its ancestors. MailPoppy 0.1.16 and
// TrafficPoppy 0.2.4 each carry a one-time copy out of a pre-confinement `~/.<poppy>`
// folder, and that copy is only possible because those poppies shipped unconfined first.
// HostingPoppy never had that earlier life: **there is no legacy home, and this module must
// never go looking for one** — under `--permission` a probe into the home directory raises
// ERR_ACCESS_DENIED instead of answering "no", so the search would cost a crash and could
// never find anything.
//
// Nothing kept here is authoritative. The user's websites are Amplify apps in their own AWS
// account and are always read back from AWS (AGENTS.md §5 — reconstruct state from the
// cloud, never from a local flag), so these files hold only conveniences: a display
// timeline, an upload in flight. Every read below fails safe to a default rather than
// throwing, because a file we corrupted on a bad shutdown must never stand between the user
// and their live websites.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where we land when the host sent no `dataDir`. A host that old also predates
 * `backend.isolation`, so it runs us unconfined and this path is writable — but the OS
 * clears its temp folder whenever it likes, so callers should say so rather than promise
 * the timeline will still be there tomorrow.
 */
const TEMP_HOME = join(tmpdir(), "hostingpoppy");

let home: string | null = null;
let temporary = false;

/**
 * Point storage at the host's per-poppy folder. Runs once at boot, before any route: every
 * other function here needs an answer to "where", and the alternative — each caller
 * resolving its own path — is how two modules end up disagreeing about it.
 */
export function initStorage(dataDir: string | undefined): void {
  home = dataDir || TEMP_HOME;
  temporary = !dataDir;
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // The host normally creates this folder (0700) before spawning us, so a failure here
    // means something is badly wrong with the machine. We still boot: the helpers below all
    // fail safe, so the user still reaches their websites (which live in AWS) and loses
    // only the local timeline.
  }
}

/**
 * True when we fell back to the OS temp folder. Callers may want to tell the user their
 * local history is temporary — but must never treat it as an error: the websites
 * themselves are unaffected, so a warning is honest and a crash would be a lie.
 */
export function usingTemporaryStorage(): boolean {
  return temporary;
}

/** The folder every other path is built from. */
export function storageHome(): string {
  if (!home) {
    throw new Error("HostingPoppy used its storage before initStorage() ran — that is a bug in the backend, not something you can fix.");
  }
  return home;
}

export function dataPath(...parts: string[]): string {
  return join(storageHome(), ...parts);
}

/**
 * `existsSync` that cannot throw.
 *
 * 🪤 Under `--permission`, `existsSync` on a DENIED path throws ERR_ACCESS_DENIED instead of
 * returning false — measured across the fleet in 2026-08, and it cost real debugging time
 * every time a poppy rediscovered it (MailPoppy's permission lights went dark, VM-Poppy's
 * readiness route 500'd). Every existence probe in this backend goes through here, so a
 * denied probe reads as "not there" instead of taking down the request.
 */
export function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Delete a file if it is there, and say nothing if it is not. */
export function removeFile(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // Already gone, never existed, or denied — all three mean "not our problem any more".
  }
}

/**
 * Read a JSON file, or the fallback. Missing, unreadable, half-written by a process that
 * was killed, hand-edited into nonsense — one answer for all of them, because a local file
 * is never worth an error page in front of the user's websites.
 */
export function readJson<T>(path: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file, reporting success rather than throwing — every caller here is doing
 * something for the user's benefit alongside real work, and none of them should fail
 * because a note couldn't be saved.
 *
 * Written to a sibling and renamed into place: rename within one filesystem is atomic, so a
 * reader (or a crash) sees either the old file or the new one, never a truncated one. That
 * is what lets readJson treat "unparseable" as a genuinely exceptional case.
 */
export function writeJson(path: string, value: unknown): boolean {
  const staging = `${path}.writing`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
    renameSync(staging, path);
    return true;
  } catch {
    removeFile(staging); // never leave half a file behind to be found later
    return false;
  }
}
