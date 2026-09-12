// Reading the user's DNS before we touch it — and writing the single record that points
// their address at their website. Route 53 only; nothing else in this poppy talks to it.
//
// WHY THIS FILE EXISTS (DESIGN §3.3, founder, 2026-08-24). The first live custom domain
// failed in under a minute. Nothing was wrong with our code: the domain carried a wildcard
// `*.example.net` pointing at a Firebase app, so every possible subdomain already resolved
// somewhere. Amplify asked whether the name pointed at its distribution, got a WRONG answer
// rather than NO answer, and gave up. The user would have seen "We couldn't finish
// connecting that address" — true, useless, and impossible to act on. A specific record
// always beats a wildcard, so the fix was one record; KNOWING was the whole problem.
//
// Hence the rule this file implements: **map what the hosted zone already contains, and
// choose the action from that.** Never hand a beginner records to paste and hope.
//
// Three habits hold it together:
//
//  - **The client is injected.** Every function takes the Route 53 client as its first
//    argument, so the tests run the real decisions with no credentials and no network.
//  - **The judgement is pure.** `pickZone`, `classifyName`, `wildcardCandidates`,
//    `decodeDnsName` and `mapChangeStatus` are exported functions over plain data. They are
//    where the user-visible answers are decided, so they are where the tests live.
//  - **It degrades, it does not break.** A refused read is never an error the user has to
//    understand: `inspectName` turns it into state "unknown", which the domain screen
//    already renders as "we'll show you the records to add wherever you bought your domain"
//    — exactly what this poppy did before any of this existed.
//
// Writing is different in kind from reading, and the difference is enforced here rather than
// trusted to the screen above: `upsertRecord` REFUSES to replace a record that already points
// somewhere else unless the caller passes `replaceExisting`. Changing someone's live DNS is
// destructive; it is never silent and never one bare click.

import { Resolver } from "node:dns/promises";

import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  ListHostedZonesByNameCommand,
  type ListHostedZonesByNameCommandOutput,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from "@aws-sdk/client-route-53";

import { HttpError, rawDetail } from "./errors";
import { normalizeDomain, splitDomain } from "./sites";
import type { DnsChangeState, ExistingRecord, HostedZoneRef, NameFacts, NameState } from "./types";

/**
 * Route 53 has no regional endpoints — it is a global service signed in us-east-1. The
 * connection's own region (where the website lives) is the wrong answer here, and getting it
 * wrong fails at signing time with an error nobody could act on, so the client is built with
 * this and never with `boot.account.region`.
 */
export const ROUTE53_REGION = "us-east-1";

/** Five minutes: long enough not to hammer resolvers, short enough that a mistake is cheap. */
const DEFAULT_TTL_SECONDS = 300;

/** How long we let a DNS lookup hang before calling it "nothing answers". */
const DNS_TIMEOUT_MS = 3_000;

/** Route 53 returns at most 100 zones a page; a few pages is plenty to find one domain. */
const ZONE_PAGE = 100;
const MAX_ZONE_PAGES = 5;

/** One name's record sets: several types at most, never a page of them. */
const EXACT_PAGE = 20;

/** A wildcard sorts immediately after its parent's own records, so one page always covers it. */
const WILDCARD_PAGE = 100;

/** Immediate parent, then upwards — but a name three levels deep is already exotic. */
const MAX_WILDCARD_LOOKUPS = 3;

/** Route 53 caps a change's comment; ours is short, but truncation beats a rejected write. */
const MAX_COMMENT = 256;

// ---------------------------------------------------------------------------
// The shapes we read back, declared structurally.
//
// Same reasoning as amplify.ts's AppLike/JobLike: the pure functions below take plain object
// literals in the tests instead of SDK instances, and the real SDK types satisfy these.
// ---------------------------------------------------------------------------

export interface ZoneLike {
  Id?: string;
  Name?: string;
  Config?: { PrivateZone?: boolean };
}

