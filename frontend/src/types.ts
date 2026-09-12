// GENERATED — do not edit. Run `npm run sync-types` after changing the backend's types.ts.
//
// This is the wire contract, copied verbatim from backend/src/types.ts. It is generated
// rather than maintained because the two sides are separate builds: nothing would catch a
// field that exists on one and not the other, and that drift has already cost this repo a
// round of user-visible bugs.

/** A website HostingPoppy hosts. One site = one Amplify Hosting app in the user's account. */
export interface Site {
  /** The Amplify app id — our stable identifier for the site. */
  id: string;
  /** What the user called it. */
  name: string;
  /** The always-working address AWS gives every site, live from the first deploy. */
  defaultUrl: string;
  /** ISO timestamp of creation, as AWS reports it. */
  createdAt: string;
  /** WEB = a finished/static site. WEB_COMPUTE = a Next.js app that renders on a server. */
  platform: "WEB" | "WEB_COMPUTE";
  /**
   * How this site gets its code. Always present in practice — every site read back from AWS
   * is one or the other — and optional only so a payload written before this existed still
   * parses. Treat an absent value as "upload", which is what every site made before the
   * GitHub path was.
   */
  source?: SiteSource;
  /** The connected repository's address, when `source` is "github". */
  repository?: string;
  /**
   * The branch AWS serves and rebuilds. Absent means the site's one live version, which the
   * upload path calls "main" — a connected site can call it anything its repository does,
   * and every call that names a branch (build status, custom domain) needs this one.
   */
  branch?: string;
  /** Present once anything has been deployed to the site. */
  lastDeploy?: DeployStatus;
  /** Present once the user has attached their own domain. */
  domain?: DomainStatus;
}

/**
 * Where a site's files come from. An Amplify app is connected to a repository or it is
 * manual, and it is one or the other FOREVER — AWS offers no way to convert between them —
 * so the UI must never offer a zip upload for a connected site, or a "deploy the latest
 * commit" for an uploaded one.
 *
 *  github — AWS builds it from a GitHub repository, on every push
 *  upload — the user sends up a built site as a zip
 */
export type SiteSource = "upload" | "github";

/**
 * What the user says they are putting online — the answer to "what are you putting online?",
 * in their words rather than AWS's.
 *
 *  static — a finished site. The files are already built (a React or Vue build, or plain
 *           HTML) and AWS only has to serve them.
 *  nextjs — a Next.js app. It renders its pages on a server as visitors ask for them, so AWS
 *           has to run it rather than just hand out files.
 *
 * It is stated when the website is made and never again: it decides how the website is set up
 * in AWS, and those settings cannot be changed on a website that already exists. What it
 * actually became is reported back on {@link Site.platform}, read from AWS rather than
 * remembered from the request.
 *
 * A Next.js app has to be BUILT, and this poppy cannot build anything on the user's machine —
 * so it is only offered where AWS can build it, which is the connected-repository path. The
 * upload path refuses it with a sentence saying what to do instead (amplify.ts).
 */
export type SiteKind = "static" | "nextjs";

export type DeployPhase = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface DeployStatus {
  jobId: string;
  phase: DeployPhase;
  /** ISO timestamp the deploy started/finished, when AWS reports them. */
  startedAt?: string;
  finishedAt?: string;
  /** One human sentence when a deploy fails — never a raw AWS error. */
  reason?: string;
}

/**
 * How far along a custom domain is.
 *  verifying    — AWS is checking the domain is yours (needs the validation record)
 *  pending-dns  — records are published/being waited on; the site is still live on its AWS address
 *  live         — the domain serves the site over HTTPS
 */
export type DomainPhase = "verifying" | "pending-dns" | "live" | "failed";

/** A DNS record the user must create at whoever sells them their domain. */
export interface DnsRecord {
  purpose: "certificate-validation" | "point-your-domain";
  /** The record's host/name field, exactly as it should be typed. */
  name: string;
  /**
   * Free-form on purpose. AWS hands these back as one string ("www CNAME d1.cloudfront.net")
   * and uses ANAME/ALIAS for a root domain, which no fixed union would survive. We show the
   * user exactly what AWS said rather than a value we re-derived and could get wrong.
   */
  type: string;
  value: string;
}

export interface DomainStatus {
  domain: string;
  phase: DomainPhase;
  /** Everything still to be added at the DNS host. Empty once AWS is satisfied. */
  records: DnsRecord[];
  /** https://<domain>, once it serves. */
  url?: string;
  /** One human sentence explaining a failure or a wait. */
  reason?: string;
  /**
   * AWS's own words about this domain, verbatim, for the "technical details" disclosure.
   *
   * This was deliberately dropped at first, on the reasoning that the handful of sentences a
   * user can act on covered it. The first live custom domain failed in a way none of those
   * sentences explained, and there was then NOTHING to diagnose from — not in the app, not in
   * the API, not for the person who wrote the code. A failure the product cannot explain is a
   * support ticket nobody can answer, so the raw text now travels with the friendly one.
   */
  detail?: string;
}

