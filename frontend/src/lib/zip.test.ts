import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
// The backend's own source, as text. Reading it is what makes the size limit below a mirror
// that cannot drift rather than a second opinion — see the constant's comment in zip.ts.
import uploadsSource from "../../../backend/src/uploads.ts?raw";
import {
  bytesToBase64,
  describeArchiveProblem,
  describeOversizePick,
  hasRootIndex,
  isZip,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  NESTED_INDEX_MESSAGE,
  NO_INDEX_MESSAGE,
  pickedBytes,
  readAsBytes,
  stripCommonFolder,
  zipEntryNames,
  zipFolder,
} from "./zip";

/**
 * A file as the OS folder picker hands it over. `webkitRelativePath` is read-only and has
 * no constructor argument, so it has to be defined onto the instance — which is also
 * exactly what makes this worth testing: the path, not the name, is what we archive by.
 */
function picked(path: string, content = "x"): File {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const file = new File([content], name);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

/**
 * The same, but as heavy as the operating system says it is.
 *
 * A real 4 GB pick cannot be built in a test, and building one would be testing the wrong
 * thing anyway: the guard reads `File.size` precisely so that nothing has to be built or
 * read. So the metadata lies and the contents stay tiny — which is what lets the tests
 * below prove the refusal happens before any byte is touched.
 */
function heavy(path: string, size: number): File {
  const file = picked(path);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stripping the folder the user's build sits in", () => {
  it("lifts a single wrapper folder to the archive root", () => {
    expect(stripCommonFolder(["dist/index.html", "dist/assets/app.js"])).toEqual([
      "index.html",
      "assets/app.js",
    ]);
  });

  it("keeps going while the wrapper is nested — a pick can be two folders deep", () => {
    expect(stripCommonFolder(["build/dist/index.html", "build/dist/app.js"])).toEqual([
      "index.html",
      "app.js",
    ]);
  });

  it("leaves paths alone when the top level is already the site", () => {
    expect(stripCommonFolder(["index.html", "assets/app.js"])).toEqual(["index.html", "assets/app.js"]);
  });

  it("never strips a path down to nothing — a lone index.html survives", () => {
    expect(stripCommonFolder(["index.html"])).toEqual(["index.html"]);
    expect(stripCommonFolder(["dist/index.html"])).toEqual(["index.html"]);
  });

  it("stops at the first folder the paths disagree on", () => {
    expect(stripCommonFolder(["site/index.html", "other/app.js"])).toEqual([
      "site/index.html",
      "other/app.js",
    ]);
  });
});

describe("zipping a picked folder", () => {
  it("puts index.html at the archive root, because that is what AWS serves", async () => {
    const bytes = await zipFolder([
      picked("dist/index.html", "<h1>hello</h1>"),
      picked("dist/assets/app.js", "console.log(1)"),
    ]);
    const entries = unzipSync(bytes);
    expect(Object.keys(entries).sort()).toEqual(["assets/app.js", "index.html"]);
    expect(new TextDecoder().decode(entries["index.html"])).toBe("<h1>hello</h1>");
  });

  it("ignores the files the operating system leaves lying around", async () => {
    const bytes = await zipFolder([
      picked("dist/.DS_Store"),
      picked("dist/index.html", "hi"),
      picked("__MACOSX/dist/._index.html"),
    ]);
    expect(Object.keys(unzipSync(bytes))).toEqual(["index.html"]);
  });

  it("still strips the wrapper when junk sits beside the build folder, not inside it", async () => {
    const bytes = await zipFolder([picked("picked/.DS_Store"), picked("picked/index.html", "hi")]);
    expect(Object.keys(unzipSync(bytes))).toEqual(["index.html"]);
  });

  it("refuses, in a sentence, when there is no index.html at the top", async () => {
    await expect(
      zipFolder([picked("dist/app/index.html"), picked("dist/readme.txt")]),
    ).rejects.toThrow(NO_INDEX_MESSAGE);
  });

  it("refuses an empty pick rather than uploading an empty site", async () => {
    await expect(zipFolder([])).rejects.toThrow(NO_INDEX_MESSAGE);
  });
});

