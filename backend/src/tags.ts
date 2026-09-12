// Attribution tags — the three keys AgentsPoppy uses for scoping + teardown, plus our own
// marker.
//
// Every resource HostingPoppy creates MUST carry all three, or it becomes (a) invisible to
// the host's tag sweep (= a leak that fails the leaves-no-trace check) and (b) unreachable
// by our own scoped credentials. See AGENTS.md §3 "Attribution", §4.
//
// Unlike the fleet's CloudFormation poppies, there is no stack here to stamp tags onto: this
// poppy calls Amplify directly, so EVERY create passes these tags in the same call.
// `CreateApp` and `CreateBranch` both take a `tags` map — that is precisely why Amplify was
// chosen over S3+CloudFront (DESIGN §3: an untaggable create cannot be granted at all under
// the broker's born-tagged-or-refused rule, so it would be refused by AWS before we even got
// to worry about teardown).

export const APP_ID = "com.hostingpoppy.desktop";

export const TAG_ACCOUNT = "agentspoppy:account";
export const TAG_APP = "agentspoppy:app";
export const TAG_CONNECTION = "agentspoppy:connection";

/** Marks the app as ours in the AWS console, next to the AgentsPoppy attribution. */
export const TAG_MANAGED = "agentspoppy:managed";

export interface AttributionContext {
  accountId: string;
  connectionId: string;
}

/**
 * The tags every Amplify resource we create is born with. Amplify takes tags as a plain
 * `{ key: value }` map, not the `Key`/`Value` array shape most other AWS APIs use — passing
 * the array form is silently accepted as an object with numeric keys and loses the
 * attribution, so keep this the single place the shape is decided.
 */
export function resourceTags(ctx: AttributionContext): Record<string, string> {
  return {
    [TAG_ACCOUNT]: ctx.accountId,
    [TAG_APP]: APP_ID,
    [TAG_CONNECTION]: ctx.connectionId,
    [TAG_MANAGED]: "hostingpoppy",
  };
}

/**
 * The one predicate that stops teardown ever deleting an Amplify app somebody else made.
 *
 * `ListApps` is granted at `*` scope (it has to be — that is how "Remove everything" can
 * prove nothing of ours is left behind), so it returns EVERY hosting app in the account,
 * including ones the user created by hand or with another tool. Nothing may be deleted, or
 * even listed as ours, unless this returns true. A missing tags map is not ours: absence of
 * proof is treated as proof of absence in this one direction on purpose, because the cost of
 * a false positive is deleting a stranger's website.
 */
export function isOurs(tags: Record<string, string> | undefined): boolean {
  return tags?.[TAG_APP] === APP_ID;
}
