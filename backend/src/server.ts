// HostingPoppy's HTTP surface — the only way anything reaches AWS.
//
// The host spawns this process with AGENTSPOPPY_BOOTSTRAP and proxies every frontend call
// here (capability `backend:invoke`); the webview never learns this port and holds no
// credentials of its own. Modelled on TrafficPoppy's sidecar: node:http on the injected
// loopback port, JSON in and JSON out, and one calm sentence when something fails.
//
// This file is deliberately thin. Every AWS call lives in amplify.ts, every rule about names
// and domains in sites.ts, every sentence in errors.ts — so what is left here is routing,
// validation at the door, and the two things only the route layer can decide: which failures
// are a 404 rather than an error, and what goes in the transparency ledger.
//
// Three habits are load-bearing rather than stylistic:
//  - NOTHING is remembered between calls. Every screen's state is read back from AWS on
//    every request (AGENTS.md §5), so closing the window mid-deploy loses nothing and a
//    restart cannot show a stale answer.
//  - Every request body is capped before it is read, because the upload route accepts
//    megabytes and an uncapped read is how a backend gets OOM-killed.
//  - Nothing is written outside dataDir and no process is ever spawned: this backend runs
//    under `node --permission` (extension.json `backend.isolation: "strict"`).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AmplifyClient,
  type JobSummary,
  ListDomainAssociationsCommand,
  ListJobsCommand,
} from "@aws-sdk/client-amplify";
import { Route53Client } from "@aws-sdk/client-route-53";

// Imported, not read at runtime: esbuild inlines it into the bundle, so the version we
// report is the one that shipped — and a confined backend never has to go looking for a file
// outside its data folder to answer its very first call.
import manifest from "../../extension.json";
import { brokerCredentialsProvider, readBootstrap } from "./boot";
import {
  attachDomain,
  connectRepository,
  createSite,
  deleteSite,
  deployStatus,
  describeDomainCheck,
  detachDomain,
  explainDomainFailure,
  getSite,
  listSites,
  mapDomainStatus,
  mapJob,
  siteTarget,
  absoluteRecordName,
  startBuild,
  startDeploy,
  teardownAll,
  TeardownIncomplete,
  writeDomainRecords,
  type DomainRecordWrite,
  type WrittenRecord,
  type HostingCtx,
  type ZoneAccess,
} from "./amplify";
import {
  changeStatus,
  classifyName,
  findZone,
  inspectName,
  readRecords,
  resolveName,
  ROUTE53_REGION,
  upsertRecord,
  removeRecordIfOurs,
} from "./dns";
import { describeError, HttpError, type ErrorReply } from "./errors";
import {
  amplifyGitHubAppUrl,
  branchUrl,
  DEFAULT_BRANCH,
  normalizeBranch,
  parseRepoUrl,
  validateBranch,
  validateRepoUrl,
  validateToken,
} from "./github";
import { readLedger, record, recordAll } from "./ledger";
import { consoleUrlFor, HOSTING_REGIONS, regionNotSupportedMessage, regionSupported } from "./regions";
import { LIVE_BRANCH, normalizeDomain, normalizeSiteName, splitDomain, validateDomain, validateSiteName } from "./sites";
import { initStorage, usingTemporaryStorage } from "./storage";
import { appendChunk, beginUpload, finishUpload, sweepStale, UPLOAD_TTL_MS } from "./uploads";
import type { DeployStatus, DnsWriteResult, DomainCheck, DomainStatus, Meta, ResourceRow, Site, SiteKind } from "./types";

const boot = readBootstrap();

// Before the port opens, not on the first request: `storageHome()` throws if anything asks
// where the data folder is before this runs, and the sweep is the only thing that ever
// deletes the staging files a previous run left behind (uploads.ts explains why).
initStorage(boot.dataDir);
sweepStale(UPLOAD_TTL_MS);

const region = boot.account.region;
const ctx: HostingCtx = {
  amp: new AmplifyClient({ region, credentials: brokerCredentialsProvider(boot) }),
  region,
  attribution: { accountId: boot.account.accountId, connectionId: boot.connectionId },
};

/**
 * The DNS half of the domain flow (DESIGN §3.3), bound to AWS.
 *
 * Its own client, not the Amplify one: same brokered credentials, a different service, and a
 * region that is not the connection's — Route 53 is global, and a hosted zone is not a thing
 * that lives in eu-west-1 (dns.ts owns that constant).
 *
 * The three lines below are the only place the shape of dns.ts is depended on. Everything that
 * DECIDES anything — which sentence, whether "add it for me" is offered, and the refusal that
 * stands in front of moving a live name — is in amplify.ts behind `ZoneAccess`, so it is
 * tested with a plain object, no credentials and no network.
 */
const r53 = new Route53Client({ region: ROUTE53_REGION, credentials: brokerCredentialsProvider(boot) });

const zones: ZoneAccess = {
  findZone: (domain) => findZone(r53, domain),
  classify: async (zone, name, target) =>
    classifyName({ name, zone: zone.name, target, records: await readRecords(r53, zone.id, name, zone.name) }),
  write: (zone, record, replaceExisting) =>
    upsertRecord(r53, zone.id, record.name, record.value, { type: record.type, zoneName: zone.name, replaceExisting }),
};