export interface RecordSetLike {
  Name?: string;
  Type?: string;
  ResourceRecords?: { Value?: string }[];
  /** An ALIAS has no ResourceRecords at all; its destination lives here. */
  AliasTarget?: { DNSName?: string };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Route 53's name → the name a person would type.
 *
 * Two things have to be undone. Every name comes back with a trailing dot (`example.net.`),
 * and any character AWS considers special is stored as a backslash and three OCTAL digits —
 * so the wildcard at the heart of the bug this file exists for arrives as `\052.example.net.`
 * Compare that raw and a wildcard never matches; print it raw and the user is shown something
 * that looks like a corrupted record rather than their own catch-all.
 */
export function decodeDnsName(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  const decoded = text.replace(/\\(\d{3})/g, (whole, octal: string) => {
    const code = Number.parseInt(octal, 8);
    return Number.isFinite(code) && code > 0 && code < 256 ? String.fromCharCode(code) : whole;
  });
  return decoded.toLowerCase().replace(/\.+$/, "");
}

/** Trailing dots and case are noise when comparing one host to another. */
function sameHost(a: string, b: string): boolean {
  const strip = (v: string): string => v.trim().toLowerCase().replace(/\.+$/, "");
  return !!a.trim() && strip(a) === strip(b);
}

/** `www.example.com` → `example.com`. A single label has no parent, and returns "". */
function parentOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

/** True when `name` is the zone itself or sits inside it — and NOT for `notexample.com`. */
function insideZone(name: string, zone: string): boolean {
  return !!zone && (name === zone || name.endsWith(`.${zone}`));
}

/** Route 53 hands ids back as `/hostedzone/Z1` and takes either form; we keep the short one. */
function zoneIdOf(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^\/hostedzone\//, "");
}

/** Same for a change: `/change/C123` → `C123`. */
function changeIdOf(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^\/change\//, "");
}

// ---------------------------------------------------------------------------
// Finding the zone
// ---------------------------------------------------------------------------

/**
 * The hosted zone that governs a name: the LONGEST zone name that is a suffix of it.
 *
 * Longest wins because a zone can be delegated deeper — with both `example.com` and
 * `dev.example.com` in the account, a record for `app.dev.example.com` belongs in the second,
 * and writing it into the first would be published where nothing reads it.
 *
 * Two traps, both tested:
 *  - the suffix test is on a DOT boundary, so the zone `example.com` never claims
 *    `notexample.com`;
 *  - a PRIVATE zone is skipped entirely. It answers only inside a VPC, so writing there would
 *    look like success and change nothing the public internet can see.
 */
export function pickZone(zones: ZoneLike[], domain: string): HostedZoneRef | null {
  const wanted = normalizeDomain(domain);
  if (!wanted) return null;

  let best: HostedZoneRef | null = null;
  for (const zone of zones) {
    if (zone.Config?.PrivateZone) continue;
    const name = decodeDnsName(zone.Name);
    const id = zoneIdOf(zone.Id);
    if (!name || !id) continue;
    if (!insideZone(wanted, name)) continue;
    if (!best || name.length > best.name.length) best = { id, name };
  }
  return best;
}

/**
 * The zone in THIS AWS account that governs the domain, or null when there is none.
 *
 * `ListHostedZonesByName` sorts by name with the labels reversed (`com.example.`), so a zone
 * and every zone delegated beneath it come back together, in order, when the listing starts
 * at the registered domain. That is why one call usually answers this: we start at the
 * registrable root (`sites.ts` splits it off) and read forward until the names leave that
 * subtree, then let {@link pickZone} decide. Starting shallower than the answer is safe;
 * starting deeper would skip the parent zone, which is the common case.
 *
 * Null is not a failure — most domains are not in Route 53 at all, and the domain screen has
 * always had an honest answer for that: here are the records, add them where you bought it.
 */
/**
 * Two IAM actions are needed to list zones, and the second one is not obvious.
 *
 * We only ever call `ListHostedZonesByName`, but AWS evaluates `route53:ListHostedZones` for
 * it — and, more importantly, AMPLIFY ITSELF calls it with the CALLER'S credentials when a
 * domain is hosted in Route 53 in the same account, because it tries to configure the DNS for
 * you. Without that permission Amplify cannot find the zone and marks the domain association
 * FAILED, which is what happened on this poppy's first live domain attach: the error surfaced
 * only inside AWS's own statusReason, and read as if the address were simply wrong.
 */
export async function findZone(r53: Route53Client, domain: string): Promise<HostedZoneRef | null> {
  const wanted = normalizeDomain(domain);
  if (!wanted) return null;
  const start = splitDomain(wanted).root || wanted;

  const zones: ZoneLike[] = [];
  let dnsName: string | undefined = start;
  let hostedZoneId: string | undefined;

  for (let page = 0; page < MAX_ZONE_PAGES; page++) {
    // Annotated because the cursor for the next page comes back out of this same call: without
    // it TypeScript walks in a circle working out the type and gives up on the whole loop.
    const out: ListHostedZonesByNameCommandOutput = await r53.send(
      new ListHostedZonesByNameCommand({ DNSName: dnsName, HostedZoneId: hostedZoneId, MaxItems: ZONE_PAGE }),
    );
    const batch = out.HostedZones ?? [];
    zones.push(...batch);

    // Sorted, so once a page ends outside the subtree nothing further can be inside it.
    const last = batch[batch.length - 1];
    if (!out.IsTruncated || !out.NextDNSName) break;
    if (!insideZone(decodeDnsName(last?.Name), start)) break;
    dnsName = out.NextDNSName;
    hostedZoneId = out.NextHostedZoneId;
  }

  return pickZone(zones, wanted);
}

// ---------------------------------------------------------------------------
// Reading what is already there
// ---------------------------------------------------------------------------

/** What the zone holds for one name: its own records, and the wildcard that would cover it. */
export interface ZoneRecords {
  /** Every record set filed at the exact name. Empty when nothing claims it. */
  exact: ExistingRecord[];
  /** The closest `*` record that would answer for the name, when one exists. */
  wildcard?: ExistingRecord;
}

/** One record set, reduced to the three things a person needs to see. */
function recordFrom(rrset: RecordSetLike, name?: string): ExistingRecord {
  const values = (rrset.ResourceRecords ?? [])
    .map((r) => (r.Value ?? "").trim())
    .filter(Boolean);
  // An ALIAS carries no ResourceRecords — its destination is the alias target, and reading
  // the empty list instead is how a live A-record alias reads as "points nowhere".
  const alias = (rrset.AliasTarget?.DNSName ?? "").trim();
  if (!values.length && alias) values.push(alias);
  return {
    name: name ?? decodeDnsName(rrset.Name),
    type: (rrset.Type ?? "").trim().toUpperCase(),
    values,
  };
}

/** One page of a zone's records, starting at a name. */
async function listFrom(
  r53: Route53Client,
  zoneId: string,
  startName: string,
  maxItems: number,
): Promise<RecordSetLike[]> {
  const out = await r53.send(
    new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: startName, MaxItems: maxItems }),
  );
  return out.ResourceRecordSets ?? [];
}

