// Turning what the user picked into the bytes we upload.
//
// The backend is confined — it cannot read the user's disk — so the browser is the only
// thing here that ever touches their files. The user picks a folder (or a .zip) and we
// hand the bytes across the bridge. Nothing is read that the user did not choose.
//
// The load-bearing detail: AWS serves the ARCHIVE ROOT. If the archive contains
// `dist/index.html` instead of `index.html`, the whole site lands one folder deep and
// every address 404s — with no error anywhere to explain it. So we strip the common
// leading folder ourselves, and we refuse an archive with no index.html at the top
// rather than deploying something we already know is broken.
//
// The other refusal here is about size, and it has to happen FIRST, on the sizes the
// browser already knows — see `describeOversizePick`.

import { unzipSync, zipSync } from "fflate";
import { formatBytes } from "./format";

/** What we say when the picked folder has no index.html at its top level. */
export const NO_INDEX_MESSAGE =
  "We couldn't find index.html in what you picked — choose the folder your site was built into, the one with index.html directly inside it.";

/** The .zip variant: index.html exists, but everything sits inside a wrapper folder. */
export const NESTED_INDEX_MESSAGE =
  "Everything in this .zip is inside a folder, so index.html isn't at the top — zip the contents of your build folder rather than the folder itself.";

/**
 * The ceiling on one website's upload, as the browser understands it.
 *
 * `MAX_UPLOAD_BYTES` in backend/src/uploads.ts is the AUTHORITY: that is the side holding
 * the whole archive in memory to hand to AWS, and it refuses anything larger whatever the
 * browser believes. This is the browser's copy of that one number — the frontend and the
 * backend are separate builds with no package between them — and zip.test.ts reads the
 * backend's source and fails if the two ever disagree, so the copy cannot drift in silence.
 */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

/** The same ceiling in the unit every sentence about it is written in. */
export const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

/**
 * Files the operating system puts in a folder that are not part of anyone's website.
 * Dropped BEFORE the common-folder check: a stray `.DS_Store` sitting beside the build
 * folder would otherwise look like a second top-level entry and block the strip.
 */
function isOsJunk(path: string): boolean {
  if (path.startsWith("__MACOSX/")) return true;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last === ".DS_Store" || last === "Thumbs.db" || last === "desktop.ini";
}

/** The path a picked file should have inside the archive, before any stripping. */
function pathOf(file: File): string {
  // `webkitRelativePath` is what a folder pick gives us ("dist/assets/app.js"); a plain
  // multi-file pick has none, and then the bare name IS the path.
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  const path = relative && relative.length > 0 ? relative : file.name;
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Drop the leading folders every path shares, so the site's root becomes the archive root.
 *
 * Iterative rather than one pass because a pick can be wrapped twice ("build/dist/…"),
 * and it never strips the last segment — a single `index.html` at the top must survive.
 */
export function stripCommonFolder(paths: string[]): string[] {
  let out = paths.slice();
  for (;;) {
    if (out.length === 0) return out;
    const heads = out.map((p) => p.split("/"));
    if (heads.some((segments) => segments.length < 2)) return out;
    const first = heads[0]?.[0];
    if (first === undefined) return out;
    if (!heads.every((segments) => segments[0] === first)) return out;
    out = heads.map((segments) => segments.slice(1).join("/"));
  }
}

/** True when index.html sits at the top of these (already stripped) paths. */
export function hasRootIndex(paths: string[]): boolean {
  // Case-insensitive because macOS and Windows filesystems are, so a user who typed
  // `Index.html` genuinely cannot see the difference — and would never guess the cause.
  return paths.some((p) => p.toLowerCase() === "index.html");
}

/**
 * The bytes of one picked file.
 *
 * `FileReader` rather than the tidier `file.arrayBuffer()`: jsdom has no `arrayBuffer` on
 * Blob, so that version can only be tested through a polyfill — and a polyfill means the
 * path the tests exercise is not the path that ships. FileReader is the one route that is
 * identical here, in the tests, and in every webview this poppy could be rendered in.
 */
export function readAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`We couldn't read ${file.name} — it may have moved or been renamed since you picked it.`));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * What the picked files weigh, according to the operating system — without opening one.
 *
 * `File.size` is metadata the browser already has, so this costs nothing. That is the whole
 * point: it is the only measurement available BEFORE committing to read the bytes, and the
 * read is the part that cannot be survived.
 */
