// Everything HostingPoppy does inside the user's AWS account.
//
// One service — Amplify Hosting — and nothing else: no storage bucket, no CloudFormation,
// no certificate manager, no DNS zone, no IAM role. That is the whole reason this design
// ships (DESIGN §3). `CreateApp` and `CreateBranch` both take a tag map in the same call,
// so every resource is BORN tagged and one `tagged-as-self` grant covers the entire
// footprint; a manual deploy needs no bucket at all, because `CreateDeployment` hands back
// a presigned URL we PUT the zip to; and `DeleteApp` takes the branches, the deployments,
// the domain association and its certificate away together. If a change here seems to need
// a second AWS service, it is a wrong turn — extension.json grants amplify and nothing more.
//
// The Amplify client is injected (HostingCtx) so every decision below is unit-testable with
// no credentials and no network. The mapping functions at the bottom are pure and exported
// for exactly that reason: they carry most of the test weight.
//
// Errors thrown from here are either OUR sentence (a refusal we decided) or the raw AWS
// error, passed up untouched so the route layer runs it through errors.ts once. Two places
// translating AWS would drift, and the dictionary lives there.

import {
  type AmplifyClient,
  type App,
  CreateAppCommand,
  CreateBranchCommand,
  CreateDeploymentCommand,
  CreateDomainAssociationCommand,
  type CustomRule,
  DeleteAppCommand,
  DeleteDomainAssociationCommand,
  GetAppCommand,
  GetDomainAssociationCommand,
  GetJobCommand,
  ListAppsCommand,
  StartDeploymentCommand,
  StartJobCommand,
} from "@aws-sdk/client-amplify";

import { isOurs, resourceTags, type AttributionContext } from "./tags";
import { LIVE_BRANCH, amplifyAppName, defaultUrlFor, parseDnsRecord, splitDomain } from "./sites";
import { defaultBuildSpec, nextBuildSpec, redactToken } from "./github";
import { HttpError, rawDetail } from "./errors";
import type {
  DeployPhase,
  DeployStatus,
  DnsRecord,
  DomainCheck,
  DomainPhase,
  DomainStatus,
  ExistingRecord,
  HostedZoneRef,
  NameFacts,
  NameState,
  Site,
  SiteKind,
  SiteSource,
} from "./types";

/**
 * AWS's own documented single-page-app rewrite. It reads as: a path with no dot at all (a
 * client-side route like `/about`) or a path whose extension is NOT one of the real asset
 * extensions gets served `/index.html`.
 *
 * Without it, every deep link and every browser refresh on a client-side route returns 404 —
 * the single most common way a site that worked locally looks broken the moment it is
 * hosted. The status is 200 (a rewrite, not a redirect) so the browser keeps the address the
 * visitor asked for and the app's router can read it.
 */
const SPA_REWRITE: CustomRule = {
  source: "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
  target: "/index.html",
  status: "200",
};

/**
 * The four things about a website that its KIND decides, and nothing else does.
 *
 * They are one function returning one object rather than four arguments threaded through the
 * calls below, because they are not four decisions — they are one decision with four
 * consequences, and every one of them is right for a finished site and wrong for a Next.js
 * app. Set individually they drift, and each way of drifting ships a website that AWS builds
 * without complaint and that then does not work:
 *
 *  - **platform** — `WEB` serves finished files; `WEB_COMPUTE` runs the app. A Next.js app
 *    created as `WEB` builds happily and then serves nothing useful, because nothing is
 *    running to render its pages.
 *  - **spaRewrite** — {@link SPA_REWRITE} sends every extension-less path to `/index.html`.
 *    That is exactly right for a single-page app, whose router reads the address out of the
 *    browser, and exactly wrong for a server-rendered one: Next.js does its own routing, and
 *    the rule would shadow every route it serves — the home page on every address.
 *  - **buildSpec** — the build instructions AWS follows when the repository carries no
 *    `amplify.yml` of its own (github.ts explains why one is needed at all: framework
 *    detection belongs to Amplify's CONSOLE flow, and this poppy only ever creates apps
 *    through the API). The static spec copies a folder of finished files; the Next.js spec
 *    publishes `.next`, which is what makes Hosting RUN the app instead of serving it. Handing
 *    over the wrong one, or none, is the same outcome by a different route — a build that
 *    reports success and a site that renders nothing. Only the connected-repository path
 *    builds anything, so this is read there and nowhere else: an upload arrives already built.
 *  - **framework** — the branch's own label, and the one that has to be said at creation.
 *    A branch on a `WEB_COMPUTE` app whose framework resolves to plain `Web` fails EVERY build
 *    with `Framework Web not supported`, and the documented repair is `UpdateBranch` — which
 *    this poppy does not grant itself (extension.json), and should not have to: the answer is
 *    known at the moment the branch is made. Getting it wrong here is unrecoverable in place,
 *    which is precisely why it belongs in this object rather than at the call site.
 *
 * An unrecognised kind is the finished site: it is what this poppy has always made, and
 * conjuring a server out of a word we cannot read is the one answer that costs money.
 */
export interface AmplifySetup {
  platform: "WEB" | "WEB_COMPUTE";
  spaRewrite: boolean;
  buildSpec: string;
  /** Absent for a finished site: AWS's own default is already the right answer there. */
  framework?: string;
}

export function amplifySetupFor(kind: SiteKind): AmplifySetup {
  return kind === "nextjs"
    ? { platform: "WEB_COMPUTE", spaRewrite: false, buildSpec: nextBuildSpec(), framework: "Next.js - SSR" }
    : { platform: "WEB", spaRewrite: true, buildSpec: defaultBuildSpec() };
}

/**
 * The refusal for a Next.js app on the upload path.
 *
 * Not a wall: it names the one thing to do next, and the one case where the path they are
 * already on is the right one. A Next.js app has to be built, and this poppy cannot build
 * anything — it is confined, with no access to the user's files and no way to run a command
 * on their machine (DESIGN §4) — so the only place a build can happen is AWS, from a
 * repository. Someone whose app is configured for static export genuinely has finished files,
 * and telling them "no" would be wrong.
 */
const NEXTJS_NEEDS_A_REPOSITORY =
  "A Next.js app has to be built from its code, so connect its repository on GitHub instead — unless yours is set up for static export, in which case upload the finished files it produces and this path works today.";

/**
 * Which branch of the repository AWS serves — written onto the app itself, as a tag, in the
 * same call that creates it.
 *
 * It has to live in AWS because this backend remembers nothing between calls (server.ts), and
 * almost everything afterwards names a branch: reading a build's progress (`GetJob`), listing
 * the build history (`ListJobs`), pointing a custom address at it (`CreateDomainAssociation`).
 * AWS's own `productionBranch.branchName` is not enough on its own — it appears once a build
 * has run, which is precisely when it is needed most — and `ListBranches`/`GetBranch` are not
 * among this poppy's grants (extension.json), by design: fewer permissions, and the answer was
 * ours to write down in the first place.
 *
 * The uploaded-site path has no need for it: its one live version is always {@link LIVE_BRANCH},
 * which is what the resolution below falls back to.
 */
export const BRANCH_TAG = "hostingpoppy:branch";

/** Everything the orchestration needs to reach AWS. Client injected → unit-testable. */
export interface HostingCtx {
  amp: AmplifyClient;
  region: string;
  attribution: AttributionContext;
}

// The slices of Amplify's shapes we actually read, declared structurally so the pure
// mappers below can be tested with plain object literals instead of SDK instances. The
// real SDK types satisfy these.

export interface AppLike {
  appId?: string;
  name?: string;
  defaultDomain?: string;
  createTime?: Date;
  platform?: string;
  tags?: Record<string, string>;
  /** Empty or absent on a manual site; the repository's address on a connected one. */
  repository?: string;
  /** AWS's own note of the branch it serves — a fallback for {@link BRANCH_TAG}. */
  productionBranch?: { branchName?: string };
}

export interface StepLike {
  statusReason?: string;
}

export interface JobSummaryLike {
  jobId?: string;
  status?: string;
  startTime?: Date;
  endTime?: Date;
}

export interface JobLike {
  summary?: JobSummaryLike;
  steps?: StepLike[];
}

export interface SubDomainLike {
  subDomainSetting?: { prefix?: string; branchName?: string };
  verified?: boolean;
  dnsRecord?: string;
}

export interface DomainAssociationLike {
  domainName?: string;
  domainStatus?: string;
  statusReason?: string;
  certificateVerificationDNSRecord?: string;
  subDomains?: SubDomainLike[];
}