/**
 * The wildcards that would answer for a name, closest first.
 *
 * DNS wildcards are one label wide from where they sit: `*.example.com` answers for
 * `www.example.com`, and for `a.b.example.com` only when nothing closer exists — so the
 * closest one is the one that decides, and it is the one we report. A wildcard never answers
 * for the zone's own name, so the root domain has no candidates at all.
 *
 * Without a zone name we only know the immediate parent; that is the case the bug came from
 * and it is still worth checking.
 */
export function wildcardCandidates(name: string, zoneName = ""): string[] {
  const target = normalizeDomain(name);
  const zone = normalizeDomain(zoneName);
  if (!target || target === zone) return [];
  if (zone && !insideZone(target, zone)) return [];

  const out: string[] = [];
  let parent = parentOf(target);
  while (parent && out.length < MAX_WILDCARD_LOOKUPS) {
    out.push(`*.${parent}`);
    if (!zone || parent === zone) break;
    parent = parentOf(parent);
    if (!insideZone(parent, zone)) break;
  }
  return out;
}

/**
 * What already answers for the exact name, plus the wildcard that would answer for it.
 *
 * Two cheap reads at most, because `ListResourceRecordSets` starts wherever we point it: once
 * at the name itself (its own record sets come first, so the first different name ends the
 * scan) and once at the parent, where the wildcard sorts immediately after the parent's own
 * records — `*` is decimal 42, ahead of every character a real hostname label starts with.
 *
 * The wildcard read is skipped when the exact name already has records, because a specific
 * record always wins: nothing a wildcard says could change the answer.
 */
