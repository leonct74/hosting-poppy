// Calls to our own backend, proxied by the host (capability: backend:invoke). This
// frontend has no AWS SDK, no Node and no network of its own — everything privileged
// goes over the bridge, and the backend is the only thing holding AWS credentials.

import { host } from "./host";
import type {
  DeployStatus,
  DomainCheck,
  DomainStatus,
  DnsWriteResult,
  LedgerEntry,
  Meta,
  ResourceRow,
  Site,
  SiteKind,
} from "./types";
import { bytesToBase64 } from "./lib/zip";

const MINUTE = 60_000;

/**
 * Timeouts, where the bridge's 2-minute default is wrong.
 *
 * Removals wait on AWS actually finishing (deleting a website takes its certificate and
 * domain association with it, which is minutes, not seconds); `finish` is the call that
 * pushes the whole archive up to AWS and starts the deploy. Everything else is a quick
 * read and keeps the default — a generous timeout on a fast call only delays the moment
 * we can tell the user something has gone wrong.
 */
const REMOVE_TIMEOUT = 10 * MINUTE;
const UPLOAD_TIMEOUT = 15 * MINUTE;
const CHUNK_TIMEOUT = 5 * MINUTE;
/**
 * Connecting a repository is four AWS calls in a row — make the website, read it back to
 * check how AWS wired it, add the branch, start the first build — plus one more that undoes
 * the lot if either of the middle two goes wrong. The 2-minute default could cut the reply
 * off halfway through that, leaving the user unable to tell whether a website now exists in
 * their account.
 */
const CONNECT_TIMEOUT = 5 * MINUTE;
/**
 * Building the latest commit is one AWS call, so this is not about how long it takes — it is
 * about what a premature give-up costs. AWS will usually have started the build anyway, and
 * the id needed to follow it comes back only in this reply: a caller that times out loses
 * sight of a build the user is already paying build minutes for, and presses again. Same
 * reasoning as `connectRepo`, so the same length.
 */
const BUILD_TIMEOUT = 5 * MINUTE;
/**
 * Writing the DNS record into the user's own zone.
 *
 * One AWS call, so this is not about how long it takes either — it is about what giving up
 * early COSTS. This is the one call in the poppy that changes something the user already
 * owns and that the public internet reads. A timeout here would leave them staring at a
 * screen that cannot say whether their live DNS was changed or not, which is the worst
 * answer this screen could give. Wait longer than we ever expect to need.
 */
const DNS_WRITE_TIMEOUT = 5 * MINUTE;

const path = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}`;

/** What the connect screen has to know before it can send anyone to GitHub. */
export interface GithubSetup {
  /** The region the AgentsPoppy connection works in. Shown, because the app below is per-region. */
  region: string;
  /**
   * GitHub's own page for installing AWS's Amplify app and choosing which repositories it
   * may read. Built by the backend (`github.ts::amplifyGitHubAppUrl`) rather than here,
   * because AWS publishes one app per region and only the backend knows which region the
   * connection actually works in — sending somebody to another region's app grants AWS
   * nothing and fails much later, with no clue attached.
   */
  appInstallUrl: string;
}

/** Everything needed to wire a website to a repository. Sent once, and never stored here. */
export interface ConnectRepoInput {
  /** What to call the website — the same field an uploaded site fills in. */
  name: string;
  /**
   * What the user said they were putting online, carried through because it decides how AWS
   * sets the website up — and that setting can never be changed on a website that exists.
   *
   * Always sent, never left to a default: a Next.js app quietly created as a finished site
   * builds and then serves nothing useful, and the only repair is deleting the website and
   * making it again, which loses its address. Same reasoning as `branch` below — what AWS is
   * asked for should be exactly what the panel above the button said it would be.
   */
  kind: SiteKind;
  /** `https://github.com/owner/repo`, normalised on the screen before it is sent. */
  repository: string;
  /** The branch that goes live. Every push to it deploys from then on. */
  branch: string;
  /**
   * The user's own GitHub key. It is handed to their AWS account to complete the handshake
   * and is never kept: it must never be logged, never put in a URL, never written down and
   * never returned to this frontend. Treat it like a password in every code path it touches.
   */
  accessToken: string;
}