/**
 * Answered without touching AWS — deliberately. It is the first call the frontend makes and
 * the one the boot rig checks, so it must work before any credential has been minted, and
 * when the connection's region cannot host websites at all.
 */
const META: Meta = {
  accountId: boot.account.accountId,
  region,
  version: manifest.version,
  regionSupported: regionSupported(region),
  supportedRegions: [...HOSTING_REGIONS],
};

/** Every body but a file chunk is a handful of short fields; anything larger is a bug. */
const MAX_JSON_BYTES = 64 * 1024;

/**
 * One chunk of a site's archive. The frontend sends 3 MiB of bytes, which is 4 MiB of
 * base64 inside a small JSON envelope — this leaves room for a bigger chunk later without
 * leaving room for a request that could exhaust this process's memory.
 */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** How much raw text rides along in a "technical details" disclosure (errors.ts's budget). */
const MAX_DETAIL = 600;

/**
 * Both of these mean a client sent more than the route allows, which can only be our own
 * frontend misbehaving — but the two roads back are different, so they get different
 * sentences rather than one that is wrong half the time.
 */
const TOO_LARGE = "HostingPoppy couldn't accept a request that large — reopen it from AgentsPoppy and try again.";
const CHUNK_TOO_LARGE =
  "That was more than HostingPoppy can take in one piece — choose your site files again and it will send them in smaller pieces.";

/**
 * One page of a branch's upload history. Amplify answers with the most recent first, but we
 * sort the page anyway (see {@link newestFirst}) rather than trusting an order AWS has never
 * promised — the status pill on the site list is read from exactly this.
 */
const JOB_PAGE = 50;

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Read a JSON body, refusing one that is bigger than the route allows.
 *
 * Over the cap we keep reading and hold nothing, rather than breaking out of the loop: a
 * `for await` over a request destroys it on `break`, and a destroyed request means the
 * caller sees a reset connection instead of the sentence we wrote for them. Draining is
 * bounded by what the sender sends, and the only sender is our own frontend on loopback.
 */
async function readBody(req: IncomingMessage, limit: number, tooLarge = TOO_LARGE): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;

  for await (const piece of req) {
    const buf = piece as Buffer;
    size += buf.length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      continue;
    }
    if (!over) chunks.push(buf);
  }

  if (over) throw new HttpError(413, tooLarge);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "HostingPoppy couldn't read that request — reopen it from AgentsPoppy and try again.");
  }
}

/** A field the frontend was supposed to send. Absent reads as empty, and validation says so. */
function text(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * What the user said they were putting online.
 *
 * Anything we don't recognise is the finished site — including nothing at all, which is what
 * a screen written before Next.js existed sends. That default is not laziness: a finished site
 * is what this poppy has always made, it is the cheaper of the two to run, and conjuring a
 * server out of a word we can't read is the only answer that costs the user money. The one
 * word that means otherwise has to be spelled exactly.
 */
function siteKind(body: unknown): SiteKind {
  return text(body, "kind") === "nextjs" ? "nextjs" : "static";
}

/** As above for a number. NaN when nothing usable arrived — never a silent 0. */
function count(body: unknown, key: string): number {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * A yes the user actually gave. Only the boolean `true` counts: this reads the flag that lets
 * a DNS record be moved off a live website, so "true", 1 and "on" are all treated as absent —
 * a caller that means yes can say so in the one unambiguous way.
 */
function flag(body: unknown, key: string): boolean {
  return (body as Record<string, unknown> | undefined)?.[key] === true;
}

/**
 * errors.ts's catch-all sentence — the one it answers with when no rule in the dictionary
 * matched. Discovered by asking it about an error nothing can match, rather than copied
 * here, because a copy would go quietly out of date the day that sentence is reworded.
 */
const DICTIONARY_FALLBACK = describeError(new Error("")).message;

/**
 * The sentence one of our own modules already wrote for this user.
 *
 * amplify.ts and uploads.ts answer some failures with a finished sentence thrown as a plain
 * `Error` ("Your files couldn't reach AWS — check your internet connection and try again.").
 * `friendlyError` only passes an `HttpError` through untouched, so those sentences would
 * otherwise be replaced by the dictionary's generic fallback.
 *
 * The test is narrow on purpose: every AWS SDK error carries `$metadata`, every Node system
 * error carries `code`, and what the language itself throws is a TypeError or a SyntaxError.
 * A bare `Error` that is none of those is ours, and its message was written for a person.
 */
function writtenSentence(e: unknown): string | undefined {
  if (!(e instanceof Error) || e instanceof HttpError) return undefined;
  if (e.name !== "Error" || "$metadata" in e || "code" in e) return undefined;
  return e.message.trim() || undefined;
}

/**
 * What the client gets when something fails: one calm sentence, plus the raw AWS text behind
 * a disclosure.
 *
 * The dictionary answers first and keeps the last word whenever it recognises the failure —
 * that is how the poppy has ONE voice for "your connection is paused" wherever the failure
 * surfaced (errors.ts says so explicitly, and a credential refusal read straight out of the
 * broker would otherwise slip past it). Only when the dictionary shrugs do we prefer the
 * sentence the module that failed had already written, because there the specific answer is
 * strictly better than the general one. The status is not what the user reads — the frontend
 * renders `message` — so it stays whatever describeError chose.
 */
function errorReply(e: unknown): ErrorReply {
  const reply = describeError(e);
  if (reply.message !== DICTIONARY_FALLBACK) return reply;

  const written = writtenSentence(e);
  if (!written) return reply;
  // startDeploy hangs AWS's raw refusal on `cause` precisely so it can be shown here and
  // nowhere else — it is XML, and XML never belongs on a primary screen. Without one there
  // is nothing to disclose: rawDetail would only repeat the sentence back at the user.
  const cause = (e as { cause?: unknown }).cause;
  return typeof cause === "string" && cause.trim()
    ? { status: reply.status, message: written, detail: cause.trim().slice(0, MAX_DETAIL) }
    : { status: reply.status, message: written };
}

/**
 * Run one of uploads.ts's synchronous steps and answer its refusals as 400s.
 *
 * Everything that module throws is about the request in hand — a chunk out of order, an
 * archive bigger than we accept, an upload id that has already been finished — and every one
 * of them is already a sentence naming what to do next.
 */
function staging<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    throw new HttpError(400, writtenSentence(e) ?? "That upload didn't work out — choose your site files again.");
  }
}