export async function readRecords(
  r53: Route53Client,
  zoneId: string,
  name: string,
  zoneName = "",
): Promise<ZoneRecords> {
  const wanted = normalizeDomain(name);
  if (!wanted || !zoneId) return { exact: [] };

  const exact: ExistingRecord[] = [];
  for (const rrset of await listFrom(r53, zoneId, wanted, EXACT_PAGE)) {
    if (decodeDnsName(rrset.Name) !== wanted) break; // sorted: the first other name ends it
    exact.push(recordFrom(rrset, wanted));
  }
  if (exact.length) return { exact };

  for (const candidate of wildcardCandidates(wanted, zoneName)) {
    const parent = candidate.slice(2);
    for (const rrset of await listFrom(r53, zoneId, parent, WILDCARD_PAGE)) {
      const found = decodeDnsName(rrset.Name);
      if (!insideZone(found, parent)) break; // sorted: we have left the parent's subtree
      if (found === candidate) return { exact, wildcard: recordFrom(rrset, candidate) };
    }
  }
  return { exact };
}

// ---------------------------------------------------------------------------
// The classification — the heart of it, and pure
// ---------------------------------------------------------------------------

export interface NameLookup {
  /** The full address the user typed. */
  name: string;
  /** The zone's own name, so its own SOA/NS aren't mistaken for somebody's website. */
  zone?: string;
  /** What the address is supposed to point at, per AWS. Absent before there is a site. */
  target?: string;
  records: ZoneRecords;
}

/** What the name is, and the record that makes it so. "unknown" is never decided here. */
export interface NameClassification {
  state: Exclude<NameState, "unknown">;
  existing?: ExistingRecord;
}

/**
 * Types that direct web traffic. At the ZONE'S OWN NAME these are the only ones that mean
 * "somebody is using this address": every zone has an SOA and NS records of its own, and
 * plenty have MX, TXT and CAA that have nothing to do with a website. Telling someone
 * "something already uses example.com — it points at v=spf1 include:…" would be alarming,
 * wrong, and the fastest way to lose their trust in every other sentence we write.
 *
 * Below the apex the test is deliberately the opposite way round (see {@link claimsTheName}).
 */
const WEB_TYPES = new Set(["A", "AAAA", "CNAME", "ANAME", "ALIAS"]);

/**
 * Does this record mean the name is spoken for?
 *
 * At the apex: only a record that points web traffic somewhere.
 *
 * Anywhere else: anything at all except the zone's SOA. Not because every record is a
 * website, but because a CNAME cannot coexist with ANY other record at the same name — DNS
 * forbids it and Route 53 refuses the write. A lone TXT at `www` really does stand between
 * the user and their site, and saying so beats a raw `InvalidChangeBatch` later.
 */
function claimsTheName(record: ExistingRecord, name: string, zone: string): boolean {
  if (record.type === "SOA") return false;
  if (zone && name === zone) return WEB_TYPES.has(record.type);
  return true;
}

/** True when the record already sends the name where we want it to go. */
function pointsAt(record: ExistingRecord, target: string): boolean {
  return record.values.some((value) => sameHost(value, target));
}

/** Of several records at one name, the one worth showing: the one that looks like the site. */
function pickTelling(records: ExistingRecord[]): ExistingRecord | undefined {
  const withValue = records.filter((r) => r.values.length > 0);
  const pool = withValue.length ? withValue : records;
  return pool.find((r) => WEB_TYPES.has(r.type)) ?? pool[0];
}

/**
 * What using this address would mean, from what the zone actually contains.
 *
 * The order is the whole point. A record AT THE NAME beats a wildcard, because that is what
 * DNS does — which is exactly why the wildcard case is a reassurance ("every other address
 * keeps working") and not a refusal.
 *
 * `already-ours` needs a target to compare against; without one (no site yet, or AWS has not
 * said what the record should be) every existing record reads as "taken", which is the
 * cautious way round: it asks a question the user can answer instead of overwriting.
 *
 * A wildcard pointing at our own site is still `shadowed-by-wildcard`, deliberately. It is
 * not "nothing to do": the certificate-validation record needs its own exact name too, and a
 * wildcard answers THAT with the wrong value — which is how the domain fails to verify while
 * everything looks right.
 */