/**
 * Thrown when "Remove everything" finished its sweep but AWS kept something. It lives here
 * rather than in errors.ts because it carries data no generic error can: which websites went
 * and which did not, so the screen can tell the truth instead of just failing.
 */
export class TeardownIncomplete extends Error {
  constructor(
    readonly removed: string[],
    readonly remaining: string[],
  ) {
    super(`AWS still has ${remaining.join(", ")} — try "Remove everything" again in a moment.`);
    this.name = "TeardownIncomplete";
  }
}

/**
 * True when AWS says the thing simply is not there.
 *
 * Deliberately does NOT include access failures. A denied call looks like "absent" from one
 * angle, but folding it in here would turn a revoked or paused AgentsPoppy connection into
 * an empty, cheerful "you have no websites" screen — exactly when the user needs to be told
 * to reconnect.
 */
function isMissing(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    err?.name === "NotFoundException" ||
    err?.name === "ResourceNotFoundException" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Read an app back from AWS and confirm it carries our attribution tags.
 *
 * The read is FRESH on every destructive call on purpose: the caller hands us an id that
 * came from a screen which may be minutes old, and "this is ours" is the only thing standing
 * between a bug and deleting a website somebody built by hand. Returns null when the app is
 * already gone — which every removal path treats as success, because teardown can run twice.
 */
async function ourApp(ctx: HostingCtx, appId: string): Promise<App | null> {
  let app: App | undefined;
  try {
    app = (await ctx.amp.send(new GetAppCommand({ appId }))).app;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  if (!app) return null;
  if (!isOurs(app.tags)) {
    throw new HttpError(
      403,
      "HostingPoppy didn't create that website, so it won't change it — remove it in the AWS console if that's what you meant.",
    );
  }
  return app;
}

/**
 * Every website HostingPoppy hosts in this account.
 *
 * `ListApps` is the one call granted account-wide (extension.json), because there is no way
 * to ask AWS for "only mine" — so the tag filter here is what keeps other people's hosting
 * out of our screens. It pages to the very end rather than stopping at the first hundred:
 * this list is what "Remove everything" sweeps, and a site it never saw is a site it leaves
 * behind.
 */
export async function listSites(ctx: HostingCtx): Promise<Site[]> {
  const sites: Site[] = [];
  let nextToken: string | undefined;
  for (;;) {
    const out = await ctx.amp.send(new ListAppsCommand({ maxResults: 100, nextToken }));
    for (const app of out.apps ?? []) {
      if (isOurs(app.tags)) sites.push(siteFromApp(app, ctx.region));
    }
    const following: string | undefined = out.nextToken;
    // A token that comes back unchanged would page forever and hang the tab waiting on it.
    if (!following || following === nextToken) break;
    nextToken = following;
  }
  return sites.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Make a new website for files the user sends up themselves: the hosting app, then its live
 * branch. Both are created carrying our tags in the same call — an untagged resource is
 * invisible to teardown, and AWS refuses the call outright under our scoped credentials.
 *
 * `kind` is what the user answered on the first screen, and this path can only honour one of
 * the two answers — a Next.js app is refused here rather than in the screen that asked, so a
 * screen cannot forget to ask and no future caller can reach AWS around it. What is left is
 * always the finished site, and its settings still come from {@link amplifySetupFor} rather
 * than being written out again here: one place decides, or the two places drift.
 */
export async function createSite(ctx: HostingCtx, name: string, kind: SiteKind): Promise<Site> {
  if (kind === "nextjs") throw new HttpError(400, NEXTJS_NEEDS_A_REPOSITORY);
  const setup = amplifySetupFor(kind);
  const tags = resourceTags(ctx.attribution);

  const created = await ctx.amp.send(
    new CreateAppCommand({
      name: amplifyAppName(name),
      platform: setup.platform,
      ...(setup.spaRewrite ? { customRules: [SPA_REWRITE] } : {}),
      tags,
    }),
  );
  const app = created.app;
  if (!app?.appId) {
    throw new Error("AWS didn't finish making your website — try again in a moment.");
  }

  try {
    await ctx.amp.send(
      new CreateBranchCommand({
        appId: app.appId,
        branchName: LIVE_BRANCH,
        stage: "PRODUCTION",
        // Nothing is ever built inside the user's account on this path — the frontend hands
        // us an already-built site — so auto-building would only queue work that fails.
        enableAutoBuild: false,
        tags,
      }),
    );
  } catch (e) {
    // A website with no live branch can't be deployed to and doesn't appear as something the
    // user can remove: the worst possible outcome, an invisible resource on their bill. Undo
    // it ourselves. This calls DeleteApp directly rather than deleteSite(), because the tag
    // read deleteSite does can lag a create by a second or two — and a rollback that fails is
    // precisely the leak being prevented. The branch failure is the one worth reporting, so
    // a failed cleanup does not replace it.
    await ctx.amp.send(new DeleteAppCommand({ appId: app.appId })).catch(() => undefined);
    throw e;
  }

  return siteFromApp(app, ctx.region);
}

/** What connecting a repository needs. The token is the ONLY secret this poppy ever holds. */
export interface ConnectRepositoryInput {
  /** What the user calls this website. */
  name: string;
  /** The canonical `https://github.com/owner/repo` address (github.ts parsed it). */
  repository: string;
  /**
   * The user's fine-grained GitHub key.
   *
   * It goes to their own AWS account in the `CreateApp` call below and nowhere else. It is
   * never logged, never written down, never returned, and `scrubToken` takes it back out of
   * anything AWS says on the way past. Treat it like a password in every code path.
   */
  accessToken: string;
  /** The branch AWS serves and rebuilds on every push. */
  branch: string;
  /**
   * What the user said they were putting online. Required rather than defaulted, because
   * this is the path where BOTH answers are possible and guessing the wrong one produces a
   * website that builds cleanly and then doesn't work — see {@link amplifySetupFor}.
   */
  kind: SiteKind;
}

export interface ConnectedSite {
  site: Site;
  /**
   * The first build, when AWS accepted it. Absent means the website IS connected and future
   * pushes will build it, but the first build didn't start — the screen should offer to
   * start one rather than wait for something that isn't coming.
   */
  jobId?: string;
}

/** The one thing to do next, whichever way the undo went. Written once so it cannot drift. */
const MAKE_A_NEW_KEY =
  "Make a fine-grained key on GitHub (they start with github_pat_) and connect your repository again.";

/**
 * The sentence for the one failure that cannot be repaired, only undone.
 *
 * A classic (`ghp_…`) key makes AWS wire the repository up the deprecated deploy-key way, and
 * `UpdateApp` with a key of the wrong kind downgrades an app that was already right — so
 * there is no fix except delete and recreate, and doing that later would cost the site its
 * address and its domain validation. Doing it NOW costs nothing, which is why the read-back
 * exists at all (DESIGN §3.2).
 */
const WRONG_KEY_KIND = `That key connected your repository the old way, which AWS can't change afterwards — so nothing was kept. ${MAKE_A_NEW_KEY}`;

/**
 * The same refusal, for when the undo did not go through.
 *
 * Undoing is a `DeleteApp` call, and that call can be throttled or refused like any other.
 * "Nothing was kept" is a claim about the user's account, so it is only made when the delete
 * actually succeeded — otherwise they would be told nothing exists while a billable website
 * they can never repair sits in their account under a name nobody gave them. So name it, and
 * name both places it can be removed from.
 */
function wrongKeyKindLeftover(siteName: string): string {
  return `That key connected your repository the old way, which AWS can't change afterwards, and we couldn't remove the half-made website "${siteName}" — it's still in your account, so remove it from your websites list (it's in the Resources tab too). ${MAKE_A_NEW_KEY}`;
}

/**
 * The wrong-wiring refusal, marked so the rollback below can tell it apart from every other
 * way connecting can fail and finish the sentence honestly. It carries the "nothing was kept"
 * wording, which is what the rollback rewrites when the cleanup did not go through — and what
 * still reads correctly in the impossible case that this escapes uncaught.
 */
class WrongKeyKindError extends HttpError {
  constructor() {
    super(400, WRONG_KEY_KIND);
  }
}

/**
 * Take the user's key back out of an error before anyone else sees it.
 *
 * Nothing we write puts it in a message, but an error from AWS or from the runtime is not
 * ours to predict, and from here it travels through a log line and a "technical details"
 * disclosure. The error object itself is kept — its `name` and `$metadata` are what errors.ts
 * reads to choose a sentence — so only the text is rewritten.
 */
function scrubToken(e: unknown, token: string): unknown {
  if (e instanceof Error && typeof e.message === "string") e.message = redactToken(e.message, token);
  return e;
}

/**
 * Prove AWS wired the repository up the modern way, or refuse the whole thing.
 *
 * There is no request field that asks for this and no response field on `CreateApp` we can
 * trust instead: reading the app back is the ONLY way to know which wiring we got. Anything
 * other than `TOKEN` — including AWS not saying — is treated as the wrong kind, because the
 * cost of being wrong in that direction is one retry, and the cost of being wrong in the
 * other is a website that has to be rebuilt from scratch weeks later (DESIGN §3.2).
 */
async function assertModernWiring(ctx: HostingCtx, appId: string): Promise<App | undefined> {
  const back = await ctx.amp.send(new GetAppCommand({ appId }));
  if (back.app?.repositoryCloneMethod !== "TOKEN") throw new WrongKeyKindError();
  // Handed back rather than discarded: this is AWS's own description of the website that now
  // exists, which is a better answer than the echo of our own request — see the end of
  // connectRepository.
  return back.app;
}

/**
 * Connect a GitHub repository, so every push puts the site live — the headline path
 * (DESIGN §3.2). The user has already installed the Amplify GitHub App and made a key on
 * github.com; this is the AWS half, and the AWS console is not involved at any point.
 *
 * It is also the ONLY way a Next.js app can be put online: it has to be built, and the only
 * machine that can build it is AWS (DESIGN §4). What that changes is entirely in
 * {@link amplifySetupFor} — the calls below are the same four in the same order.
 *
 * Four calls, in this order, and the order is the point:
 *  1. `CreateApp` with the repository, the key and — for a finished site — a build spec
 *     (github.ts explains why we supply one, and {@link amplifySetupFor} why a Next.js app
 *     gets none), born carrying our tags plus the branch.
 *  2. Read it back and check the wiring — see {@link assertModernWiring}. Anything wrong here
 *     is undone immediately, while undoing is free.
 *  3. `CreateBranch` with auto-build on, which is what makes a push deploy.
 *  4. `StartJob`, because an app created through the API does NOT build by itself — without
 *     it the user watches a site that never appears.
 *
 * For a finished site the single-page-app rewrite is set here too, from the SAME constant the
 * uploaded-site path uses — one rule, two callers, so the two can never drift apart. It was
 * left off at first on the theory that Amplify's framework detection would take care of
 * routing during a Git build, which is not a claim AWS's documentation or DESIGN §3.2 makes
 * anywhere. We are the ones promising, in our own copy, that deep links and refreshes work; a
 * promise kept only when an undocumented detection step happens to fire is not a promise, and
 * when it doesn't fire every
 * client-side route 404s on refresh — the exact failure {@link SPA_REWRITE} exists to prevent.
 * Amplify may well detect the framework as well; the explicit rule is the half that is
 * deterministic, and which one wins is what the live test is for — PLAN §4 L9 already says the
 * rule is set here explicitly, so this is the code catching up with the plan rather than a new
 * decision. Confirm there: a deep link and a browser refresh on a connected React site, and a
 * repository building a multi-page site still serving its own pages.
 *
 * It goes on for a finished site, which AWS only serves, and comes OFF for a Next.js app,
 * which AWS runs: a server-rendered app does its own routing, and rewriting every
 * extension-less path to `/index.html` would shadow every route it serves. That is
 * {@link amplifySetupFor}'s call, not this function's, and it is made in one place beside the
 * other two settings it can never be right without.
 */
export async function connectRepository(ctx: HostingCtx, input: ConnectRepositoryInput): Promise<ConnectedSite> {
  const { accessToken, branch, repository } = input;
  const setup = amplifySetupFor(input.kind);
  const tags = { ...resourceTags(ctx.attribution), [BRANCH_TAG]: branch };

  let app: App | undefined;
  try {
    app = (
      await ctx.amp.send(
        new CreateAppCommand({
          name: amplifyAppName(input.name),
          platform: setup.platform,
          repository,
          accessToken,
          buildSpec: setup.buildSpec,
          // Spread rather than set to undefined: a Next.js app must reach AWS with no rewrite
          // rule present at all. Sending nothing is the instruction.
          ...(setup.spaRewrite ? { customRules: [SPA_REWRITE] } : {}),
          tags,
        }),
      )
    ).app;
  } catch (e) {
    throw scrubToken(e, accessToken);
  }
  if (!app?.appId) {
    throw new Error("AWS didn't finish connecting your repository — try again in a moment.");
  }
  const appId = app.appId;

  let confirmed: App | undefined;
  try {
    confirmed = await assertModernWiring(ctx, appId);
    await ctx.amp.send(
      new CreateBranchCommand({
        appId,
        branchName: branch,
        stage: "PRODUCTION",
        // The whole promise of this path: AWS rebuilds and republishes on every push.
        enableAutoBuild: true,
        ...(setup.framework ? { framework: setup.framework } : {}),
        tags,
      }),
    );
  } catch (e) {
    // Undo it. A half-connected app is the worst outcome available: it is on the user's bill,
    // it cannot be deployed to, and if the wiring was the problem it can never be repaired in
    // place. Same shape as createSite's rollback, and for the same reason it calls DeleteApp
    // directly — a tag read can lag a create by a second or two, and a rollback that fails is
    // precisely the leak being prevented. The original failure is the one worth reporting.
    //
    // Whether it worked is kept, not swallowed: the wrong-key sentence tells the user what is
    // and isn't left in their account, and that claim has to be true (wrongKeyKindLeftover).
    // Every other failure here reports itself and claims nothing about cleanup, so it needs
    // no second wording.
    const removed = await ctx.amp.send(new DeleteAppCommand({ appId })).then(
      () => true,
      // AWS saying the app isn't there means the goal is met by another route — nothing is
      // left behind, which is the only thing the sentence below is claiming.
      (cleanupFailure: unknown) => isMissing(cleanupFailure),
    );
    // Named with what AWS stored, because that is what the websites list and the Resources tab
    // show — telling the user to look for the name they typed would send them hunting for a
    // website listed under a sanitised version of it.
    if (e instanceof WrongKeyKindError && !removed) {
      throw new HttpError(400, wrongKeyKindLeftover(app.name ?? appId));
    }
    throw scrubToken(e, accessToken);
  }

  // Best effort, deliberately: everything above is what makes the site exist and keep itself
  // up to date, and a first build that didn't start is a button away, not a reason to throw
  // away a correctly connected repository.
  let jobId: string | undefined;
  try {
    jobId = await startBuild(ctx, appId, branch);
  } catch (e) {
    // Redacted even though `StartJob` is never handed the key: "the key is never logged" is
    // a rule, not a judgement call, and one call here is cheaper than reasoning about it
    // again the next time this line is edited.
    console.error(`[hostingpoppy] connected ${appId} but its first build didn't start: ${redactToken(String(e), accessToken)}`);
  }

  // AWS's own description of the website wins over the echo of our request. The read-back is
  // already in hand (it is what proved the wiring), and what it settles is `platform`: the
  // screens use it to say whether this website runs on a server, and a claim about the user's
  // AWS account should come from their AWS account. The repository and the tags are then put
  // back on top, because those two are ours to state — the branch tag in particular is set in
  // this same call and AWS's copy of it can lag by a moment.
  const site = siteFromApp({ ...app, ...confirmed, repository, tags }, ctx.region);
  return jobId ? { site, jobId } : { site };
}

/**
 * Build and publish the latest commit — "Deploy again" on a connected site, and the first
 * build after connecting one.
 *
 * Ownership is proved by the caller: every route that reaches here has just read the site
 * back with `getSite`, which answers null for an app that isn't ours. This is the one
 * mutating call in this file that doesn't re-read, because the read it would make is the one
 * the route made a moment earlier, and starting a build changes nothing — it spends a few
 * pennies of the user's build minutes on a website that is already theirs.
 */
export async function startBuild(ctx: HostingCtx, appId: string, branch: string = LIVE_BRANCH): Promise<string> {
  const started = await ctx.amp.send(new StartJobCommand({ appId, branchName: branch, jobType: "RELEASE" }));
  const jobId = started.jobSummary?.jobId;
  if (!jobId) {
    throw new Error("AWS started building your site but didn't say how to follow it — check back on this website in a moment.");
  }
  return jobId;
}

/** One website, or null when it isn't there. Absence is an answer, not an error. */
export async function getSite(ctx: HostingCtx, appId: string): Promise<Site | null> {
  let app: App | undefined;
  try {
    app = (await ctx.amp.send(new GetAppCommand({ appId }))).app;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  // An app that isn't ours is, as far as this poppy is concerned, absent — reporting it
  // would put somebody else's hosting on a screen that offers to delete things.
  if (!app || !isOurs(app.tags)) return null;
  return siteFromApp(app, ctx.region);
}

/**
 * Remove a website and everything under it. Refuses anything that isn't ours, and treats an
 * already-missing website as done — teardown is allowed to run twice.
 */
export async function deleteSite(ctx: HostingCtx, appId: string): Promise<void> {
  if (!(await ourApp(ctx, appId))) return;
  try {
    await ctx.amp.send(new DeleteAppCommand({ appId }));
  } catch (e) {
    if (isMissing(e)) return;
    throw e;
  }
}

/**
 * Put a built site live: ask AWS where to put the bytes, send them, then tell AWS to publish
 * them. Returns the id to follow the upload with.
 */
export async function startDeploy(ctx: HostingCtx, appId: string, zip: Buffer): Promise<string> {
  const created = await ctx.amp.send(new CreateDeploymentCommand({ appId, branchName: LIVE_BRANCH }));
  const uploadUrl = created.zipUploadUrl;
  if (!uploadUrl) {
    throw new Error("AWS didn't give us anywhere to put your files — try the upload again in a moment.");
  }

  let res: Response;
  try {
    // A presigned URL carries its own signature in the query string. Adding an Authorization
    // header — or any header signed differently — turns this into a 403, so this is a bare
    // PUT of the bytes and deliberately not an S3 client. It is also why this poppy needs no
    // storage grant at all: AWS expands the archive on its side.
    res = await fetch(uploadUrl, {
      method: "PUT",
      body: zip,
      headers: { "content-type": "application/zip" },
    });
  } catch (e) {
    throw new Error("Your files couldn't reach AWS — check your internet connection and try again.", { cause: e });
  }
  if (!res.ok) {
    // The body is AWS's XML explanation. It belongs behind "technical details", never in the
    // sentence the user reads, so it rides along on `cause` for errors.ts to surface there.
    const detail = await res.text().catch(() => "");
    throw new Error(`Your files couldn't reach AWS (${res.status}) — try the upload again.`, { cause: detail });
  }

  const started = await ctx.amp.send(
    new StartDeploymentCommand({ appId, branchName: LIVE_BRANCH, jobId: created.jobId }),
  );
  // Older API behaviour returns the id from the first call, newer from the second. Either is
  // the same upload; take whichever we were given.
  const jobId = started.jobSummary?.jobId ?? created.jobId;
  if (!jobId) {
    throw new Error("Your files reached AWS but it didn't say how to follow them — check back on this website in a moment.");
  }
  return jobId;
}

/**
 * How far along an upload — or a build from GitHub — is.
 *
 * `branch` defaults to the uploaded-site path's one live version, which is also what every
 * site made before repositories could be connected uses. A connected site passes its own.
 *
 * `source` decides the WORDS a failure gets, and nothing else (see {@link mapJob}). Callers
 * holding the site pass it; the status route is polled every few seconds and deliberately
 * holds nothing about the site, so when the answer actually matters this asks AWS itself.
 */
export async function deployStatus(
  ctx: HostingCtx,
  appId: string,
  jobId: string,
  branch: string = LIVE_BRANCH,
  source?: SiteSource,
): Promise<DeployStatus> {
  try {
    const out = await ctx.amp.send(new GetJobCommand({ appId, branchName: branch, jobId }));
    if (!out.job) return { jobId, phase: "pending" };
    const status = mapJob(out.job, source ?? "upload");
    // Only a job that ended badly carries a sentence, so this second read happens once at
    // the end of an unhappy deploy and never on the happy path or on the polls before it.
    // It is worth that one call: "check your zip has index.html at the top level" is a dead
    // end for somebody whose site is built from a repository — there is no zip to check —
    // and by the time a job has failed the app has long since settled, so the read is safe
    // in a way it would not be in the seconds after a site is created.
    if (source || !status.reason) return status;
    const learned = await sourceOfApp(ctx, appId);
    return learned ? mapJob(out.job, learned) : status;
  } catch (e) {
    // AWS is eventually consistent right after an upload starts: the id it just handed back
    // can answer 404 for a second or two. Calling that a failure would make a perfectly
    // healthy upload look broken, so report it as "not started yet" and let the next poll
    // settle it.
    if (isMissing(e)) return { jobId, phase: "pending" };
    throw e;
  }
}

/**
 * Whether AWS builds this site from a repository or serves what was uploaded to it — read
 * from the app itself, which is where AWS keeps the answer: an app with a repository is
 * git-connected, one without can only ever be uploaded to, and neither can become the other.
 *
 * Undefined when AWS couldn't be asked. The caller then keeps its safe default rather than
 * losing a status the user is waiting on to a second call that was only ever about wording.
 */
async function sourceOfApp(ctx: HostingCtx, appId: string): Promise<SiteSource | undefined> {
  try {
    const out = await ctx.amp.send(new GetAppCommand({ appId }));
    return (out.app?.repository ?? "").trim() ? "github" : "upload";
  } catch {
    return undefined;
  }
}

/**
 * Point the user's own address at this website.
 *
 * There are no tags on this call because AWS accepts none: `CreateDomainAssociation` has no
 * tags field, and neither does the `DomainAssociation` it returns. That is a permissions fact,
 * not a detail — the broker compiles every `Create*` action in a `tagged-as-self` grant into a
 * statement conditioned on `aws:RequestTag`, chosen by the ACTION NAME, so a create that cannot
 * carry tags can never satisfy it and is refused outright. The parent app's tags do not help:
 * IAM is evaluating the request, not the app. That is why this action (and the deployment ones)
 * sit in the name-scoped grant in extension.json rather than beside CreateApp — and why
 * ownership here is enforced by our own `isOurs` check instead of by IAM.
 *
 * Deleting the app still removes the association and its certificate, so teardown is unaffected.
 */
export async function attachDomain(
  ctx: HostingCtx,
  appId: string,
  address: string,
  branch: string = LIVE_BRANCH,
  alsoWww = false,
): Promise<DomainStatus> {
  const { root, prefix } = splitDomain(address);
  const out = await ctx.amp.send(
    new CreateDomainAssociationCommand({
      appId,
      domainName: root,
      // The address has to point at the version that actually serves. On a connected site
      // that is the repository's branch, which is rarely — but not always — the same name the
      // uploaded-site path uses.
      subDomainSettings: wwwSettings(prefix, branch, alsoWww),
    }),
  );
  const assoc = out.domainAssociation;
  if (!assoc) {
    throw new Error("AWS took your address but didn't say what to do next — reopen this website in a moment to see the records to add.");
  }
  return mapDomainStatus(assoc, address);
}

/**
 * The prefixes one domain attachment covers.
 *
 * `www.example.com` is NOT a second domain in AWS's model — it is a second prefix inside the
 * one attachment that covers `example.com`. Two consequences this function exists to honour:
 *
 *  - it can only be decided HERE, in the call that creates the attachment. Adding it later
 *    needs `UpdateDomainAssociation`, which this poppy deliberately does not hold, so the only
 *    other route is detach and re-attach — minutes offline and a fresh certificate;
 *  - adding the DNS by hand instead does NOT work, and fails in a way that looks like a broken
 *    site rather than a missing setting. Proven against the founder's live site on 2026-09-12:
 *    with the record pointed at the right CloudFront, a request for the www name returned
 *    `403 {"message":"Forbidden"}`. The certificate was fine — AWS issues a wildcard, so TLS
 *    succeeded — but CloudFront serves only names it has been told to answer for.
 *
 * Only a ROOT domain gets the offer: `www.shop.example.com` is not a name anybody wants, and
 * a user who typed a subdomain has already said which name they mean.
 */
export function wwwSettings(
  prefix: string,
  branch: string,
  alsoWww: boolean,
): Array<{ prefix: string; branchName: string }> {
  const settings = [{ prefix, branchName: branch }];
  if (alsoWww && prefix === "") settings.push({ prefix: "www", branchName: branch });
  return settings;
}

/** Where the user's own address has got to, or null when none is attached. */
export async function domainStatus(ctx: HostingCtx, appId: string, root: string): Promise<DomainStatus | null> {
  try {
    const out = await ctx.amp.send(new GetDomainAssociationCommand({ appId, domainName: root }));
    if (!out.domainAssociation) return null;
    return mapDomainStatus(out.domainAssociation, root);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Disconnect the user's own address (the website stays live on its AWS address). */
export async function detachDomain(ctx: HostingCtx, appId: string, root: string): Promise<void> {
  // Same fresh tag check as removing a website: this throws away a live address and its
  // certificate, so it may only ever run against something HostingPoppy made.
  if (!(await ourApp(ctx, appId))) return;
  try {
    await ctx.amp.send(new DeleteDomainAssociationCommand({ appId, domainName: root }));
  } catch (e) {
    if (isMissing(e)) return; // already detached — doing it twice is not a failure
    throw e;
  }
}

/**
 * "Remove everything": delete every website we made, and say which ones went.
 *
 * Idempotent — a second run finds nothing and returns an empty list. One website refusing to
 * go never strands the rest: the host calls this to prove nothing of ours is left behind, so
 * finishing the sweep matters more than the first failure, and what survived is named in the
 * error thrown once the loop is done.
 */
export async function teardownAll(ctx: HostingCtx): Promise<string[]> {
  const sites = await listSites(ctx);
  const removed: string[] = [];
  const remaining: string[] = [];

  for (const site of sites) {
    try {
      await deleteSite(ctx, site.id);
      removed.push(site.name);
    } catch {
      remaining.push(site.name);
    }
  }

  if (remaining.length) throw new TeardownIncomplete(removed, remaining);
  return removed;
}

// ---------------------------------------------------------------------------
// Pure mapping — AWS's vocabulary in, the wire contract (types.ts) out.
// ---------------------------------------------------------------------------

/**
 * `region` is carried here (and nothing reads it yet) because every caller already holds it
 * and the Resources tab's console links are region-scoped: keeping the single App → Site
 * mapper ready for that field means adding it later touches one function, not five call
 * sites. The Site wire shape itself is frozen and has no region.
 */
export function siteFromApp(app: AppLike, region: string): Site {
  const id = app.appId ?? "";
  // AWS always sends the address back, but a site caught mid-creation has been seen without
  // it, and a website with no address to click is a dead screen. It is always this shape.
  const defaultDomain = app.defaultDomain ?? `${id}.amplifyapp.com`;
  // AWS's own answer, not something we remembered: an app with a repository is git-connected
  // and can only ever be built from it, an app without one can only ever be uploaded to. The
  // screens need this to know which of the two buttons to offer, and offering the wrong one
  // is a dead end rather than a mistake the user can back out of.
  const repository = (app.repository ?? "").trim();
  const source: SiteSource = repository ? "github" : "upload";
  const branch = branchOf(app);
  return {
    id,
    source,
    ...(repository ? { repository } : {}),
    branch,
    // What AWS actually stored, not what was typed: the two can differ (the name is
    // sanitised on the way in), and showing the typed one would rename the site under the
    // user the first time the list refreshes.
    name: app.name ?? id,
    // The branch that actually serves, not the uploaded-site default: a connected site on
    // `master` lives at https://master.<app>.amplifyapp.com, and the wrong link is the first
    // thing the user clicks.
    defaultUrl: defaultUrlFor(branchLabel(branch), defaultDomain),
    // An absent timestamp shows as nothing rather than as 1970, which is a visible lie.
    createdAt: isoOf(app.createTime) ?? "",
    // Whether this website renders its pages on a server, as AWS reports it — never as we
    // asked for it. The two can differ: a website made before this app was installed, one
    // edited in the AWS console, or simply a request that didn't land the way we meant it to.
    // WEB_DYNAMIC — Amplify's retired server-rendering mode, which we never ask for — reads as
    // a finished site, because everything the screens do with the answer (offer a zip upload,
    // say the site runs on a server) is right for it either way.
    platform: app.platform === "WEB_COMPUTE" ? "WEB_COMPUTE" : "WEB",
  };
}

/**
 * The branch's name as it appears in the site's address.
 *
 * Amplify serves each branch at `<branch>.<app>.amplifyapp.com`, and a DNS label holds only
 * letters, digits and hyphens — so a branch called `release/2.0` is served at `release-2-0`.
 * Nearly every branch this touches is `main` and comes through unchanged; the substitution
 * only matters for the few that don't, and getting it wrong costs a link that 404s, never a
 * wrong call to AWS.
 */
function branchLabel(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The branch this site serves.
 *
 * Our tag first, because it is the only source that is right from the moment the app exists;
 * AWS's own note second, for a site connected before the tag existed or edited in the console;
 * and the uploaded-site default last, which is what every manual site has always used.
 */
export function branchOf(app: AppLike): string {
  const tagged = app.tags?.[BRANCH_TAG]?.trim();
  if (tagged) return tagged;
  const known = app.productionBranch?.branchName?.trim();
  return known || LIVE_BRANCH;
}

const DEPLOY_PHASE: Record<string, DeployPhase> = {
  CREATED: "pending",
  PENDING: "pending",
  PROVISIONING: "running",
  RUNNING: "running",
  SUCCEED: "succeeded",
  FAILED: "failed",
  // Still in flight. Only somebody in the AWS console can cancel an upload — stopping one is
  // not among our grants — and the screen must keep polling until it settles at CANCELLED
  // rather than declaring it over while AWS is still winding down.
  CANCELLING: "running",
  CANCELLED: "cancelled",
};

/**
 * Accepts either the whole job or just its summary — AWS returns both shapes.
 *
 * `source` is only ever read for the sentence a failure gets, and it defaults to the
 * uploaded-site path for the same reason the wire contract does (types.ts): every site made
 * before repositories could be connected is one, so an absent answer is that one.
 */
export function mapJob(input: JobLike | JobSummaryLike, source: SiteSource = "upload"): DeployStatus {
  const job = input as JobLike & JobSummaryLike;
  const summary: JobSummaryLike = job.summary ?? job;
  const phase = DEPLOY_PHASE[summary.status ?? ""] ?? "pending";
  return {
    jobId: summary.jobId ?? "",
    phase,
    startedAt: isoOf(summary.startTime),
    finishedAt: isoOf(summary.endTime),
    reason: deployReason(phase, job.steps ?? [], source),
  };
}

/**
 * One sentence for a deploy that didn't work out, in the words that fit how this site gets
 * its code.
 *
 * The two are different failures with different fixes, and this used to answer every one of
 * them with zip advice: somebody whose site is built from a repository was told to check a
 * file they never made, while the thing that would actually help — the build log, and a push
 * — went unmentioned. An Amplify app is connected or manual permanently, so there is no case
 * where both sentences could be right.
 *
 * AWS's own text stays out of it (the wire contract says this field is never a raw error),
 * but it is read first, because within each path the failures divide again: "we couldn't
 * open your file" and "your file was fine but didn't publish" send the user to two different
 * places, and so do "AWS can't read your repository" and "your code didn't build".
 */
function deployReason(phase: DeployPhase, steps: StepLike[], source: SiteSource): string | undefined {
  const fromRepo = source === "github";
  if (phase === "cancelled") {
    return fromRepo
      ? "That build was stopped before it finished — you can start it again whenever you're ready."
      : "That upload was stopped before it finished — you can upload again whenever you're ready.";
  }
  if (phase !== "failed") return undefined;

  const raw = steps.map((s) => s.statusReason ?? "").join(" ");

  if (fromRepo) {
    // A repository AWS can no longer read is not a broken build: the code may be perfect and
    // pushing again would change nothing. It happens for real — the repository is renamed or
    // made private, or AWS's access to it is withdrawn on GitHub — and sending that user to
    // the build log wastes their afternoon.
    if (/clone|access denied|permission|unauthorized|not authorized|authenticat|repository not found/i.test(raw)) {
      return "AWS couldn't read your repository — check it still exists and that AWS still has access to it on GitHub, then start the build again.";
    }
    // UX.md's dictionary entry, word for word. The log itself is AWS's to show; we say where.
    return "Your site didn't build. The last line of the build log usually says why — fix it on GitHub and push again.";
  }

  if (/zip|archive|unzip|extract|corrupt/i.test(raw)) {
    return "AWS couldn't open that file — make sure it's a .zip of your built site, then try again.";
  }
  return "That upload didn't go live — check the zip has your site's files at the top level, including index.html, then try again.";
}

const DOMAIN_PHASE: Record<string, DomainPhase> = {
  AVAILABLE: "live",
  CREATING: "verifying",
  REQUESTING_CERTIFICATE: "verifying",
  PENDING_VERIFICATION: "verifying",
  // Amplify's bring-your-own-certificate path. We never ask for it, but an address edited in
  // the AWS console can land here, and for the user it is the same "AWS is sorting out the
  // security certificate" wait.
  IMPORTING_CUSTOM_CERTIFICATE: "verifying",
  AWAITING_APP_CNAME: "pending-dns",
  PENDING_DEPLOYMENT: "pending-dns",
  IN_PROGRESS: "pending-dns",
  UPDATING: "pending-dns",
  FAILED: "failed",
};

/**
 * Where a custom address stands, and what the user still owes their DNS provider.
 *
 * `address` is a fallback only: the reader that polls this knows the root domain but not the
 * prefix, and the association itself is the one source that can say `www.example.com` rather
 * than `example.com`. Right after the address is attached the sub-domain list can still be
 * empty, which is the only time the fallback is used.
 */
export function mapDomainStatus(assoc: DomainAssociationLike, address: string): DomainStatus {
  const root = assoc.domainName ?? address;
  const subDomains = assoc.subDomains ?? [];
  const prefix = subDomains[0]?.subDomainSetting?.prefix;
  const domain = subDomains.length ? (prefix ? `${prefix}.${root}` : root) : address || root;

  // An unrecognised status is treated as the earliest wait: the screen keeps polling and
  // keeps showing the certificate record. Guessing "live" or "failed" would be a lie, and
  // AWS has added states to this list before.
  const phase = DOMAIN_PHASE[assoc.domainStatus ?? ""] ?? "verifying";

  const records: DnsRecord[] = [];
  if (phase === "verifying" || phase === "failed") {
    pushRecord(records, assoc.certificateVerificationDNSRecord, "certificate-validation");
  }
  if (phase === "pending-dns" || phase === "failed") {
    for (const sub of subDomains) {
      // A verified sub-domain owes nothing. Showing its record again reads as "you got it
      // wrong", which is the opposite of true.
      if (!sub.verified) pushRecord(records, sub.dnsRecord, "point-your-domain");
    }
  }
  // On a failure we don't know which step gave up, so everything still outstanding is shown:
  // an unadded record is by far the most common reason a domain never completes.

  return {
    domain,
    phase,
    records,
    url: phase === "live" ? `https://${domain}` : undefined,
    reason: domainReason(phase, records.length, assoc.statusReason),
    // Verbatim, and only when AWS actually said something — an empty disclosure is noise.
    detail: assoc.statusReason?.trim() || undefined,
  };
}

function domainReason(phase: DomainPhase, recordCount: number, statusReason: string | undefined): string | undefined {
  if (phase === "live") return undefined;
  if (phase === "failed") return domainFailureSentence(statusReason);
  if (recordCount > 0) {
    const noun = recordCount === 1 ? "the record" : "the records";
    return `Add ${noun} below wherever you bought your domain — your site stays live on its AWS address the whole time.`;
  }
  return "AWS is putting your address in place — this usually takes a few minutes, and can take up to an hour.";
}

/**
 * AWS's failure text turned into something to act on. The raw text travels too, on
 * `DomainStatus.detail`, because the first live failure matched none of these cases and left
 * nobody — user or author — with anything to diagnose from.
 */
function domainFailureSentence(statusReason: string | undefined): string {
  const raw = statusReason ?? "";
  if (/already .*(associat|in use)|another app/i.test(raw)) {
    return "That address is already connected to another website in this AWS account — disconnect it there first, then add it here again.";
  }
  if (/certificat|validat|timed? ?out|time limit|expired/i.test(raw)) {
    return "Your address wasn't confirmed in time, which usually means the record never reached the internet — remove it here and add it again once the record is live.";
  }
  return "We couldn't finish connecting that address — remove it here and try adding it again.";
}

/**
 * AWS hands DNS records over as one whitespace-separated string, and a root domain comes back
 * as ANAME or ALIAS rather than CNAME. Parsing lives in sites.ts; this only keeps blanks out,
 * because an empty row in a copy-paste table is worse than no row.
 */
function pushRecord(into: DnsRecord[], raw: string | undefined, purpose: DnsRecord["purpose"]): void {
  if (!raw || !raw.trim()) return;
  const record = parseDnsRecord(raw, purpose);
  if (record) into.push(record);
}

/** AWS sends Dates; an unparseable one would throw and take a whole status poll down with it. */
function isoOf(d: Date | undefined): string | undefined {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

// ---------------------------------------------------------------------------
// Reading the zone before touching a domain (DESIGN §3.3)
//
// The Route 53 calls themselves live in dns.ts. What is here is the DECIDING: given what
// the zone turned out to contain, what does the screen say, is "add it for me" on offer,
// and is the write about to move a name somebody is already using. All pure, because these
// are the sentences the user acts on and every one of them has to be testable without AWS.
// ---------------------------------------------------------------------------

// The shapes themselves (NameState / ExistingRecord / NameFacts / DomainCheck) live in
// types.ts, because the frontend renders them and types.ts is the half `npm run sync-types`
// copies across. What is here is the deciding, which is ours alone.

/** Where a name points today, in the words a person would use. "" when we found nothing. */
function pointsAtPhrase(facts: NameFacts): string {
  const values = facts.existing?.values.filter(Boolean) ?? [];
  const answer = values[0] ?? (facts.answers ?? []).filter(Boolean)[0] ?? "";
  return answer;
}

/**
 * The sentence for each way a name can already be spoken for.
 *
 * They are written out one per case rather than assembled from fragments: this is the screen
 * a beginner reads at the moment they are most likely to give up, and a sentence that reads
 * like it was generated is exactly what UX.md's ground rule 5 is against.
 */
/**
 * The sentence for every way of not being able to do it for them — a zone in another AWS
 * account, a Route 53 read this connection doesn't cover, a lookup that didn't answer.
 *
 * They are one sentence on purpose. The three causes are different facts about AWS and the
 * SAME fact for the user: we can't see it, so here are the records to add yourself. That is
 * what this poppy did before any of DESIGN §3.3 existed, and it stays correct.
 */
function cantSeeDnsMessage(name: string): string {
  return `We can't see the DNS for ${name} from this AWS account, so we'll show you the records to add wherever you bought your domain.`;
}

function checkMessage(facts: NameFacts, managedHere: boolean): string {
  const name = facts.address || facts.root;
  if (!managedHere || facts.state === "unknown") return cantSeeDnsMessage(name);
  if (facts.state === "already-ours") {
    return `${name} already points at this website — there's nothing left to change.`;
  }
  if (facts.state === "taken") {
    const target = pointsAtPhrase(facts);
    const today = target ? ` It points at ${target} today.` : "";
    return `Something already uses ${name}.${today} Connecting it here moves it to this website, so nothing changes until you say so.`;
  }
  if (facts.state === "shadowed-by-wildcard") {
    const target = pointsAtPhrase(facts);
    const wildcard = facts.existing?.name ? `Your catch-all ${facts.existing.name} record` : "A catch-all (*) record";
    const answers = target ? ` sends ${name} to ${target}` : ` already answers for ${name}`;
    return `${wildcard}${answers}. We'll add a record for this exact name, which always wins — every other address keeps working as it does now.`;
  }
  return `Nothing else uses ${name}, so we can point it at this website for you.`;
}

/**
 * Everything the domain screen needs about one address, assembled from what the zone read
 * found. Pure: dns.ts does the looking, this decides what it means.
 *
 * `canWrite` is deliberately not "we have the permission" — nothing can know that without
 * trying. It means we found the zone in this account and know what the name is, which is
 * when the offer is honest. A refused write is then one calm sentence and the records to
 * paste, exactly as if the zone had been somewhere else all along.
 */
export function describeDomainCheck(facts: NameFacts): DomainCheck {
  const managedHere = !!facts.zone && facts.state !== "unknown";
  return {
    ...facts,
    answers: facts.answers ?? [],
    managedHere,
    canWrite: managedHere && facts.state !== "already-ours",
    willOverwrite: managedHere && facts.state === "taken",
    message: checkMessage(facts, managedHere),
  };
}

/** Trailing dots and case are noise when comparing what DNS said to what AWS asked for. */
function sameName(a: string, b: string): boolean {
  const strip = (v: string): string => v.trim().toLowerCase().replace(/\.+$/, "");
  return !!a && strip(a) === strip(b);
}

/** What this website's address is supposed to point at, according to AWS's own records. */
function ourTargets(status: DomainStatus): string[] {
  return status.records
    .filter((r) => r.purpose === "point-your-domain")
    .map((r) => r.value.trim())
    .filter(Boolean);
}

/**
 * The honest version of "we couldn't finish connecting that address".
 *
 * The first live custom domain failed in under a minute because a wildcard record already
 * answered for the name, so AWS asked whether the address pointed at it, got a WRONG answer
 * rather than no answer, and gave up (DESIGN §3.3). The generic sentence was true, useless
 * and impossible to act on. When we can see what the name actually answers, the reason says
 * it — the fix is then obvious, and knowing was the whole problem.
 *
 * Two guards keep this from ever accusing correct DNS of being wrong:
 *  - if ANY answer matches what AWS said the address should point at, the name leads to us
 *    (a CNAME chain ends in CloudFront's addresses, so the match can be at any link) and the
 *    reason is left alone;
 *  - with no record from AWS to compare against we do not know what right looks like, so we
 *    say nothing about the answers at all.
 *
 * `detail` — AWS's own words — travels untouched either way, because it is the only thing
 * that can explain a failure none of our sentences anticipated.
 */
export function explainDomainFailure(status: DomainStatus, answers: string[]): DomainStatus {
  if (status.phase !== "failed") return status;
  const seen = answers.map((a) => a.trim()).filter(Boolean);
  const targets = ourTargets(status);
  if (!seen.length || !targets.length) return status;
  if (seen.some((answer) => targets.some((target) => sameName(answer, target)))) return status;

  return {
    ...status,
    reason:
      `${status.domain} currently answers ${seen[0]}, which is not this website — ` +
      `point that exact name at the record below, then add the address again.`,
  };
}

/**
 * The name Route 53 files a record under, from the name AWS handed back.
 *
 * Amplify is inconsistent here for good reasons of its own: the certificate record comes
 * back as a full name (`_a1b2.example.com`), the address record as the bare prefix (`www`),
 * and a root domain as `@` or as nothing at all. Route 53 wants the full name in every case,
 * and a record written one label short points a name the user does not own.
 */
export function absoluteRecordName(name: string, root: string): string {
  const label = name.trim().replace(/\.+$/, "").toLowerCase();
  const zone = root.trim().replace(/\.+$/, "").toLowerCase();
  if (!zone) return label;
  if (!label || label === "@") return zone;
  return label === zone || label.endsWith(`.${zone}`) ? label : `${label}.${zone}`;
}

/** One record we can write into the user's zone ourselves. */
export interface RecordWrite {
  /** The full name, as Route 53 files it. */
  name: string;
  /** What it should point at, byte-for-byte as AWS gave it. */
  value: string;
  /** AWS's own word for the type — for the timeline and the screen, never re-derived. */
  type: string;
  purpose: DnsRecord["purpose"];
}

/**
 * Split what AWS is waiting for into what we can add for the user and what they have to add
 * themselves.
 *
 * Two kinds stay in the user's own hands:
 *  - a record we could not parse (sites.ts keeps it verbatim rather than guessing) has no name
 *    and no type, so writing it would mean inventing both;
 *  - anything that is not a CNAME. A root domain needs AWS's own ANAME/ALIAS, which is a
 *    different write with a different shape — dns.ts refuses to invent it, and this is the
 *    same rule read early, so the offer is never made for something that would fail halfway
 *    through with one record already written.
 * Both stay in the copy-paste table, where being visibly unhelpful beats being invisibly wrong.
 */
export function plannedWrites(records: DnsRecord[], root: string): { writable: RecordWrite[]; manual: DnsRecord[] } {
  const writable: RecordWrite[] = [];
  const manual: DnsRecord[] = [];
  for (const record of records) {
    if (!record.type || !record.value.trim() || record.type.trim().toUpperCase() !== "CNAME") {
      manual.push(record);
      continue;
    }
    writable.push({
      name: absoluteRecordName(record.name, root),
      value: record.value.trim(),
      type: record.type,
      purpose: record.purpose,
    });
  }
  return { writable, manual };
}

// ---------------------------------------------------------------------------
// Doing it for them: reading the zone, then writing into it (DESIGN §3.3, steps 1–3)
//
// The Route 53 calls live in dns.ts. What is here is the ORCHESTRATION — the order things
// are asked in, what happens when an answer doesn't arrive, and the one refusal that stands
// between a button and somebody's live website moving to a different server.
// ---------------------------------------------------------------------------

/**
 * What the zone said about one name. "unknown" is deliberately not in this union: it means we
 * failed to LOOK, which is a fact about our own call, not something a zone can report.
 */
export interface NameVerdict {
  state: Exclude<NameState, "unknown">;
  existing?: ExistingRecord;
}

/**
 * The Route 53 half of the domain flow, declared as an interface rather than imported.
 *
 * dns.ts implements it against AWS and server.ts binds the two together. Everything in this
 * file then decides with no client, no credentials and no network — which matters more here
 * than anywhere else in the poppy: these are the sentences somebody reads at the moment they
 * are most likely to give up, and one of these calls can take a live website off the air.
 */
export interface ZoneAccess {
  /** The zone in THIS account that governs the domain, or null when it is somebody else's. */
  findZone(domain: string): Promise<HostedZoneRef | null>;
  /** What already answers for a name, judged against what AWS wants it to point at. */
  classify(zone: HostedZoneRef, name: string, target: string): Promise<NameVerdict>;
  /**
   * Add the record, or move it, and hand back Route 53's id for the change.
   *
   * `replaceExisting` is the user's yes, passed through rather than assumed: dns.ts re-reads
   * the name at the last moment and refuses to move it without one. That second guard is not
   * duplication for its own sake — the plan below is read seconds earlier, and a record can
   * change in between.
   */
  write(zone: HostedZoneRef, record: RecordWrite, replaceExisting: boolean): Promise<string>;
}

/** One name we would take off whatever it points at today. The destructive half, named. */
export interface MovedRecord {
  /** The full name, as Route 53 files it. */
  name: string;
  /** What it answers with today — this is what the user is being asked to give up. */
  from: string[];
  /** What we would point it at instead. */
  to: string;
}

/**
 * What "add the records for me" would do, worked out before any of it is done.
 *
 * `manual` is only ever records nobody could write for them whatever the zone said — one AWS
 * worded in a way we won't guess at, or one that isn't a CNAME (see {@link plannedWrites}).
 * When we simply cannot write — the zone is elsewhere, or the read was refused — nothing moves
 * into `manual`: `canWrite` goes false and the screen falls back to the copy-paste table it
 * already builds from the domain's own records.
 */
export interface DomainRecordPlan {
  /** The zone in this account we would write into. Absent means we can't do it for them. */
  zone?: string;
  /** True when "add the record for me" may be offered — there is something to add, and we can. */
  canWrite: boolean;
  /** The records we would add or move. */
  writable: RecordWrite[];
  /** Records already pointing where AWS wants them. Pressing the button leaves these alone. */
  unchanged: RecordWrite[];
  /** Records only the user can add, whatever we can see. */
  manual: DnsRecord[];
  /** The subset of `writable` that takes a name off something else. Needs a deliberate yes. */
  moves: MovedRecord[];
  /** The one sentence the screen shows. */
  message: string;
  /** Raw text for the "technical details" disclosure — why a read was refused, verbatim. */
  detail?: string;
}

/** The plan, plus the zone handle the write needs and the wire has no business carrying. */
interface PlanWithZone {
  plan: DomainRecordPlan;
  zone: HostedZoneRef | null;
}

async function planWithZone(zones: ZoneAccess, root: string, records: DnsRecord[]): Promise<PlanWithZone> {
  const { writable, manual } = plannedWrites(records, root);
  const nothing = { writable: [] as RecordWrite[], unchanged: [] as RecordWrite[], manual, moves: [] as MovedRecord[] };

  // No Route 53 call at all when AWS is not waiting on anything we could write. The domain
  // screen asks for this plan every time it loads, including while a domain is live.
  if (!writable.length) {
    return { zone: null, plan: { ...nothing, canWrite: false, message: nothingToAddMessage(root, manual.length) } };
  }

  const elsewhere = (detail?: string): PlanWithZone => ({
    zone: null,
    plan: { ...nothing, canWrite: false, message: cantSeeDnsMessage(root), ...(detail ? { detail } : {}) },
  });

  let zone: HostedZoneRef | null;
  try {
    zone = await zones.findZone(root);
  } catch (e) {
    return elsewhere(rawDetail(e));
  }
  if (!zone) return elsewhere();

  const toWrite: RecordWrite[] = [];
  const unchanged: RecordWrite[] = [];
  const moves: MovedRecord[] = [];

  for (const record of writable) {
    let verdict: NameVerdict;
    try {
      // Judged per RECORD, not per address: the certificate record and the record that points
      // the site are different names with different histories, and one of them being in use
      // says nothing about the other. The target is this record's own value, so a name that
      // already points exactly where AWS wants it reads as ours and is left alone.
      verdict = await zones.classify(zone, record.name, record.value);
    } catch (e) {
      // One name we couldn't read is enough to withdraw the whole offer. The promise being
      // made is "we know what is there" — half of it is not a smaller promise, it is a wrong
      // one, and the copy-paste table is always available underneath.
      return elsewhere(rawDetail(e));
    }

    if (verdict.state === "already-ours") {
      unchanged.push(record);
      continue;
    }
    if (verdict.state === "taken") {
      moves.push({ name: record.name, from: verdict.existing?.values.filter(Boolean) ?? [], to: record.value });
    }
    toWrite.push(record);
  }

  return {
    zone,
    plan: {
      zone: zone.name,
      canWrite: toWrite.length > 0,
      writable: toWrite,
      unchanged,
      manual,
      moves,
      message: planMessage(root, toWrite, unchanged, moves),
    },
  };
}

/**
 * What we would do to the user's zone, without doing any of it — the answer the domain screen
 * needs to decide whether "add it for me" is on offer, and whether pressing it moves something.
 */
export async function planDomainRecords(
  zones: ZoneAccess,
  root: string,
  records: DnsRecord[],
): Promise<DomainRecordPlan> {
  return (await planWithZone(zones, root, records)).plan;
}

/** One record as it lands, told to {@link WriteOptions.onWritten} the moment it does. */
export interface WrittenRecord {
  record: RecordWrite;
  /** The zone it went into. */
  zone: string;
  /** Present when this write took the name off something else. */
  moved?: MovedRecord;
}

export interface WriteOptions {
  /** The user has seen what is there and said yes to moving it. */
  confirmOverwrite?: boolean;
  /**
   * Called after each record is safely in, so the transparency timeline is written as the
   * change happens. Must not throw — a note about history is never a reason a DNS write fails.
   */
  onWritten?: (written: WrittenRecord) => void;
}

/** What the write actually did, in the words the timeline and the screen both use. */
export interface DomainRecordWrite {
  /** The records we added or moved. */
  written: RecordWrite[];
  /** Records that already pointed the right way — nothing was done to them. */
  unchanged: RecordWrite[];
  /** Records the user still has to add themselves. */
  manual: DnsRecord[];
  /** The names we took off something else. Never empty without the user having said yes. */
  moved: MovedRecord[];
  /** The zone we wrote into. */
  zone: string;
  /**
   * Route 53's receipt for each write, in the order they were made.
   *
   * A change is taken and then published across Route 53's own servers, which is seconds
   * rather than the minutes the rest of the internet's caches take. The wait screen can ask
   * whether it has landed instead of guessing, so the ids travel rather than being dropped.
   */
  changeIds: string[];
}

/**
 * Add the records for the user — the "add it for me" button (DESIGN §3.3 step 3).
 *
 * This is the only call in this poppy that changes something the public internet reads, so it
 * is the only one that refuses to run on its own judgement. If any name is already in use by
 * something that is not this website, it stops and says so, and only a caller carrying the
 * user's explicit `confirmOverwrite` gets past — a screen cannot forget to ask, because the
 * backend will not do it. "Changing someone's live DNS is never silent and never one bare
 * click" is enforced here, not decorated in the UI.
 *
 * Safe to press twice: Route 53 writes are upserts, names already pointing the right way are
 * skipped, and a write that fails halfway leaves everything before it done — pressing again
 * picks up where it stopped rather than duplicating anything.
 */
export async function writeDomainRecords(
  zones: ZoneAccess,
  root: string,
  records: DnsRecord[],
  options: WriteOptions = {},
): Promise<DomainRecordWrite> {
  const { plan, zone } = await planWithZone(zones, root, records);

  // Not an error the user caused, and not one they can do anything about except the thing the
  // sentence already tells them: add the records themselves. 409 rather than 500 so nothing
  // reads it as "AWS broke".
  if (!zone || !plan.zone) throw new HttpError(409, plan.message);

  if (!plan.writable.length) {
    // Everything AWS asked for is already in place. That is the state the caller wanted, so it
    // is a success — pressing the button again must never look like a failure.
    if (plan.unchanged.length) {
      return { written: [], unchanged: plan.unchanged, manual: plan.manual, moved: [], zone: plan.zone, changeIds: [] };
    }
    throw new HttpError(409, plan.message);
  }

  if (plan.moves.length && !options.confirmOverwrite) throw new HttpError(409, moveRefusal(plan.moves));

  const written: RecordWrite[] = [];
  const changeIds: string[] = [];
  for (const record of plan.writable) {
    // Deliberately not caught: errors.ts already has a sentence for a refusal, for throttling
    // and for a lost connection, and the records written before this one stay written.
    const changeId = await zones.write(zone, record, options.confirmOverwrite === true);
    written.push(record);
    if (changeId) changeIds.push(changeId);
    // Announced as it happens rather than at the end, because a run that fails on its second
    // record has still changed the user's DNS on its first — and a timeline that only records
    // whole runs would hide exactly the case somebody needs to look up.
    options.onWritten?.({ record, zone: plan.zone, moved: plan.moves.find((m) => m.name === record.name) });
  }

  const names = new Set(written.map((r) => r.name));
  return {
    written,
    unchanged: plan.unchanged,
    manual: plan.manual,
    moved: plan.moves.filter((m) => names.has(m.name)),
    zone: plan.zone,
    changeIds,
  };
}

/**
 * What this address is supposed to point at, so a name that already does reads as ours rather
 * than as somebody else's live site about to be moved.
 *
 * AWS's own record comes first: once an address is attached, the value in that record is the
 * only target that can make the domain verify. Before there is one, the closest true answer is
 * the website's own AWS address — which is what somebody who wired this up by hand, before
 * installing HostingPoppy, would have pointed the name at.
 *
 * One target rather than a list, because that is what dns.ts classifies against: "does this
 * record point where AWS wants it" is the question, and a list of maybes is a different and
 * fuzzier one.
 */
export function siteTarget(site: Site, status?: DomainStatus | null): string | undefined {
  const fromRecord = status ? ourTargets(status)[0] : undefined;
  const host = site.defaultUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return fromRecord?.trim() || host.trim() || undefined;
}

function nothingToAddMessage(root: string, manualCount: number): string {
  if (manualCount > 0) {
    // Both reasons — a record we couldn't read, and a root domain's ANAME — end in the same
    // place for the user, and the second half offers the way out they can actually take.
    const them = manualCount === 1 ? "that record" : "those records";
    const it = manualCount === 1 ? "it" : "them";
    return `We can't add ${them} for you — copy ${it} to your DNS host, or use an address like www.${root} and we'll set that one up for you.`;
  }
  return `There's nothing left to add for ${root}.`;
}

function planMessage(root: string, toWrite: RecordWrite[], unchanged: RecordWrite[], moves: MovedRecord[]): string {
  if (moves.length) {
    const first = moves[0]!;
    const target = first.from.find(Boolean);
    const today = target ? ` It points at ${target} today.` : "";
    return `Something already uses ${first.name}.${today} Adding the record moves it to this website, so nothing changes until you say so.`;
  }
  if (!toWrite.length) return `The records for ${root} are already in place — there's nothing left to add.`;
  const what = toWrite.length === 1 ? "the record" : `the ${toWrite.length} records`;
  const already = unchanged.length ? " The rest are already in place." : "";
  return `Nothing else uses ${toWrite.length === 1 ? "that name" : "those names"}, so we can add ${what} for you.${already}`;
}

/**
 * The refusal that makes the destructive case deliberate.
 *
 * It names the ONE thing being given up — where that name goes today — because "are you sure"
 * with nothing in it is a question nobody can answer. The next action is the user's yes, which
 * the screen turns into `confirmOverwrite`.
 */
function moveRefusal(moves: MovedRecord[]): string {
  const first = moves[0]!;
  const target = first.from.find(Boolean);
  const where = target ? `points at ${target} today` : "is already in use";
  const others = moves.length > 1 ? ` (and ${moves.length - 1} more like it)` : "";
  return `${first.name} ${where}${others} — say yes to moving it to this website and we'll change it.`;
}