describe("refusing a pick that is too big to upload", () => {
  it("agrees with the backend's ceiling, which is the one that counts", () => {
    // The backend holds the assembled archive in memory and refuses on its own number. If
    // this frontend copy ever drifts, one side promises what the other rejects — so the
    // authority's source is read here and the two are compared literally.
    const declared = /export const MAX_UPLOAD_BYTES = ([\d *]+);/.exec(uploadsSource);
    expect(declared, "backend/src/uploads.ts no longer declares MAX_UPLOAD_BYTES").not.toBeNull();
    const backendBytes = (declared?.[1] ?? "")
      .split("*")
      .reduce((total, factor) => total * Number(factor.trim()), 1);
    expect(MAX_UPLOAD_BYTES).toBe(backendBytes);
  });

  it("refuses a folder without reading a single byte of it", async () => {
    // The defect this exists for: reading first froze or killed the poppy on a mis-picked
    // folder, and the user never learned why. So the proof is not just the rejection — it is
    // that nothing was opened to arrive at it.
    const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    const files = [heavy("project/index.html", 900 * 1024 * 1024), heavy("project/node_modules/big.js", 900 * 1024 * 1024)];

    await expect(zipFolder(files)).rejects.toThrow(/1.8 GB/);
    expect(read).not.toHaveBeenCalled();
  });

  it("names the size found, the limit, and the folder to pick instead", async () => {
    await expect(zipFolder([heavy("project/index.html", 400 * 1024 * 1024)])).rejects.toThrow(
      `That folder comes to 400 MB, and a website has to stay under ${MAX_UPLOAD_MB} MB — a folder that big is usually the whole project rather than the built site, so choose the folder your build produced (normally called dist, build or out).`,
    );
  });

  it("goes by what the pick weighs, not by what it would zip down to", async () => {
    // These files hold two bytes between them and would compress to nothing. The refusal is
    // still right: an upload we cannot survive measuring is an upload we cannot survive.
    const files = [heavy("dist/index.html", MAX_UPLOAD_BYTES), heavy("dist/app.js", 1)];
    await expect(zipFolder(files)).rejects.toThrow(/has to stay under/);
  });

  it("still zips a folder that fits, junk and all", async () => {
    const bytes = await zipFolder([picked("dist/.DS_Store"), heavy("dist/index.html", 4 * 1024 * 1024)]);
    expect(Object.keys(unzipSync(bytes))).toEqual(["index.html"]);
  });

  it("says nothing about a pick that fits, or a size the browser wouldn't tell us", () => {
    expect(describeOversizePick(MAX_UPLOAD_BYTES, "folder")).toBeNull();
    expect(describeOversizePick(0, "zip")).toBeNull();
    // Fail open: the backend's ceiling still stands, and blocking an upload over arithmetic
    // we could not do would be the worse mistake.
    expect(describeOversizePick(Number.NaN, "folder")).toBeNull();
  });

  it("tells a .zip user to take the big files out, not to pick a different folder", () => {
    const message = describeOversizePick(MAX_UPLOAD_BYTES + 1, "zip");
    expect(message).toMatch(/^That \.zip comes to 150 MB/);
    expect(message).toMatch(/videos, raw images and source maps/);
  });

  it("adds up the sizes the OS reported and shrugs off the ones it didn't", () => {
    expect(pickedBytes([heavy("a", 10), heavy("b", 32)])).toBe(42);
    expect(pickedBytes([heavy("a", Number.NaN), heavy("b", 5)])).toBe(5);
    expect(pickedBytes([])).toBe(0);
  });
});

describe("inspecting a .zip the user picked", () => {
  const zip = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

  it("reads the names without expanding the archive", () => {
    expect(zipEntryNames(zip({ "index.html": "hi", "assets/app.js": "x" })).sort()).toEqual([
      "assets/app.js",
      "index.html",
    ]);
  });

  it("says nothing when index.html is where it belongs", () => {
    expect(describeArchiveProblem(zip({ "index.html": "hi" }))).toBeNull();
  });

  it("names the wrapper-folder mistake specifically — it is the common one", () => {
    expect(describeArchiveProblem(zip({ "dist/index.html": "hi", "dist/app.js": "x" }))).toBe(
      NESTED_INDEX_MESSAGE,
    );
  });

  it("falls back to the plain message when there is no index.html anywhere", () => {
    expect(describeArchiveProblem(zip({ "readme.txt": "hi" }))).toBe(NO_INDEX_MESSAGE);
  });

  it("stays quiet on bytes it cannot read — our inspection failing must not block an upload", () => {
    expect(describeArchiveProblem(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("the small helpers around a pick", () => {
  it("recognises an archive by name or by type", () => {
    expect(isZip(new File([""], "site.ZIP"))).toBe(true);
    expect(isZip(new File([""], "site", { type: "application/zip" }))).toBe(true);
    expect(isZip(new File([""], "index.html", { type: "text/html" }))).toBe(false);
  });

  it("reads a file's bytes", async () => {
    expect(Array.from(await readAsBytes(new File(["AB"], "a.txt")))).toEqual([65, 66]);
  });

  it("base64s a chunk far bigger than the argument stack allows", () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    const decoded = atob(bytesToBase64(big));
    expect(decoded.length).toBe(big.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(299_999)).toBe(299_999 % 256);
  });
});

describe("hasRootIndex", () => {
  it("matches case-insensitively — the user's filesystem does too", () => {
    expect(hasRootIndex(["Index.HTML"])).toBe(true);
    expect(hasRootIndex(["app/index.html"])).toBe(false);
  });
});
