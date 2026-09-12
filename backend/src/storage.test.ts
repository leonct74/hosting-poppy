import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dataPath,
  exists,
  initStorage,
  readJson,
  removeFile,
  storageHome,
  usingTemporaryStorage,
  writeJson,
} from "./storage";

/** A fresh data folder, as the host would hand us one. */
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hp-storage-"));
  initStorage(dir);
  return dir;
}

describe("storage", () => {
  // FIRST on purpose: every later test initialises the module, and this is the only chance
  // to see the un-initialised state.
  it("refuses to guess where files go before initStorage ran", () => {
    expect(() => storageHome()).toThrow(/bug in the backend/i);
    expect(() => dataPath("sites.json")).toThrow(/bug in the backend/i);
  });

  it("puts every path inside the folder the host gave us", () => {
    const dir = freshHome();
    expect(storageHome()).toBe(dir);
    expect(dataPath("ledger.json")).toBe(join(dir, "ledger.json"));
    expect(dataPath("uploads", "a.part")).toBe(join(dir, "uploads", "a.part"));
    expect(usingTemporaryStorage()).toBe(false);
  });

  it("falls back to the OS temp folder when the host is too old to send one, and says so", () => {
    initStorage(undefined);
    expect(storageHome().startsWith(tmpdir())).toBe(true);
    expect(usingTemporaryStorage()).toBe(true);
    expect(exists(storageHome())).toBe(true); // still usable — such a host runs us unconfined
  });

  it("answers 'not there' instead of throwing, whatever the path", () => {
    const dir = freshHome();
    writeFileSync(join(dir, "real"), "x");
    expect(exists(join(dir, "real"))).toBe(true);
    expect(exists(join(dir, "imaginary"))).toBe(false);
    // The confinement trap in miniature: existsSync CAN throw. A NUL byte is the one way to
    // provoke it without --permission, and ERR_ACCESS_DENIED must read the same way.
    expect(exists("bad\0path")).toBe(false);
  });

  it("reads back what it wrote, and leaves no half-written file behind", () => {
    const dir = freshHome();
    const path = join(dir, "notes.json");
    expect(writeJson(path, { hello: "world", n: 2 })).toBe(true);
    expect(readJson(path, null)).toEqual({ hello: "world", n: 2 });
    expect(readdirSync(dir)).toEqual(["notes.json"]);
  });

  it("creates missing folders on the way to the file", () => {
    const dir = freshHome();
    expect(writeJson(join(dir, "deep", "notes.json"), [1])).toBe(true);
    expect(readJson(join(dir, "deep", "notes.json"), null)).toEqual([1]);
  });

  it("falls back to the default for a missing, corrupt or empty file", () => {
    const dir = freshHome();
    expect(readJson(join(dir, "missing.json"), "fallback")).toBe("fallback");
    writeFileSync(join(dir, "corrupt.json"), "{ not json at all");
    expect(readJson(join(dir, "corrupt.json"), "fallback")).toBe("fallback");
    writeFileSync(join(dir, "empty.json"), "");
    expect(readJson(join(dir, "empty.json"), "fallback")).toBe("fallback");
    writeFileSync(join(dir, "null.json"), "null");
    expect(readJson(join(dir, "null.json"), "fallback")).toBe("fallback");
  });

  it("reports a failed write instead of throwing it at the caller", () => {
    const dir = freshHome();
    mkdirSync(join(dir, "blocked"));
    // A folder where the file should be: the write cannot succeed, and must not explode.
    expect(writeJson(join(dir, "blocked"), { a: 1 })).toBe(false);
    writeFileSync(join(dir, "afile"), "x");
    expect(writeJson(join(dir, "afile", "under.json"), { a: 1 })).toBe(false);
  });

  it("deletes a file, and shrugs when there is nothing to delete", () => {
    const dir = freshHome();
    const path = join(dir, "gone.json");
    writeFileSync(path, "x");
    removeFile(path);
    expect(exists(path)).toBe(false);
    expect(() => removeFile(path)).not.toThrow();
    expect(() => removeFile(join(dir, "never-existed"))).not.toThrow();
  });
});
