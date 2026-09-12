import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataPath, initStorage } from "./storage";
import {
  MAX_UPLOAD_BYTES,
  UPLOADS_DIR,
  abandonUpload,
  appendChunk,
  beginUpload,
  finishUpload,
  sweepStale,
} from "./uploads";

/** The staging files still on disk — what "nothing left behind" is measured with. */
function partFiles(): string[] {
  try {
    return readdirSync(dataPath(UPLOADS_DIR)).filter((n) => n.endsWith(".part"));
  } catch {
    return [];
  }
}

beforeEach(() => {
  initStorage(mkdtempSync(join(tmpdir(), "hp-uploads-")));
});

describe("uploads", () => {
  it("assembles the chunks in order and hands back the whole archive", () => {
    const parts = [Buffer.from("PK-header"), Buffer.from("middle-bytes"), Buffer.from("tail")];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const { uploadId } = beginUpload("site-1", total);

    let received = 0;
    parts.forEach((p, i) => {
      received = appendChunk(uploadId, i, p).receivedBytes;
    });
    expect(received).toBe(total);

    expect(finishUpload(uploadId).toString()).toBe("PK-headermiddle-bytestail");
    expect(partFiles()).toEqual([]); // the site is not left sitting on the user's disk
  });

  it("stops an upload whose chunks arrive out of order", () => {
    const { uploadId } = beginUpload("site-1", 6);
    appendChunk(uploadId, 0, Buffer.from("abc"));
    expect(() => appendChunk(uploadId, 2, Buffer.from("def"))).toThrow(/didn't arrive in one piece/i);
    // The whole upload is dropped, not just that chunk — a resumed one would be missing a
    // piece, and a website missing a piece still deploys.
    expect(() => appendChunk(uploadId, 1, Buffer.from("def"))).toThrow(/already finished or expired/i);
    expect(partFiles()).toEqual([]);
  });

  it("stops an upload that repeats a chunk", () => {
    const { uploadId } = beginUpload("site-1", 6);
    appendChunk(uploadId, 0, Buffer.from("abc"));
    expect(() => appendChunk(uploadId, 0, Buffer.from("abc"))).toThrow(/didn't arrive in one piece/i);
    expect(partFiles()).toEqual([]);
  });

  it("stops an upload that sends more than it promised", () => {
    const { uploadId } = beginUpload("site-1", 4);
    expect(() => appendChunk(uploadId, 0, Buffer.from("far too many bytes"))).toThrow(/didn't arrive in one piece/i);
    expect(partFiles()).toEqual([]);
  });

  it("refuses to finish an upload that is short of what was promised", () => {
    const { uploadId } = beginUpload("site-1", 10);
    appendChunk(uploadId, 0, Buffer.from("abcd"));
    expect(() => finishUpload(uploadId)).toThrow(/didn't arrive in one piece/i);
    expect(partFiles()).toEqual([]);
  });

  it("refuses a site bigger than we can carry, and says what to do about it", () => {
    expect(() => beginUpload("site-1", MAX_UPLOAD_BYTES + 1)).toThrow(/150 MB/);
    expect(() => beginUpload("site-1", MAX_UPLOAD_BYTES + 1)).toThrow(/videos, raw images or source maps/);
    expect(partFiles()).toEqual([]);
  });

  it("refuses an empty or nonsensical size before anything is staged", () => {
    expect(() => beginUpload("site-1", 0)).toThrow(/looks empty/i);
    expect(() => beginUpload("site-1", Number.NaN)).toThrow(/looks empty/i);
    expect(() => beginUpload("site-1", -5)).toThrow(/looks empty/i);
    expect(() => beginUpload("", 10)).toThrow(/which website/i);
    expect(partFiles()).toEqual([]);
  });

  it("treats an unknown or already-finished upload as expired", () => {
    expect(() => appendChunk("no-such-upload", 0, Buffer.from("x"))).toThrow(/already finished or expired/i);
    expect(() => finishUpload("no-such-upload")).toThrow(/already finished or expired/i);

    const { uploadId } = beginUpload("site-1", 3);
    appendChunk(uploadId, 0, Buffer.from("abc"));
    finishUpload(uploadId);
    expect(() => finishUpload(uploadId)).toThrow(/already finished or expired/i);
  });

  it("abandons an upload without complaint, twice if asked", () => {
    const { uploadId } = beginUpload("site-1", 3);
    appendChunk(uploadId, 0, Buffer.from("abc"));
    expect(partFiles()).toHaveLength(1);
    abandonUpload(uploadId);
    expect(partFiles()).toEqual([]);
    expect(() => abandonUpload(uploadId)).not.toThrow();
    expect(() => abandonUpload("never-existed")).not.toThrow();
  });

  it("sweeps what a previous run left behind, and spares what is in flight", () => {
    const { uploadId } = beginUpload("site-1", 6);
    appendChunk(uploadId, 0, Buffer.from("abc"));
    // A staging file from a run that was killed: after a restart nothing remembers it, so
    // only the sweep can ever remove it.
    writeFileSync(join(dataPath(UPLOADS_DIR), "orphan-from-last-run.part"), "leftovers");
    expect(partFiles()).toHaveLength(2);

    sweepStale(60_000);
    expect(partFiles()).toHaveLength(2); // both young — nothing to do

    sweepStale(1_000, Date.now() + 10_000);
    expect(partFiles()).toEqual([]);
    expect(() => appendChunk(uploadId, 1, Buffer.from("def"))).toThrow(/already finished or expired/i);
  });

  it("keeps a live upload whose file looks old on disk", () => {
    const { uploadId } = beginUpload("site-1", 6);
    appendChunk(uploadId, 0, Buffer.from("abc"));
    const [name] = partFiles();
    const longAgo = new Date(Date.now() - 86_400_000);
    utimesSync(join(dataPath(UPLOADS_DIR), name!), longAgo, longAgo);

    sweepStale(60_000);

    expect(partFiles()).toEqual([name]);
    expect(appendChunk(uploadId, 1, Buffer.from("def")).receivedBytes).toBe(6);
  });
});