export function pickedBytes(files: File[]): number {
  let total = 0;
  for (const file of files) {
    const size = Number(file.size);
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/**
 * The sentence to show when a pick is too big to upload, or null when it fits.
 *
 * Called on the sizes BEFORE anything is read (see `zipFolder`), because reading first is
 * what turned one wrong pick — a whole project with node_modules in it, a folder of videos —
 * into a frozen or killed poppy with nothing on screen to explain itself. Being told no,
 * instantly and with the number, is a far better afternoon than that.
 *
 * Fails OPEN on a size we cannot read: the backend's own ceiling still stands, and refusing
 * somebody's upload because our arithmetic went odd would be the worse mistake.
 */
export function describeOversizePick(totalBytes: number, kind: "folder" | "zip"): string | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= MAX_UPLOAD_BYTES) return null;
  const found = formatBytes(totalBytes);
  if (kind === "zip") {
    return `That .zip comes to ${found}, and a website has to stay under ${MAX_UPLOAD_MB} MB — take the big files out (videos, raw images and source maps, usually) and choose it again.`;
  }
  return `That folder comes to ${found}, and a website has to stay under ${MAX_UPLOAD_MB} MB — a folder that big is usually the whole project rather than the built site, so choose the folder your build produced (normally called dist, build or out).`;
}

/** True when the user picked an archive rather than a folder of files. */
export function isZip(file: File): boolean {
  if (/\.zip$/i.test(file.name)) return true;
  return file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

/**
 * Zip a picked folder into the bytes AWS expands, with the site's root at the archive root.
 * Rejects with a sentence the user can act on when the pick is too big to upload, or when
 * index.html isn't there.
 */
export async function zipFolder(files: File[]): Promise<Uint8Array> {
  const kept = files.filter((f) => !isOsJunk(pathOf(f)));
  if (kept.length === 0) throw new Error(NO_INDEX_MESSAGE);

  // Before anything is read. The check further down — on the size of the finished archive —
  // can only speak once every byte is already in memory, which for a mis-picked folder is
  // exactly the moment the poppy dies. This one answers from metadata, in an instant, and
  // it comes first for that reason alone.
  const tooBig = describeOversizePick(pickedBytes(kept), "folder");
  if (tooBig) throw new Error(tooBig);

  const paths = stripCommonFolder(kept.map(pathOf));
  if (!hasRootIndex(paths)) throw new Error(NO_INDEX_MESSAGE);

  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < kept.length; i += 1) {
    const file = kept[i];
    const path = paths[i];
    if (!file || !path) continue;
    entries[path] = await readAsBytes(file);
  }

  // Synchronous on purpose. fflate's async `zip()` compresses in a Web Worker built from
  // a blob: URL, which the host frame's content-security policy can refuse outright —
  // a failure we could not recover from at the worst possible moment. A built site is a
  // few megabytes, which zips in well under a second on the main thread.
  return zipSync(entries, { level: 6 });
}

/**
 * Read the file names out of a .zip the user picked, WITHOUT decompressing it.
 * The filter returning false is what keeps this cheap (and side-steps fflate throwing on
 * an entry compressed with something it can't expand — we only ever wanted the names).
 */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (entry) => {
      names.push(entry.name);
      return false;
    },
  });
  return names;
}

/**
 * The one sentence to show about a picked .zip before uploading it, or null when it looks
 * deployable. Fails OPEN: if we cannot read the archive we say nothing and let AWS judge —
 * blocking an upload on our own inspection failing would be the worse mistake.
 */
export function describeArchiveProblem(bytes: Uint8Array): string | null {
  let names: string[];
  try {
    names = zipEntryNames(bytes);
  } catch {
    return null;
  }
  const files = names
    .map((n) => n.replace(/^\.\//, ""))
    .filter((n) => !n.endsWith("/") && !isOsJunk(n));
  if (files.length === 0) return null;
  if (hasRootIndex(files)) return null;
  if (files.some((n) => /(^|\/)index\.html$/i.test(n))) return NESTED_INDEX_MESSAGE;
  return NO_INDEX_MESSAGE;
}

/**
 * Bytes → base64, the form an upload chunk crosses the host bridge in (the bridge carries
 * JSON, not binary). Lives here because it is part of the same picked-file→uploaded-bytes
 * pipeline, and because it is exactly the kind of code that needs a test: the obvious
 * one-liner (`String.fromCharCode(...all)`) overflows the argument stack on anything
 * bigger than a few hundred kilobytes and takes the whole upload down with it.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const STEP = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