export const api = {
  /**
   * What the address already does, read BEFORE anything is created or changed.
   *
   * This exists because of one live failure. `hp-test.example.net` refused to connect in under
   * a minute: the domain carried a catch-all `*.example.net` pointing at another app, so every
   * possible name under it already answered. AWS asked whether the name pointed at the site
   * and got a WRONG answer rather than no answer, and gave up. The user would have read "we
   * couldn't finish connecting that address" — true, useless, and impossible to act on. A
   * record for the exact name fixes it in one click; KNOWING that was the whole problem.
   *
   * Safe, read-only and repeatable by design (DESIGN §3.3), which is what lets the screen fire
   * it on its own as the user types rather than making them ask for it.
   *
   * `siteId` is not optional in practice, only in the route: without it the backend has no
   * targets to compare against, so a name ALREADY pointing at this very website reads as
   * `taken` — and the screen would then solemnly ask the user to confirm moving their own
   * site onto itself. Always pass it when there is a site in hand.
   */
  checkDomain: (address: string, siteId?: string): Promise<{ check: DomainCheck }> =>
    host.invokeBackend({
      // Hand-built rather than via the path helper, which owns segments, not queries. The
      // address is the whole question here, so it is encoded rather than trusted: a name
      // holding an `&` or a `#` would otherwise arrive at the backend cut in half.
      method: "GET",
      path:
        `/domain/check?address=${encodeURIComponent(address)}` +
        (siteId ? `&siteId=${encodeURIComponent(siteId)}` : ""),
    }),

  /**
   * Write the records this site needs into the user's own zone, on their behalf.
   *
   * Only ever called after `checkDomain` has said what is there, and — when something already
   * answers for that name — after the user has confirmed the move in words. This is the one
   * call that changes something the public internet reads, so nothing about it is automatic.
   *
   * `confirmOverwrite` is that yes, carried to a backend that REFUSES to move a name in use
   * without it. The refusal lives there on purpose, so a screen that forgot to ask cannot
   * skip the question — this flag may only ever be true because a person said so.
   *
   * `write` reports what actually happened: `manual` is the records we could NOT write, and
   * it is the difference between "there's nothing left for you to do" and a screen that lies.
   */
  writeDomainRecord: (
    id: string,
    options: { confirmOverwrite?: boolean } = {},
  ): Promise<{ domain: DomainStatus; write?: DnsWriteResult }> =>
    host.invokeBackend(
      {
        method: "POST",
        path: path("sites", id, "domain", "record"),
        body: { confirmOverwrite: options.confirmOverwrite === true },
      },
      DNS_WRITE_TIMEOUT,
    ),

  /** Who we are connected to and whether websites can be hosted in that region. */
  meta: (): Promise<Meta> => host.invokeBackend({ method: "GET", path: "/meta" }),

  listSites: (): Promise<{ sites: Site[] }> => host.invokeBackend({ method: "GET", path: "/sites" }),

  /**
   * Creates the website's home in AWS. It has no content until something is deployed.
   *
   * Always a finished site, and it says so rather than relying on the backend's default: this
   * is the path that uploads files nobody builds, and an app that renders its own pages has to
   * be built — so it can only ever arrive through `connectRepo`.
   */
  createSite: (name: string, kind: SiteKind = "static"): Promise<{ site: Site }> =>
    host.invokeBackend({ method: "POST", path: "/sites", body: { name, kind } }),

  /** Where to send the user so AWS can read their repositories — step 1 of connecting one. */
  githubSetup: (): Promise<GithubSetup> => host.invokeBackend({ method: "GET", path: "/github/setup" }),

  /**
   * Makes the website, wires it to the repository and starts the first build. One call, so
   * a half-connected website can never be left behind by a screen that stopped in the
   * middle: everything after `CreateApp` — including deleting it again if AWS wired it the
   * wrong way — happens on the other side of this one request.
   *
   * `input.accessToken` is a secret in transit. It goes into the request BODY (never the
   * path, never a query string), and nothing here may log, store or echo it.
   */
  connectRepo: (input: ConnectRepoInput): Promise<{ site: Site; jobId: string }> =>
    host.invokeBackend({ method: "POST", path: "/sites/connect", body: input }, CONNECT_TIMEOUT),

  /** The live state of one website, read from AWS on every call — never from a cache. */
  getSite: (id: string): Promise<{ site: Site }> =>
    host.invokeBackend({ method: "GET", path: path("sites", id) }),

  /** Removes the website, its address, its domain and its certificate. Not reversible. */
  removeSite: (id: string): Promise<{ ok: true }> =>
    host.invokeBackend({ method: "DELETE", path: path("sites", id) }, REMOVE_TIMEOUT),

  /**
   * Build and publish the newest commit on a connected website's branch.
   *
   * Two jobs, one button: "Deploy the latest commit" on a website built from GitHub, and the
   * way to start a first build that never began — which the backend tells the user to do, by
   * name, when connecting a repository succeeds but its first build doesn't start. Without a
   * method here that sentence pointed at a button nobody could find.
   *
   * An uploaded website has no commit to build and the backend refuses one, which is why the
   * dashboard never offers this for one.
   */
  build: (id: string): Promise<{ jobId: string; branch: string }> =>
    host.invokeBackend({ method: "POST", path: path("sites", id, "build") }, BUILD_TIMEOUT),

  /**
   * How far a deploy has got. Poll this while the progress screen is open.
   *
   * `branch` is part of a job's address in AWS, not a detail. Left out, the backend falls back
   * to the single name an uploaded site uses ("main") — so a website built from a repository
   * whose branch is `master` asks about a job on a branch that does not exist. AWS answers "no
   * such thing", which the backend deliberately reads as "not started yet" (a job really is
   * invisible for a second or two after it starts), and the screen then waits for ever on a
   * build that has already succeeded. Callers pass the site's own `branch`.
   */
  deployStatus: (id: string, jobId: string, branch?: string): Promise<{ deploy: DeployStatus }> =>
    host.invokeBackend({
      method: "GET",
      // Hand-built rather than URLSearchParams so the path helper still owns the segments:
      // the branch is the only thing that has ever gone in this query string, and a branch
      // name may hold a slash (`feature/new-look`), which must not read as another segment.
      path: path("sites", id, "deploy", jobId) + (branch ? `?branch=${encodeURIComponent(branch)}` : ""),
    }),

  /** null until the user has attached a domain of their own. */
  getDomain: (id: string): Promise<{ domain: DomainStatus | null }> =>
    host.invokeBackend({ method: "GET", path: path("sites", id, "domain") }),

  /** Attaches the user's domain and returns the DNS records they have to publish. */
  /**
   * `alsoWww` is stated on every call, never left to a default: www is a second prefix inside
   * this one attachment and cannot be added afterwards, so what AWS is asked for has to be
   * exactly what the screen's checkbox said.
   */
  attachDomain: (id: string, address: string, alsoWww = false): Promise<{ domain: DomainStatus }> =>
    host.invokeBackend({ method: "POST", path: path("sites", id, "domain"), body: { address, alsoWww } }),

  /** Detaches the domain. The site stays live on its AWS address. */
  removeDomain: (id: string): Promise<{ ok: true }> =>
    host.invokeBackend({ method: "DELETE", path: path("sites", id, "domain") }, REMOVE_TIMEOUT),

  /** Everything this poppy made in the user's account, plus the timeline of changes. */
  resources: (): Promise<{ resources: ResourceRow[]; ledger: LedgerEntry[] }> =>
    host.invokeBackend({ method: "GET", path: "/resources" }),

  /**
   * Removes everything HostingPoppy ever created. This is the same route the host itself
   * POSTs when the user tears the poppy down from AgentsPoppy (extension.json
   * `teardown.endpoint`), so the in-app button and the host's button do exactly one thing.
   */
  removeEverything: (): Promise<{ ok: true; removed?: string[] }> =>
    host.invokeBackend({ method: "POST", path: "/teardown" }, REMOVE_TIMEOUT),

  // ── The upload, one piece at a time. Prefer `uploadSite` below to driving these. ──

  beginUpload: (id: string, fileName: string, totalBytes: number): Promise<{ uploadId: string }> =>
    host.invokeBackend({
      method: "POST",
      path: path("sites", id, "deploy", "begin"),
      body: { fileName, totalBytes },
    }),

  sendChunk: (
    id: string,
    uploadId: string,
    index: number,
    dataBase64: string,
  ): Promise<{ receivedBytes: number }> =>
    host.invokeBackend(
      {
        method: "POST",
        path: path("sites", id, "deploy", "chunk"),
        body: { uploadId, index, dataBase64 },
      },
      CHUNK_TIMEOUT,
    ),

  finishUpload: (id: string, uploadId: string): Promise<{ jobId: string }> =>
    host.invokeBackend(
      { method: "POST", path: path("sites", id, "deploy", "finish"), body: { uploadId } },
      UPLOAD_TIMEOUT,
    ),
};