export function classifyName(lookup: NameLookup): NameClassification {
  const name = normalizeDomain(lookup.name);
  const zone = normalizeDomain(lookup.zone ?? "");
  const target = (lookup.target ?? "").trim();

  const claims = lookup.records.exact.filter((record) => claimsTheName(record, name, zone));
  if (claims.length) {
    const ours = target ? claims.find((record) => pointsAt(record, target)) : undefined;
    if (ours) return { state: "already-ours", existing: ours };
    const telling = pickTelling(claims);
    return telling ? { state: "taken", existing: telling } : { state: "taken" };
  }

  const wildcard = lookup.records.wildcard;
  if (wildcard) return { state: "shadowed-by-wildcard", existing: wildcard };
  return { state: "free" };
}

// ---------------------------------------------------------------------------
// Writing — the destructive half
// ---------------------------------------------------------------------------

export interface UpsertOptions {
  /**
   * AWS's own word for the record type, passed through rather than re-derived. Only a CNAME
   * can be written for the user; anything else is refused with a sentence (see below).
   */
  type?: string;
  /** The zone's own name, so a CNAME at the root domain is refused before AWS refuses it. */
  zoneName?: string;
  /**
   * The user has seen what is there and said yes to moving it. Without this, a name that
   * already points somewhere else is refused — the guard that makes "never silent" a property
   * of the plumbing rather than a promise the screen above has to keep.
   */
  replaceExisting?: boolean;
  ttlSeconds?: number;
}

/**
 * Point one name at one target, and hand back Route 53's id for the change.
 *
 * `UPSERT` replaces the whole record set for that name and type — it does not merge (the
 * gotcha that bit MailPoppy in its Phase 0). For a CNAME that is inherent: a name has exactly
 * one. It is also why this re-reads the name first and refuses to proceed when something else
 * is there: by the time IAM is involved the record is already gone.
 *
 * What it will not do, and says so in a sentence:
 *  - anything but a CNAME. A root domain needs AWS's ANAME/ALIAS, which is a different write
 *    with a different shape, and inventing it is how a domain silently points at nothing;
 *  - a CNAME at the zone's own name. DNS forbids it (the zone's SOA and NS live there) and
 *    Route 53 answers with an `InvalidChangeBatch` nobody could act on.
 * Both leave the copy-these-records path, which works everywhere, as the answer.
 */
export async function upsertRecord(
  r53: Route53Client,
  zoneId: string,
  name: string,
  target: string,
  options: UpsertOptions = {},
): Promise<string> {
  const recordName = normalizeDomain(name);
  const value = target.trim();
  const type = (options.type ?? "CNAME").trim().toUpperCase();
  const zoneName = normalizeDomain(options.zoneName ?? "");

  if (!zoneId) throw new HttpError(400, "We don't know which of your domains that address belongs to — try the check again.");
  if (!recordName) throw new HttpError(400, "Type the address you want to use, like www.example.com.");
  if (!value) throw new HttpError(400, "AWS hasn't said what that address should point at yet — give it a moment and check again.");
  if (type !== "CNAME") {
    throw new HttpError(
      400,
      `We can't add a ${type} record for you — copy the records below to your DNS host instead, or use an address like www.${zoneName || recordName} and we'll set that one up for you.`,
    );
  }
  if (zoneName && recordName === zoneName) {
    throw new HttpError(
      400,
      `A domain on its own can't be pointed this way — use an address like www.${zoneName} and we'll set it up for you, or copy the records below to your DNS host.`,
    );
  }

  // Read before write. The screen has almost certainly already shown this, but the two are
  // seconds apart and a record can change in between — and a guard that only exists on the
  // screen is not a guard.
  const records = await readRecords(r53, zoneId, recordName, zoneName);
  const { state, existing } = classifyName({ name: recordName, zone: zoneName, target: value, records });
  if (state === "taken" && !options.replaceExisting) {
    const points = existing?.values[0];
    throw new HttpError(
      409,
      `${recordName} already points at ${points ?? "something else"} — connecting your website here would move it, so say yes to that and we'll make the change.`,
    );
  }

  const comment = `HostingPoppy: ${recordName} -> ${value}`.slice(0, MAX_COMMENT);
  const out = await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: comment,
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: recordName,
              Type: "CNAME",
              TTL: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
              ResourceRecords: [{ Value: value }],
            },
          },
        ],
      },
    }),
  );
  return changeIdOf(out.ChangeInfo?.Id);
}