/**
 * The answer for a site id that is missing, or is an Amplify app HostingPoppy didn't make.
 *
 * Both are 404 rather than 403: to this poppy an app it doesn't own does not exist (that is
 * how getSite reads it too), and telling the user what else lives in their account would be
 * answering a question they didn't ask.
 */
function noSuchSite(): HttpError {
  return new HttpError(
    404,
    "That website isn't in your AWS account any more — go back to your list of websites to see what is.",
  );
}

/** The upload's size in the words a person uses. Only ever a note on the timeline. */
function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 0.1 ? "Less than 0.1 MB" : `${mb.toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Reading a site's live state back from AWS
// ---------------------------------------------------------------------------

/**
 * Newest first. Amplify numbers a branch's uploads sequentially, so the highest id is the
 * most recent — and it matters that the id comes first: an upload created seconds ago has an
 * id before it has a `startTime`, and sorting on the time would hide the very deploy the
 * user is watching behind the last one that finished.
 */
function newestFirst(a: JobSummary, b: JobSummary): number {
  const left = Number(a.jobId);
  const right = Number(b.jobId);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
  return (b.startTime?.getTime() ?? 0) - (a.startTime?.getTime() ?? 0);
}

/**
 * How the last upload — or build from GitHub — went, or undefined when nothing has gone live
 * yet.
 *
 * The branch has to be the site's own: an uploaded site's is always {@link LIVE_BRANCH}, a
 * connected site's is whatever its repository calls the branch it serves, and asking AWS
 * about a branch that doesn't exist reads as "nothing has ever been deployed".
 *
 * The source goes with it because a failure here becomes the sentence the websites list
 * shows under "Needs attention" — and "check your zip" is a dead end for a site nobody ever
 * uploaded anything to.
 */
async function readLastDeploy(appId: string, branch: string, source: Site["source"]): Promise<DeployStatus | undefined> {
  const out = await ctx.amp.send(new ListJobsCommand({ appId, branchName: branch, maxResults: JOB_PAGE }));
  const newest = [...(out.jobSummaries ?? [])].sort(newestFirst)[0];
  return newest ? mapJob(newest, source) : undefined;
}

/**
 * The user's own address on this site, if they have attached one.
 *
 * `root` is kept separately because it is the name AWS filed the association under, and
 * detaching needs exactly that string — deriving it back out of "www.example.com" would go
 * through the multi-label suffix heuristic in sites.ts, which is a guess where AWS has a
 * fact. HostingPoppy attaches at most one address per site; a second one added by hand in
 * the console is left alone rather than half-shown.
 */
interface AttachedDomain {
  root: string;
  status: DomainStatus;
}

async function readDomain(appId: string): Promise<AttachedDomain | undefined> {
  const out = await ctx.amp.send(new ListDomainAssociationsCommand({ appId, maxResults: 10 }));
  const assoc = (out.domainAssociations ?? [])[0];
  if (!assoc) return undefined;
  const root = assoc.domainName ?? "";
  const status = mapDomainStatus(assoc, root);
  return { root, status: status.phase === "failed" ? await explainFailure(status) : status };
}

/**
 * Ask the internet what the address answers, and say so when the answer is the reason AWS
 * gave up (DESIGN §3.3 step 4).
 *
 * Only on a failure, so this costs one DNS lookup at the end of an unhappy attach and nothing
 * at all the rest of the time. `hp-test.example.net` failed in under a minute because a
 * wildcard answered for it: "we couldn't finish connecting that address" was true, useless and
 * impossible to act on, while "it currently answers 35.219.200.108, which is not this website"
 * makes the fix obvious. A lookup that fails changes nothing — the generic sentence stands.
 */
async function explainFailure(status: DomainStatus): Promise<DomainStatus> {
  const answers = await resolveName(status.domain).catch(() => []);
  return explainDomainFailure(status, answers);
}

/**
 * What "already points at this website" means for one site, so the check can tell a name
 * that is ALREADY ours from somebody else's live site. Absent when the caller named no site —
 * the domain screen always knows which one it is on, and the answer is honest either way.
 */
async function targetForSite(siteId: string): Promise<string | undefined> {
  const site = await getSite(ctx, siteId);
  if (!site) throw noSuchSite();
  const attached = await readDomain(siteId).catch(() => undefined);
  return siteTarget(site, attached?.status);
}

/**
 * What the user's own DNS says about an address that is already attached — the same answer
 * `/domain/check` gives, sent with the domain so the screen can offer "add the record for me"
 * without a second round trip.
 *
 * Two ways of costing nothing, because this rides along with a route the domain screen polls:
 * it is skipped entirely once AWS is waiting for nothing, and it is never fatal — a check that
 * failed leaves the copy-paste table, which is built from records the caller already has.
 */
async function domainCheckFor(site: Site, attached: AttachedDomain | undefined): Promise<DomainCheck | undefined> {
  const status = attached?.status;
  if (!status) return undefined;
  // Nothing outstanding and nothing wrong = nothing to offer, and no reason to read the zone
  // every few seconds while a screen sits open on a domain that is already working.
  if (!status.records.length && status.phase !== "failed") return undefined;
  return inspectName(r53, status.domain, { target: siteTarget(site, status) })
    .then(describeDomainCheck)
    .catch(() => undefined);
}

/**
 * What the write did, in the wire contract's words (types.ts `DnsWriteResult`), plus the two
 * facts only this route knows and the user has a right to: which names were taken off
 * something else, and which zone we wrote into.
 */
async function dnsWriteResult(done: DomainRecordWrite): Promise<DnsWriteResult & Pick<DomainRecordWrite, "moved" | "unchanged" | "zone">> {
  // Only the LAST change id travels: the writes are one publish as far as the user is
  // concerned, and the newest is the one still to land.
  const changeId = done.changeIds[done.changeIds.length - 1];
  return {
    written: done.written.map((r) => r.name),
    manual: done.manual,
    ...(changeId ? { changeId } : {}),
    // Asked, not assumed — and `changeStatus` never throws, so an unreadable answer is
    // "unknown" and the screen falls back to what the name actually resolves to. A record that
    // was already right was published long before we looked.
    state: changeId ? await changeStatus(r53, changeId) : done.unchanged.length ? "published" : "unknown",
    moved: done.moved,
    unchanged: done.unchanged,
    zone: done.zone,
  };
}

/**
 * The timeline entry for one record we put in the user's DNS — named, because a DNS record is
 * a thing that now exists in their account and §14.1's promise is that nothing HostingPoppy
 * changed is hidden.
 *
 * It is filed under "Domain connected" because that is what this is a step of, and because the
 * ledger's vocabulary is the wire contract (types.ts): a "dns-record-written" action would be a
 * change to the contract and to the Resources tab's labels, for a row that reads the same
 * either way.
 */
function dnsLedgerEntry(siteName: string, written: WrittenRecord): { action: "domain-attached"; what: string; detail: string } {
  const from = written.moved?.from.find(Boolean);
  // Named in full: this is the one line that will matter if something else stops answering,
  // and "it pointed at 203.0.113.9 until now" is what makes that recoverable.
  const wasPointing = from ? ` It pointed at ${from} until now.` : "";
  return {
    action: "domain-attached",
    what: written.record.name,
    detail: `Pointed at ${written.record.value} in your ${written.zone} DNS, for ${siteName}.${wasPointing}`,
  };
}

/**
 * A site as the screens need it: what AWS knows about the app, plus how its last upload went
 * and where its custom address has got to.
 *
 * Both extra reads are best-effort. `listSites` has already proved the credentials work, so a
 * failure here is about this one app — most often a site created moments ago that has no
 * upload history yet — and a missing status pill is a far better outcome than a site list
 * that refuses to load. The two run together because they are independent, and the whole list
 * is bounded by AWS's own quota of 25 websites per region.
 */
async function describeSite(site: Site): Promise<Site> {
  const [lastDeploy, domain] = await Promise.all([
    readLastDeploy(site.id, site.branch ?? LIVE_BRANCH, site.source).catch(() => undefined),
    readDomain(site.id).catch(() => undefined),
  ]);
  return { ...site, lastDeploy, domain: domain?.status };
}

/** The Resources tab's rows for one site — the one screen where real AWS names belong. */
async function resourceRows(site: Site): Promise<ResourceRow[]> {
  // The real branch, not the default one: this is the transparency tab, where a name that
  // doesn't match what is in the account is worse than no name at all.
  const branch = site.branch ?? LIVE_BRANCH;
  const rows: ResourceRow[] = [
    {
      service: "Amplify Hosting",
      kind: "Website",
      name: site.name,
      consoleUrl: consoleUrlFor(region, site.id),
      siteId: site.id,
    },
    {
      service: "Amplify Hosting",
      kind: "Live branch",
      name: `${site.name} / ${branch}`,
      // The APP's page, not a per-branch console path. Amplify's console is a single-page
      // app and an address it does not recognise renders BLANK rather than erroring — which
      // is what the founder hit (2026-09-12). The app page lists its branches, so nothing
      // is lost, and a link that works beats a more precise one that does not.
      consoleUrl: consoleUrlFor(region, site.id),
      // For a connected site the branch is a GitHub branch, and that is where a person
      // actually wants to go — the same link the Amplify console itself offers.
      ...(branchUrl(site.repository, branch) ? { sourceUrl: branchUrl(site.repository, branch)! } : {}),
      siteId: site.id,
    },
  ];
  const domain = await readDomain(site.id).catch(() => undefined);
  if (domain) {
    rows.push({
      service: "Amplify Hosting",
      kind: "Custom domain",
      name: domain.status.domain,
      consoleUrl: consoleUrlFor(region, site.id, { domain: domain.status.domain }),
      siteId: site.id,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

async function route(method: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeSegment);

  if (method === "GET" && parts.length === 1 && parts[0] === "meta") return json(res, 200, META);

  // Everything past here calls Amplify. If the connection's region has no Amplify Hosting
  // endpoint the SDK would fail to resolve a hostname and errors.ts would read that as a
  // broken internet connection — sending the user to check their wifi over a fact about AWS.
  // /meta has already told the frontend this, so reaching a route here means something else
  // changed the connection underneath us.
  if (!regionSupported(region)) throw new HttpError(409, regionNotSupportedMessage(region));

  /**
   * Where to send the user so AWS can read their repositories — step 1 of connecting one
   * (DESIGN §3.2).
   *
   * It answers from here rather than being built on the screen because the REGION is the
   * backend's fact: AWS publishes one Amplify GitHub App per region, and installing the
   * wrong region's app grants AWS nothing and fails much later with no clue why. No AWS call
   * is made — this is a github.com address — but it sits after the region gate above, because
   * there is no point sending anyone to install an app for a region that can't host websites.
   */
  if (method === "GET" && parts.length === 2 && parts[0] === "github" && parts[1] === "setup") {
    return json(res, 200, { region, appInstallUrl: amplifyGitHubAppUrl(region) });
  }

  /**
   * What an address already does — read BEFORE anything is created (DESIGN §3.3, steps 1–2).
   *
   * The whole reason this route exists is a live failure: `hp-test.example.net` refused to
   * connect in under a minute because a catch-all `*.example.net` already answered for it, so
   * AWS asked whether the name pointed at the site, got a WRONG answer rather than no answer,
   * and gave up. Knowing that was the entire problem — the fix was one specific record.
   *
   * It creates nothing, changes nothing and may be called as often as the screen likes, which
   * is what lets the domain step answer while the user is still typing. Every way of failing
   * to look ends up as "we'll show you the records to add wherever you bought your domain" —
   * see inspectName; a domain must never fail to attach because we couldn't look it up first.
   *
   * `siteId` is optional and only sharpens the answer: with it, a name that already points at
   * THIS website reads as ours rather than as somebody's live site about to be moved.
   */
  if (method === "GET" && parts.length === 2 && parts[0] === "domain" && parts[1] === "check") {
    const address = normalizeDomain(url.searchParams.get("address") ?? "");
    const problem = validateDomain(address);
    if (problem) throw new HttpError(400, problem);

    const siteId = (url.searchParams.get("siteId") ?? "").trim();
    const target = siteId ? await targetForSite(siteId) : undefined;
    // dns.ts does the looking and never throws its way out of it; amplify.ts turns the facts
    // into the sentence and the offer. Keeping those apart is what makes every word the user
    // can read testable without AWS.
    return json(res, 200, { check: describeDomainCheck(await inspectName(r53, address, { target })) });
  }

  if (parts[0] === "sites") {
    if (parts.length === 1) {
      if (method === "GET") {
        const sites = await listSites(ctx);
        return json(res, 200, { sites: await Promise.all(sites.map(describeSite)) });
      }
      if (method === "POST") {
        const body = await readBody(req, MAX_JSON_BYTES);
        const name = normalizeSiteName(text(body, "name"));
        const problem = validateSiteName(name);
        if (problem) throw new HttpError(400, problem);
        // Passed through rather than checked here: this path can only make a finished site,
        // and the refusal for a Next.js app — which has to be built, and can only be built
        // from a repository — belongs beside the settings it is a consequence of (amplify.ts).
        const site = await createSite(ctx, name, siteKind(body));
        // Not enriched: a website created a moment ago has no uploads and no address of the
        // user's, and asking AWS about either would only slow down the screen that follows.
        record({
          action: "created",
          what: site.name,
          detail: site.defaultUrl ? `Its address is ${site.defaultUrl}` : undefined,
        });
        return json(res, 200, { site });
      }
    }

    /**
     * Connect a GitHub repository — the headline path (DESIGN §3.2): AWS builds the site in
     * the user's own account and republishes it on every push.
     *
     * It sits above the `/sites/:id` routes because "connect" would otherwise read as a
     * website id. Amplify ids are `d` followed by hex, so no real id can collide with it.
     *
     * ⚠️ The body carries the user's GitHub key. It is validated, handed to `CreateApp`, and
     * forgotten. It is never logged, never written to the ledger, and never sent back.
     */
    if (method === "POST" && parts.length === 2 && parts[1] === "connect") {
      const body = await readBody(req, MAX_JSON_BYTES);

      const name = normalizeSiteName(text(body, "name"));
      const badName = validateSiteName(name);
      if (badName) throw new HttpError(400, badName);

      const repository = text(body, "repository");
      const repo = parseRepoUrl(repository);
      // validateRepoUrl only answers null for something parseRepoUrl can read, so the second
      // half of this is unreachable — it is here because the types allow it and a thrown
      // "undefined" would be a rotten way to find that out.
      if (!repo) throw new HttpError(400, validateRepoUrl(repository) ?? "Paste the address of your repository on GitHub.");

      // An empty box is the common case, not a mistake: the screen offers "main" and almost
      // every repository uses it.
      const branch = normalizeBranch(text(body, "branch")) || DEFAULT_BRANCH;
      const badBranch = validateBranch(branch);
      if (badBranch) throw new HttpError(400, badBranch);

      const accessToken = text(body, "accessToken").trim();
      const badToken = validateToken(accessToken);
      // The KIND of key is not checked here — a warning is shown before this point, and the
      // one authority on it is the read-back inside connectRepository (DESIGN §3.2).
      if (badToken) throw new HttpError(400, badToken);

      // Both answers are possible here — this is the only path that can build anything — so
      // the kind travels with the rest and amplify.ts turns it into the three settings that
      // have to agree (platform, routing, build instructions).
      const kind = siteKind(body);

      const { site, jobId } = await connectRepository(ctx, { name, repository: repo.url, accessToken, branch, kind });
      // Recorded before anything else can go wrong: a website now exists in the user's
      // account, and the timeline has to say so whatever happens next.
      record({
        action: "created",
        what: site.name,
        // The repository, never the key. This file is on the user's disk and is shown back to
        // them in the Resources tab.
        detail: `Built from ${repo.url} (${branch})${site.defaultUrl ? `. Its address is ${site.defaultUrl}` : ""}`,
      });
      // The website IS connected and every future push will build it — but nobody should be
      // left watching a first build that was never started. Saying so beats a progress bar
      // that never moves, and the fix is one button on the website that now exists.
      if (!jobId) {
        throw new HttpError(
          502,
          "Your repository is connected, but its first build didn't start — open the website from your list and press Deploy to start it.",
        );
      }
      return json(res, 200, { site, jobId });
    }

    const id = parts[1];
    if (id) {
      if (parts.length === 2) {
        if (method === "GET") {
          const site = await getSite(ctx, id);
          if (!site) throw noSuchSite();
          return json(res, 200, { site: await describeSite(site) });
        }
        if (method === "DELETE") {
          // Read first, only so the timeline can say the website's name after it is gone.
          // deleteSite does its own fresh tag check and is what actually refuses an app we
          // didn't make; a website that has already been removed is a success, not an error.
          const site = await getSite(ctx, id);
          // DNS first, while the website still exists to tell us what its records point at.
          // Afterwards the association is gone and we could no longer tell our record from
          // one the user made themselves.
          const cleanedDns = site ? await removeDnsFor(site) : [];
          await deleteSite(ctx, id);
          if (site) {
            record({
              action: "removed",
              what: site.name,
              detail: [
                site.defaultUrl ? `${site.defaultUrl} stopped working.` : "",
                cleanedDns.length ? `Removed the DNS record for ${cleanedDns.join(", ")}.` : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            });
          }
          return json(res, 200, { ok: true, dnsRemoved: cleanedDns });
        }
      }

      /**
       * Build and publish the latest commit — "Deploy again" on a connected website, and the
       * way to start the first build if it didn't start itself when the repository was
       * connected.
       */
      if (parts[2] === "build" && parts.length === 3 && method === "POST") {
        // This read is the ownership check: getSite answers null for an app HostingPoppy
        // didn't make, and it is where the branch to build comes from.
        const site = await getSite(ctx, id);
        if (!site) throw noSuchSite();
        if (site.source !== "github") {
          throw new HttpError(
            400,
            "This website isn't connected to a repository, so there's no commit to build — upload your built site instead.",
          );
        }
        const branch = site.branch ?? LIVE_BRANCH;
        const jobId = await startBuild(ctx, id, branch);
        record({
          action: "deployed",
          what: site.name,
          detail: site.repository ? `Building the latest commit from ${site.repository} (${branch}).` : "Building the latest commit.",
        });
        return json(res, 200, { jobId, branch });
      }

      if (parts[2] === "deploy" && parts.length === 4) {
        const step = parts[3] ?? "";

        if (method === "POST" && step === "begin") {
          const body = await readBody(req, MAX_JSON_BYTES);
          // Checked here rather than at the end: without it the user would send an entire
          // site across the bridge before finding out there is nowhere to put it.
          const site = await getSite(ctx, id);
          if (!site) throw noSuchSite();
          // An Amplify app is connected to a repository or it is manual, permanently — AWS
          // offers no way to convert one into the other, and an upload to a connected app is
          // refused by AWS with an error nobody could act on. Say what to do instead.
          if (site.source === "github") {
            throw new HttpError(
              400,
              "This website builds itself from your repository — push your changes, or press Deploy again, and AWS will publish them.",
            );
          }
          return json(res, 200, staging(() => beginUpload(id, count(body, "totalBytes"))));
        }

        if (method === "POST" && step === "chunk") {
          const body = await readBody(req, MAX_CHUNK_BYTES, CHUNK_TOO_LARGE);
          // No AWS call and no second look at the site: the upload id is the authority here —
          // it was minted by `begin` against this site, and uploads.ts refuses one it doesn't
          // know, one that has expired, and any chunk that isn't the next one in order.
          const bytes = Buffer.from(text(body, "dataBase64"), "base64");
          return json(
            res,
            200,
            staging(() => appendChunk(text(body, "uploadId"), count(body, "index"), bytes)),
          );
        }

        if (method === "POST" && step === "finish") {
          const body = await readBody(req, MAX_JSON_BYTES);
          const zip = staging(() => finishUpload(text(body, "uploadId")));
          // This is the one request that legitimately runs long: the files have to reach AWS
          // before there is anything to watch. The minutes-long part — AWS unpacking and
          // publishing them — is what the status route below is polled for, so nothing is
          // held open waiting on that.
          //
          // finishUpload has already let go of the staging copy, so a failure here means
          // choosing the files again. That is the right trade: the alternative is keeping a
          // site-sized file on the user's disk for a retry that usually never comes.
          const jobId = await startDeploy(ctx, id, zip);
          const site = await getSite(ctx, id).catch(() => null);
          record({
            action: "deployed",
            what: site?.name ?? id,
            detail: `${megabytes(zip.length)} of files sent to AWS.`,
          });
          return json(res, 200, { jobId });
        }

        if (method === "GET" && step) {
          // The branch rides along in the query string rather than being read back from AWS:
          // this route is polled every few seconds while a build runs, and a website created
          // moments ago can still answer "no such app" while its tags settle — which would
          // turn the first build of a brand-new site into "that website isn't there any
          // more". The caller has the site (and its branch) already; an absent one is the one
          // live version an uploaded site has always used.
          const branch = normalizeBranch(url.searchParams.get("branch") ?? "") || LIVE_BRANCH;
          return json(res, 200, { deploy: await deployStatus(ctx, id, step, branch) });
        }
      }

      if (parts[2] === "domain" && parts.length === 3) {
        if (method === "GET") {
          const site = await getSite(ctx, id);
          if (!site) throw noSuchSite();
          // Not swallowed here, unlike in the site list: this screen's whole subject is the
          // address, so a read that failed must say so rather than read as "none attached".
          const attached = await readDomain(id);
          return json(res, 200, { domain: attached?.status ?? null, check: await domainCheckFor(site, attached) });
        }

        if (method === "POST") {
          const body = await readBody(req, MAX_JSON_BYTES);
          const address = normalizeDomain(text(body, "address"));
          const problem = validateDomain(address);
          if (problem) throw new HttpError(400, problem);
          const site = await getSite(ctx, id);
          if (!site) throw noSuchSite();
          // The address has to point at the version that actually serves — a connected site's
          // branch is whatever its repository calls it.
          //
          // `alsoWww` can only be honoured HERE. www is a second prefix inside this one
          // attachment, not a second domain, and this poppy holds no UpdateDomainAssociation
          // to add one later (see wwwSettings). An older client that sends nothing gets no
          // www — the direction that creates nothing the user did not ask for.
          const attachedNow = await attachDomain(
            ctx,
            id,
            address,
            site.branch ?? LIVE_BRANCH,
            flag(body, "alsoWww"),
          );
          // The same honesty every other path gets: on the rare occasion AWS gives up while we
          // are still holding the request, the reason names what the address actually answers
          // rather than the sentence nobody can act on.
          const domain = attachedNow.phase === "failed" ? await explainFailure(attachedNow) : attachedNow;
          record({
            action: "domain-attached",
            what: domain.domain || address,
            detail: `Connected to ${site.name}.`,
          });
          // The zone read travels with the answer so the screen can offer "add it for me" on
          // the records AWS has just asked for, without a second round trip — and so the offer
          // is made from what the zone actually holds rather than from hope.
          const check = await domainCheckFor(site, { root: splitDomain(address).root, status: domain });
          return json(res, 200, { domain, check });
        }

        if (method === "DELETE") {
          const site = await getSite(ctx, id);
          if (!site) throw noSuchSite();
          const attached = await readDomain(id);
          if (attached) {
            await detachDomain(ctx, id, attached.root);
            record({
              action: "domain-removed",
              what: attached.status.domain,
              detail: `${site.name} stays live on its AWS address.`,
            });
          }
          // Nothing attached is the state the caller asked for, so it is a success.
          return json(res, 200, { ok: true });
        }
      }

      /**
       * "Add the record for me" — the one click that saves a beginner copying two records into
       * a registrar's form (DESIGN §3.3 step 3).
       *
       * This is the only route in the poppy that changes something the whole internet reads, so
       * it is the most careful one here:
       *  - the website must be ours (`getSite` answers null otherwise, and this 404s);
       *  - the address must already be attached, because AWS is the only source of what the
       *    records should say — we never invent a target;
       *  - a name that is in use by something else is REFUSED unless the body carries the
       *    user's yes. That refusal lives in writeDomainRecords, so it cannot be skipped by a
       *    screen that forgot to ask.
       * Pressing it twice is safe: the records are upserts and anything already pointing the
       * right way is left alone.
       */
      if (parts[2] === "domain" && parts.length === 4 && parts[3] === "record" && method === "POST") {
        // Optional: a first press sends nothing at all, and only a move needs the yes.
        const body = await readBody(req, MAX_JSON_BYTES);
        const site = await getSite(ctx, id);
        if (!site) throw noSuchSite();

        const attached = await readDomain(id);
        if (!attached) {
          throw new HttpError(
            400,
            "Add your address to this website first — then we'll know what the record has to say, and we can add it for you.",
          );
        }

        const done = await writeDomainRecords(zones, attached.root, attached.status.records, {
          confirmOverwrite: flag(body, "confirmOverwrite"),
          // As each one lands, not once they all have: a run that fails on the second record
          // has still changed the user's DNS on the first, and the timeline has to say so.
          onWritten: (written) => record(dnsLedgerEntry(site.name, written)),
        });

        // Read back rather than echoing what we had: the association is what the screen shows
        // next, and AWS may already have noticed. Best-effort — the records went in either way,
        // and reporting a write as failed because a read after it did would be a lie.
        const after = await readDomain(id).catch(() => undefined);
        return json(res, 200, { domain: after?.status ?? attached.status, write: await dnsWriteResult(done) });
      }
    }
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "resources") {
    // Two sources, and they answer different questions: AWS says what EXISTS right now, the
    // ledger says what HAPPENED — including removals, which is the only place a thing that is
    // gone can still be seen.
    const sites = await listSites(ctx);
    const resources = (await Promise.all(sites.map(resourceRows))).flat();
    return json(res, 200, { resources, ledger: readLedger() });
  }

/**
 * Remove the DNS record we wrote for a website, before the website goes.
 *
 * Deleting the app alone would leave a CNAME on a name the user still owns, pointing at a
 * CloudFront distribution that no longer exists — the classic setup for a subdomain takeover,
 * where whoever next claims that distribution name serves their content on the user's domain.
 * "Leaves no trace" has to cover DNS or it is not true.
 *
 * Everything here is best-effort and nothing throws: a record we cannot read or delete must
 * never stop the website itself being removed, which is the thing the user actually asked for.
 * `removeRecordIfOurs` refuses to delete a record that no longer points where we put it, so a
 * name the user has since repointed at something of their own is left exactly alone.
 *
 * Returns the names it cleaned up, for the timeline.
 */
async function removeDnsFor(site: Site): Promise<string[]> {
  const cleaned: string[] = [];
  try {
    const attached = await readDomain(site.id);
    if (!attached) return cleaned;
    const target = siteTarget(site, attached.status);
    if (!target) return cleaned;
    const zone = await zones.findZone(attached.root);
    if (!zone) return cleaned; // somebody else's DNS — we never wrote it, so there is nothing of ours
    for (const record of attached.status.records) {
      const name = absoluteRecordName(record.name, attached.root);
      if (await removeRecordIfOurs(r53, zone.id, name, target)) cleaned.push(name);
    }
  } catch {
    // Unreadable zone, denied permission, a domain already gone: all mean "nothing we can
    // tidy", never "stop the removal".
  }
  return cleaned;
}

  // The host POSTs this at the start of teardown, and the in-app "Remove everything" button
  // calls the same route — one behaviour, whichever the user pressed. It must be safe to run
  // twice: a second run finds nothing left and says so.
  if (method === "POST" && parts.length === 1 && parts[0] === "teardown") {
    try {
      // Same reason as the single delete: read the records while the websites still exist.
      const sites = await listSites(ctx).catch(() => []);
      const dnsRemoved: string[] = [];
      for (const site of sites) dnsRemoved.push(...(await removeDnsFor(site)));
      const removed = await teardownAll(ctx);
      recordTeardown(removed);
      return json(res, 200, { ok: true, removed, dnsRemoved });
    } catch (e) {
      if (!(e instanceof TeardownIncomplete)) throw e;
      // Some went, some didn't. Naming both is the whole point — a teardown that failed
      // silently is exactly the broken promise the ecosystem cannot afford, and the user
      // needs to know which websites are still costing them money.
      recordTeardown(e.removed);
      return json(res, 500, { ok: false, message: e.message, removed: e.removed, remaining: e.remaining });
    }
  }

  return json(res, 404, {
    message:
      "HostingPoppy didn't understand that request — reopen it from AgentsPoppy, and tell us from the Feedback tab if it keeps happening.",
    detail: `No route for ${method} ${url.pathname}`,
  });
}

/** A path segment as it was typed. A malformed escape is not worth failing a request over. */
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function recordTeardown(removed: string[]): void {
  recordAll(
    removed.map((name) => ({
      action: "removed" as const,
      what: name,
      detail: "Removed when you cleared everything HostingPoppy made.",
    })),
  );
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  route(method, url, req, res)
    .catch((e: unknown) => {
      const reply = errorReply(e);
      // stderr, never the reply: the raw text is for whoever is debugging this, and the user
      // gets the sentence. A stack trace reaching a client is a shipping blocker (AGENTS.md §9).
      console.error(`[hostingpoppy] ${method} ${url.pathname} → ${reply.status}: ${reply.detail ?? reply.message}`);
      if (res.headersSent) return; // already answered, then something went wrong on the way out
      json(res, reply.status, reply.detail ? { message: reply.message, detail: reply.detail } : { message: reply.message });
    })
    .catch(() => {
      // The socket went away mid-answer. There is nobody left to tell, and an unhandled
      // rejection here would take the whole backend down with it.
    });
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`[hostingpoppy] backend listening on 127.0.0.1:${actual} (region ${region})`);
  if (usingTemporaryStorage()) {
    // Worth saying once: the websites are unaffected (they live in AWS), but the local
    // timeline is in a folder the OS may clear whenever it likes.
    console.log("[hostingpoppy] no data folder was provided — this run's history is temporary.");
  }
});