/**
 * How much of the site we send in one bridge message.
 *
 * Chunked because a whole site in a single postMessage would be one enormous string the
 * frame has to build, serialise and hold in memory at once — on a big site that stalls
 * the UI, and there is no way to show progress through it. ~3 MB of bytes becomes ~4 MB
 * of base64, which crosses comfortably and gives the progress bar something honest to say.
 */
export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

export interface UploadProgress {
  /** Bytes the backend has confirmed it holds — its count, not our optimism. */
  sentBytes: number;
  totalBytes: number;
  /** 0–1, ready for a progress bar's width. */
  fraction: number;
}

/**
 * Send a built site to the backend and start the deploy. Resolves with the job id the
 * progress screen then polls with `api.deployStatus`.
 *
 * `onProgress` is called before the first chunk (so the bar appears the instant the
 * button is pressed) and after each one. A chunk only counts once the backend has
 * answered for it, so the bar shows bytes actually delivered rather than bytes we hoped
 * to deliver — overstating progress is exactly the lie UX.md forbids.
 *
 * Chunks go in order and one at a time, because the backend appends them in order.
 */
export async function uploadSite(
  siteId: string,
  bytes: Uint8Array,
  fileName: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ jobId: string }> {
  const totalBytes = bytes.length;
  if (totalBytes === 0) {
    throw new Error("There's nothing in this file to put online — pick your built site and try again.");
  }

  const report = (sentBytes: number) =>
    onProgress?.({ sentBytes, totalBytes, fraction: Math.min(1, sentBytes / totalBytes) });

  report(0);
  const { uploadId } = await api.beginUpload(siteId, fileName, totalBytes);

  let index = 0;
  let acked = 0;
  for (let offset = 0; offset < totalBytes; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, totalBytes));
    const { receivedBytes } = await api.sendChunk(siteId, uploadId, index, bytesToBase64(chunk));
    acked += chunk.length;
    // Take whichever number is further along: ours if the backend reports this chunk's
    // size, the backend's if it reports a running total. Either reading gives a bar that
    // only ever moves forward, and never past the end.
    const confirmed = Number.isFinite(receivedBytes) ? receivedBytes : 0;
    report(Math.min(totalBytes, Math.max(acked, confirmed)));
    index += 1;
  }

  return api.finishUpload(siteId, uploadId);
}