/** Route 53's word for how far a change has got → ours. */
/**
 * Remove a record we put there — and ONLY while it still points where we put it.
 *
 * A CNAME left behind when its website is deleted is not merely untidy: it points a name the
 * user still owns at a CloudFront distribution that no longer exists, which is the classic
 * subdomain-takeover setup. Whoever manages to claim that distribution name serves content on
 * their domain. So teardown removes it, and "leaves no trace" covers DNS too.
 *
 * The safety rule is the inverse of the write path's: we never delete a record that no longer
 * matches what we wrote. If the user has since repointed the name at something of their own,
 * that record is theirs now, and deleting it during OUR cleanup would take down a site we do
 * not own. Absent, changed, or a different type — all mean "not ours", and all answer false.
 *
 * Route 53's DELETE demands the record set EXACTLY as it exists (name, type, TTL and every
 * value), which is why this reads before it writes rather than constructing one from what we
 * think is there.
 */
export async function removeRecordIfOurs(
  r53: Route53Client,
  zoneId: string,
  name: string,
  expectedTarget: string,
  type = "CNAME",
): Promise<boolean> {
  const wanted = normalizeDomain(name);
  const target = normalizeDomain(expectedTarget);
  if (!zoneId || !wanted || !target) return false;

  let existing: RecordSetLike | undefined;
  try {
    const out = await r53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: wanted,
        // The SDK types this as its RRType union; we accept AWS's own word as a string and
        // hand it straight back, so a type we have not enumerated still reads correctly.
        StartRecordType: type as never,
        MaxItems: 1,
      }),
    );
    existing = (out.ResourceRecordSets ?? []).find(
      (r) => decodeDnsName(r.Name) === wanted && (r.Type ?? "").toUpperCase() === type,
    );
  } catch {
    // A read we are not allowed to make, or a zone that has gone: nothing to clean up here,
    // and a teardown must never fail because DNS was unreadable.
    return false;
  }
  if (!existing) return false;

  const values = (existing.ResourceRecords ?? []).map((v) => normalizeDomain(v.Value ?? ""));
  const stillOurs = values.length === 1 && values[0] === target;
  if (!stillOurs) return false;

  try {
    await r53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: { Changes: [{ Action: "DELETE", ResourceRecordSet: existing as never }] },
      }),
    );
    return true;
  } catch {
    // Reported by the caller as something we could not remove, never swallowed into success.
    return false;
  }
}

export function mapChangeStatus(status: string | undefined): DnsChangeState {
  const value = (status ?? "").trim().toUpperCase();
  if (value === "INSYNC") return "published";
  if (value === "PENDING") return "pending";
  return "unknown";
}

/**
 * Has the change we made finished publishing inside Route 53?
 *
 * Worth asking because it separates two waits the user cannot otherwise tell apart: AWS still
 * rolling the change out to its own servers, versus the rest of the internet's caches holding
 * the old answer. Never throws — this is a progress readout, and the real proof is
 * {@link resolveName}, so a refused read is "unknown" and the screen carries on.
 */
