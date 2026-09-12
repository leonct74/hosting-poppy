// Assembling the user's built website out of the pieces the browser sends us.
//
// Two constraints shape this file, and neither is negotiable:
//
//  - CONFINEMENT. This backend cannot read the user's disk, so it can never be handed a
//    path. The user picks their built site in the frontend's file picker — the one handover
//    a confined backend is allowed, because the browser gives us bytes the user chose
//    rather than bytes we went looking for (DESIGN §4).
//  - THE HOST BRIDGE carries one message at a time, and a built site routinely runs to tens
//    of megabytes. So the bytes arrive as a numbered series of chunks, which is also what
//    makes an honest progress bar possible. They land in a staging file under dataDir
//    rather than in memory: holding a whole site as Buffers while AWS calls are in flight
//    is how a backend gets OOM-killed halfway through a deploy.
//
// The rejection rules matter more than the happy path. A dropped or repeated chunk still
// produces an archive Amplify will happily accept and expand — and the user gets a live
// website, on their own address, with half its JavaScript missing. Refusing at upload time
// is enormously better than deploying that, so every doubt here ends the upload.
//
// Everything below is synchronous on purpose. With no `await` between the ordering check
// and the write, two chunk requests cannot interleave: Node's single thread enforces the
// next-index invariant, instead of a lock we would have to get right. The files are
// short-lived and the writes are one chunk each, so the event loop pause is small.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataPath, removeFile } from "./storage";

/**
 * The ceiling on one website's archive. This limit is OURS, not AWS's: the bytes cross the
 * host bridge and are held as a single Buffer for the upload to Amplify, and that is what
 * we are protecting. A built SPA is normally a few megabytes, so reaching 150 MB nearly
 * always means something that does not belong in a build folder came along for the ride —
 * which is exactly what the message says. Raise it here if a real user ever needs more.
 */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

/** How long a started-but-unfinished upload is kept before it is swept (see sweepStale). */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** The subfolder of dataDir where chunks are assembled. Exported so tests need not guess. */
export const UPLOADS_DIR = "uploads";

const PART_SUFFIX = ".part";

const TOO_LARGE = `Your site is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB — remove big files like videos, raw images or source maps from the folder and try again.`;
const INCOMPLETE = "Your files didn't arrive in one piece — choose your site files again.";
const UNKNOWN = "That upload has already finished or expired — choose your site files again.";

interface Staged {
  id: string;
  siteId: string;
  declaredBytes: number;
  receivedBytes: number;
  /** The only index we will accept next: chunks must arrive in order, exactly once each. */
  nextIndex: number;
  startedAt: number;
  path: string;
}

const staging = new Map<string, Staged>();

function stagingPath(id: string): string {
  return dataPath(UPLOADS_DIR, `${id}${PART_SUFFIX}`);
}

/**
 * Open a staging file for one website's archive.
 *
 * The file is created empty right away rather than on the first chunk, so a data folder we
 * cannot write to is discovered here — before the user waits through an entire upload to
 * find out.
 */
export function beginUpload(siteId: string, declaredBytes: number): { uploadId: string } {
  if (!siteId) throw new Error("Choose which website to deploy to before uploading your files.");
  const size = Math.floor(Number(declaredBytes));
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("That folder looks empty — choose the folder your build produced and try again.");
  }
  if (size > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE);

  // We are already touching this folder, so this is the cheapest possible moment to clear
  // out uploads the user walked away from. It also means the backend needs no timers: a
  // pending timer in a confined backend is one more reason for the process to stay alive.
  sweepStale(UPLOAD_TTL_MS);

  const id = randomUUID();
  const path = stagingPath(id);
  try {
    mkdirSync(dataPath(UPLOADS_DIR), { recursive: true });
    writeFileSync(path, ""); // truncates too, so a leftover with this name can never be appended to
  } catch {
    throw new Error("HostingPoppy couldn't get ready to receive your files — reopen it from AgentsPoppy and try again.");
  }
  staging.set(id, { id, siteId, declaredBytes: size, receivedBytes: 0, nextIndex: 0, startedAt: Date.now(), path });
  return { uploadId: id };
}

/**
 * Add the next chunk. Anything unexpected — a gap, a repeat, more bytes than were promised
 * — ends the upload rather than storing something we would later deploy as a website.
 */
export function appendChunk(uploadId: string, index: number, data: Buffer): { receivedBytes: number } {
  const up = staging.get(uploadId);
  if (!up) throw new Error(UNKNOWN);

  if (index !== up.nextIndex) {
    // Out of order, or the same chunk twice. Either way the archive would be wrong, and a
    // wrong archive is a broken live website — so we stop instead of guessing.
    abandonUpload(uploadId);
    throw new Error(INCOMPLETE);
  }

  const total = up.receivedBytes + data.length;
  if (total > MAX_UPLOAD_BYTES) {
    abandonUpload(uploadId);
    throw new Error(TOO_LARGE);
  }
  if (total > up.declaredBytes) {
    // More bytes than the frontend said it would send: the two sides disagree about what
    // this file is, and only one of them can be right.
    abandonUpload(uploadId);
    throw new Error(INCOMPLETE);
  }

  try {
    appendFileSync(up.path, data);
  } catch {
    abandonUpload(uploadId);
    throw new Error("There isn't enough room on this computer to hold your site while it uploads — free up some space and try again.");
  }

  up.receivedBytes = total;
  up.nextIndex += 1;
  return { receivedBytes: total };
}

/**
 * Hand back the assembled archive and let go of the staging file.
 *
 * This is the one moment the whole site is in memory — unavoidable, since the upload to
 * Amplify needs a body — which is the other half of the reason for MAX_UPLOAD_BYTES.
 */
export function finishUpload(uploadId: string): Buffer {
  const up = staging.get(uploadId);
  if (!up) throw new Error(UNKNOWN);

  if (up.receivedBytes !== up.declaredBytes) {
    abandonUpload(uploadId);
    throw new Error(INCOMPLETE);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(up.path);
  } catch {
    abandonUpload(uploadId);
    throw new Error("HostingPoppy couldn't read the files you uploaded — choose your site files again.");
  }

  // Drop the staging copy before the last check, so no path out of this function leaves a
  // site-sized file on the user's disk.
  abandonUpload(uploadId);
  if (bytes.length !== up.declaredBytes) throw new Error(INCOMPLETE);
  return bytes;
}

/** Forget an upload and delete its staging file. Safe to call twice, and never throws. */
export function abandonUpload(uploadId: string): void {
  const up = staging.get(uploadId);
  staging.delete(uploadId);
  if (up) removeFile(up.path);
}

/**
 * Delete uploads nobody is going to finish.
 *
 * Called at boot, which is the case that matters: after a restart the map is empty but the
 * staging files are not, and nothing else in the poppy would ever delete them — an
 * abandoned 150 MB upload would sit in the user's data folder for good. `now` is injectable
 * so tests can age a file without waiting for one.
 */
export function sweepStale(maxAgeMs: number, now: number = Date.now()): void {
  for (const [id, up] of [...staging]) {
    if (now - up.startedAt > maxAgeMs) abandonUpload(id);
  }

  const live = new Set([...staging.values()].map((u) => u.path));
  const dir = dataPath(UPLOADS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no uploads folder yet, or one we cannot read — nothing to sweep either way
  }
  for (const name of names) {
    if (!name.endsWith(PART_SUFFIX)) continue;
    const path = join(dir, name);
    if (live.has(path)) continue; // an upload in flight, however long it has been going
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) removeFile(path);
    } catch {
      // Vanished under us or unreadable: either way it is not ours to worry about.
    }
  }
}
