// Which AWS regions can host a website, and how to link to one in the AWS console.
//
// The poppy does NOT choose a region: it inherits whichever one the user's AgentsPoppy
// connection uses. Amplify Hosting is not offered everywhere, so a perfectly healthy
// connection can land us somewhere we cannot work — that is a normal state to explain, not
// an error to throw. Everything here is pure so the "can we work here?" answer is decided
// once, at /meta, and the frontend can say so before the user fills anything in.

/**
 * Regions with an Amplify Hosting endpoint.
 *
 * Taken from AWS's published service-endpoint table for Amplify
 * (docs.aws.amazon.com/general/latest/gr/amplify.html, read 2026-08-23), which is the
 * authoritative list — not a guess, and not the shorter set of "regions everyone uses".
 *
 * Still worth confirming live once (PLAN.md L5): a published endpoint means the API answers
 * there, which is a slightly weaker claim than "hosting a site there works end to end". If a
 * region ever turns out to answer but not work, the honest fix is to remove it from this list
 * rather than to let a user discover it halfway through a deploy.
 *
 * Sorted by region id so the frontend can print it without re-sorting.
 */
export const HOSTING_REGIONS: readonly string[] = [
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "me-south-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
];

/**
 * AWS's per-region Amplify quotas, from the same endpoints-and-quotas page. They are here
 * because each one is a sentence a user will eventually read:
 *  - 25 websites per region (and 25 creations per hour), raisable on request — a NEW account
 *    gets a REDUCED quota that AWS raises automatically with use, so "you have reached your
 *    account's limit" must never be phrased as if the user did something wrong;
 *  - 5 custom domains per website, 50 subdomains per domain;
 *  - 5 deploys running at once;
 *  - a 5 GB manual-deploy archive. Our own cap is far smaller (see uploads.ts) because the
 *    bytes cross the host bridge, so we fail on our limit long before AWS's.
 */
export const QUOTAS = {
  sitesPerRegion: 25,
  siteCreationsPerHour: 25,
  domainsPerSite: 5,
  concurrentDeploys: 5,
  awsArchiveLimitBytes: 5 * 1024 * 1024 * 1024,
} as const;

/** The handful we name in the "switch regions" sentence — one per continent the user might be on. */
const SUGGESTED_REGIONS = ["eu-west-1", "us-east-1", "ap-southeast-1"];

/** What an AWS region id looks like. Used to spot rubbish before it reaches a URL. */
const REGION_SHAPE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

export function regionSupported(region: string | undefined | null): boolean {
  return !!region && HOSTING_REGIONS.includes(region);
}

/**
 * The friendly refusal for a region we cannot host in — one calm sentence naming the one
 * thing to do next (UX.md error dictionary, "Region capability missing"). Never throw for
 * this: it is a fact about the user's connection, not a failure of ours. The full region
 * list travels separately in `Meta.supportedRegions` so the UI can show all of them without
 * a paragraph-long sentence.
 */
export function regionNotSupportedMessage(region?: string): string {
  const where = region && REGION_SHAPE.test(region) ? region : "this region";
  return `AWS can't host websites in ${where} yet — reconnect HostingPoppy to a region that can, such as ${SUGGESTED_REGIONS.join(", ")}.`;
}

/** Which page of the console to land on. The domain has no page of its own — its settings do. */
export interface ConsoleTarget {
  /** Link to this branch's deploy history rather than the app overview. */
  branch?: string;
  /** Link to the custom-domain settings page. The value is unused — presence is the signal. */
  domain?: string;
}

/**
 * A deep link into the Amplify console for the Resources tab (UX.md S9 — the ONE screen where
 * real AWS names are allowed, because transparency requires them).
 *
 * The console is region-hosted, so the region belongs in the hostname; a URL for the wrong
 * region shows "app not found" rather than an error. An unrecognisable region falls back to
 * the region-less console host, which redirects to whatever region the user last used — a
 * slightly-worse link is a far better outcome than a Resources tab that throws.
 */
export function consoleUrlFor(region: string, appId: string, opts: ConsoleTarget = {}): string {
  const host = REGION_SHAPE.test(region) ? `${region}.console.aws.amazon.com` : "console.aws.amazon.com";
  const base = `https://${host}/amplify/apps/${encodeURIComponent(appId)}`;
  if (opts.domain) return `${base}/settings/domains`;
  if (opts.branch) return `${base}/branches/${encodeURIComponent(opts.branch)}`;
  return base;
}