export async function changeStatus(r53: Route53Client, changeId: string): Promise<DnsChangeState> {
  const id = changeIdOf(changeId);
  if (!id) return "unknown";
  try {
    const out = await r53.send(new GetChangeCommand({ Id: id }));
    return mapChangeStatus(out.ChangeInfo?.Status);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Asking the internet, not only AWS
// ---------------------------------------------------------------------------

/** The three lookups we make, injected so the tests never touch a real resolver. */
export interface DnsResolver {
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6?(name: string): Promise<string[]>;
}

export interface ResolveOptions {
  resolver?: DnsResolver;
  timeoutMs?: number;
}

function nodeResolver(timeoutMs: number): DnsResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    resolveCname: (name) => resolver.resolveCname(name),
    resolve4: (name) => resolver.resolve4(name),
    resolve6: (name) => resolver.resolve6(name),
  };
}

/** A hung resolver must not hang a screen; the timer is always cleared. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("dns lookup timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanAnswers(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const answer = value.trim().toLowerCase().replace(/\.+$/, "");
    if (answer) seen.add(answer);
  }
  return [...seen];
}

/**
 * What the public internet answers for this name right now.
 *
 * AWS's view and the internet's view are different things, and the difference is the bug this
 * file exists for: Route 53 can hold a perfectly good zone while the domain's nameservers
 * point somewhere else entirely, and a wildcard elsewhere can answer for a name that has no
 * record of its own. Asking a resolver is the only way to say what a visitor would actually
 * get — which is what makes "your address answers X, and that is not this website" possible
 * instead of "we couldn't finish connecting that address".
 *
 * NEVER THROWS. A failed lookup means nothing answers, which is itself the useful answer, and
 * an empty list reads exactly that way everywhere it is used. The CNAME is asked for first
 * because it names the service the address is pointed at — the human-readable half of the
 * story — and addresses are the fallback when there is no CNAME to see.
 */
export async function resolveName(name: string, options: ResolveOptions = {}): Promise<string[]> {
  const host = normalizeDomain(name);
  if (!host) return [];
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const resolver = options.resolver ?? nodeResolver(timeoutMs);

  const attempts: (() => Promise<string[]>)[] = [
    () => resolver.resolveCname(host),
    () => resolver.resolve4(host),
    () => (resolver.resolve6 ? resolver.resolve6(host) : Promise.resolve([])),
  ];

  for (const attempt of attempts) {
    try {
      const answers = cleanAnswers(await withTimeout(attempt(), timeoutMs));
      if (answers.length) return answers;
    } catch {
      // Nothing answered this way. Try the next, and let "nothing" be the answer if none do.
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Everything the domain screen needs about one address
// ---------------------------------------------------------------------------

export interface InspectOptions extends ResolveOptions {
  /** What the address must end up pointing at, when AWS has already said. */
  target?: string;
}

/**
 * Look the address up every way we can, and hand back the facts.
 *
 * The route layer runs this through `amplify.ts::describeDomainCheck`, which turns the facts
 * into the sentence and decides whether "add the record for me" is on offer. Keeping the
 * looking and the deciding apart is what lets every sentence the user can see be unit-tested
 * without AWS.
 *
 * Every failure lands as state "unknown" with AWS's own words kept for the technical-details
 * disclosure — no zone in this account, a refused read, a throttle. That is not a broken
 * feature: "unknown" is what the copy-these-records flow has always been, and this poppy
 * shipped with nothing else. Being unable to read someone's DNS must never be the reason they
 * cannot put their website online.
 */
export async function inspectName(
  r53: Route53Client,
  address: string,
  options: InspectOptions = {},
): Promise<NameFacts> {
  const addr = normalizeDomain(address);
  const { root, prefix } = splitDomain(addr);
  const answers = await resolveName(addr, options);
  if (!addr) return { address: addr, root, prefix, state: "unknown", answers };

  let zone: HostedZoneRef | null = null;
  try {
    zone = await findZone(r53, addr);
  } catch (e) {
    return { address: addr, root, prefix, state: "unknown", answers, detail: rawDetail(e) };
  }
  if (!zone) return { address: addr, root, prefix, state: "unknown", answers };

  try {
    const records = await readRecords(r53, zone.id, addr, zone.name);
    const { state, existing } = classifyName({ name: addr, zone: zone.name, target: options.target, records });
    return { address: addr, root, prefix, zone, state, existing, answers };
  } catch (e) {
    return { address: addr, root, prefix, zone, state: "unknown", answers, detail: rawDetail(e) };
  }
}