// ---------------------------------------------------------------------------
// What the hosted zone already contains (DESIGN §3.3)
//
// The domain screen asks AWS what the name is doing TODAY before it offers to change
// anything, because the alternative has already failed a real user: a wildcard record
// answered for the name, Amplify asked whether the name pointed at it, got a WRONG answer
// rather than no answer, and gave up in under a minute. "We couldn't finish connecting that
// address" was true, useless, and impossible to act on.
//
// These shapes are what the frontend renders, so they live here — the generated wire
// contract — rather than in the file that fetches them.
//
// NOTE FOR WHOEVER TOUCHES amplify.ts NEXT: that file currently declares its own structurally
// identical copies of NameState / ExistingRecord / NameFacts / DomainCheck, written in the
// same hour as these. They are drop-in — replace them with an import from here, or the two
// will drift exactly the way frontend/src/types.ts used to (see scripts/sync-types.mjs).
// ---------------------------------------------------------------------------

/**
 * What already answers for the name the user typed.
 *
 *  free                 — nothing claims it
 *  shadowed-by-wildcard — a `*` record answers for it. A specific record always wins, so
 *                         adding one takes this name and leaves every other one alone
 *  taken                — a record exists at this exact name and points somewhere else.
 *                         This is the case that can take a live site down, so it is never
 *                         acted on without the user saying yes to that in particular
 *  already-ours         — it points at this website already; there is nothing to do
 *  unknown              — we could not look. The zone is in another AWS account, the read
 *                         was refused, or DNS was unreachable. Everything then degrades to
 *                         "here are the records to add wherever you bought your domain",
 *                         which is what this poppy did before any of this existed.
 */
export type NameState = "free" | "shadowed-by-wildcard" | "taken" | "already-ours" | "unknown";

/** A hosted zone in this AWS account — the DNS for one domain, as AWS keeps it. */
export interface HostedZoneRef {
  /** Route 53's id, with the `/hostedzone/` prefix AWS returns stripped off. */
  id: string;
  /** The zone's own name, lowercased and without the trailing dot AWS returns. */
  name: string;
}

/** The record that answers for a name today, as the screen shows it. */
export interface ExistingRecord {
  /** The record's OWN name — a wildcard's `*.example.com`, not the name that was asked about. */
  name: string;
  /** CNAME, A, TXT — whatever the zone says. Free-form for the same reason DnsRecord's is. */
  type: string;
  /**
   * Where it points. More than one when the name has several answers, and empty when the
   * record type has nothing that reads as a destination — we would rather show a record with
   * no target than invent one.
   */
  values: string[];
}

/** What the zone read and a plain DNS lookup found, before any sentence is chosen. */
export interface NameFacts {
  /** The full address the user typed, lowercased. */
  address: string;
  /** The registered domain, and what sits in front of it (sites.ts splits them). */
  root: string;
  prefix: string;
  /** The hosted zone in THIS AWS account that governs the name, when there is one. */
  zone?: HostedZoneRef;
  state: NameState;
  /** The record found at (or covering) the name. */
  existing?: ExistingRecord;
  /** What the public internet answers for the name right now. Empty when nothing does. */
  answers?: string[];
  /** Raw text for the "technical details" disclosure — why a read was refused, verbatim. */
  detail?: string;
}

/**
 * The answer to "what happens if I use this address" — read-only, safe to ask repeatedly,
 * and the thing the domain screen is built from.
 */
export interface DomainCheck extends NameFacts {
  answers: string[];
  /** True when the domain's DNS is managed in this AWS account, so we can do it for them. */
  managedHere: boolean;
  /** True when "add the record for me" may be offered. */
  canWrite: boolean;
  /** True when writing would move a name that is in use — never one bare click (DESIGN §3.3). */
  willOverwrite: boolean;
  /** The one sentence the screen shows. */
  message: string;
}

/**
 * How far a DNS change of ours has got inside AWS.
 *
 *  pending   — Route 53 has taken it and is still publishing it to its own servers
 *  published — every Route 53 server has it; from here it is the rest of the internet's
 *              caches we are waiting on, which is what the resolve check measures
 *  unknown   — we could not ask (the read was refused, or the change id is gone). Not an
 *              error: the honest answer is then whatever the name actually resolves to.
 */
export type DnsChangeState = "pending" | "published" | "unknown";

/** What came of writing the record into the user's zone for them. */
export interface DnsWriteResult {
  /** The names written, exactly as Route 53 filed them. */
  written: string[];
  /** Records we could not write for them, still to be added by hand wherever they bought it. */
  manual: DnsRecord[];
  /** Route 53's id for the change, so the wait screen can ask whether it has published yet. */
  changeId?: string;
  state: DnsChangeState;
}

/** One thing that exists in the user's AWS account because of HostingPoppy. */
export interface ResourceRow {
  service: "Amplify Hosting";
  kind: "Website" | "Live branch" | "Custom domain";
  name: string;
  /** The AWS console deep link for this exact resource. */
  consoleUrl: string;
  /**
   * Where this thing actually lives outside AWS, when that is a better place to send
   * somebody than the console — today, the branch of a connected repository on GitHub.
   *
   * The Amplify console does the same thing, which is the point: a branch IS a GitHub
   * branch, and the code is what a person wants to look at. Absent for an uploaded site,
   * which has no repository at all.
   */
  sourceUrl?: string;
  siteId: string;
}

/** An append-only note of something created or removed, for the Resources tab timeline. */
export interface LedgerEntry {
  at: string;
  action: "created" | "removed" | "deployed" | "domain-attached" | "domain-removed";
  what: string;
  detail?: string;
}

export interface Meta {
  accountId: string;
  region: string;
  /** The version from extension.json, so the UI can show what it is running. */
  version: string;
  /** False when the region the connection uses cannot host websites (see regions.ts). */
  regionSupported: boolean;
  /** Regions that do support hosting, for the message when the current one does not. */
  supportedRegions: string[];
}
