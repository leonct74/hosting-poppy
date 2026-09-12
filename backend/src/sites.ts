// The pure decisions behind a site: what it may be called, what its address is, and how to
// read the DNS records AWS hands back for a custom domain.
//
// Nothing here talks to AWS. That is on purpose — these are the rules the user bumps into
// (a rejected name, a mistyped domain, a record that has to be copied by hand into a
// registrar's form), so they are the rules that most need to be tested exhaustively and
// worded like a person wrote them.

import type { DnsRecord } from "./types";

/**
 * One live version per site, always called "main".
 *
 * Amplify calls it a branch; the user never sees that word (UX.md: no AWS jargon on a
 * primary screen). A site here has exactly one thing serving to the public, so there is
 * nothing for a second branch to mean until the GitHub path arrives in Phase 3.
 */
export const LIVE_BRANCH = "main";

/** Our cap on a site name — a label in a list, not a description. AWS itself allows 255. */
const MAX_SITE_NAME = 60;

/** Amplify's own ceiling for an app name. We never generate anything near it. */
const MAX_APP_NAME = 255;

/** Collapse the whitespace a name picks up from copy-paste, without changing the words. */
export function normalizeSiteName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** A human sentence when the name won't do; null when it's fine. */
export function validateSiteName(raw: string): string | null {
  const name = normalizeSiteName(raw);
  if (!name) return "Give your website a name, so you can tell it apart from your others.";
  if (name.length > MAX_SITE_NAME) return `That name is a little long — keep it under ${MAX_SITE_NAME} characters.`;
  // Control characters arrive by paste, never by typing, and would travel straight into an
  // AWS call and a console listing. Escaped rather than literal so the source stays printable.
  if (/[\u0000-\u001f\u007f]/.test(name)) return "That name has characters we can't use — letters, numbers, spaces and hyphens work best.";
  // Without a letter or digit there is nothing left after sanitising for AWS, and the site
  // would end up named "website" behind the user's back.
  if (!/[a-z0-9]/i.test(name)) return "Give your website a name with at least one letter or number in it.";
  return null;
}

/**
 * The name the Amplify app is created with — the user's name, reduced to what AWS accepts.
 *
 * Amplify app names are not identities (the appId is), so this need not be unique and two
 * sites may legitimately share one. Accented letters are decomposed first so "Café" becomes
 * "Cafe" rather than losing the letter entirely. Never returns "" — a create call with an
 * empty name fails, and failing at the AWS boundary over a name is a rotten first experience.
 */
export function amplifyAppName(siteName: string): string {
  const slug = siteName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_APP_NAME)
    .replace(/-+$/, ""); // the slice can leave a trailing hyphen behind
  return slug || "website";
}

/**
 * The address every site has from its very first deploy, before any domain of the user's.
 *
 * AWS gives each app a `defaultDomain` (`d1a2b3c4d5.amplifyapp.com`) and serves the live
 * version at `<branch>.<defaultDomain>`. UX.md ground rule 3 leans on this: the site is
 * clickable within minutes, and DNS waits never block that first win. Returns "" when either
 * half is missing so the UI can simply not render a link, rather than one that 404s.
 */
export function defaultUrlFor(branch: string, defaultDomain: string | undefined): string {
  const host = (defaultDomain ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const label = branch.trim().toLowerCase();
  if (!host || !label) return "";
  return `https://${label}.${host}`;
}

/** Trim, lowercase, drop the trailing dot DNS people type out of habit. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

/** Each label 1–63 chars, no leading/trailing hyphen, and a real letters-only last label. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A human sentence when the domain won't do; null when it's fine.
 *
 * We reject `https://` and paths rather than quietly stripping them: the user is telling us
 * the name they OWN, and silently editing their answer is how someone ends up staring at a
 * domain they never typed. Every sentence shows the shape we want instead.
 */
export function validateDomain(raw: string): string | null {
  const domain = normalizeDomain(raw);
  if (!domain) return "Type the domain you want to use, like example.com.";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(domain) || domain.startsWith("//")) {
    return "Type just the domain — example.com — with no https:// in front.";
  }
  if (domain.includes("/")) return "Type just the domain — example.com — with nothing after it, no / and no page name.";
  if (/\s/.test(domain)) return "A domain has no spaces in it — type it as one word, like example.com.";
  if (domain.includes("@")) return "That looks like an email address — type just the domain part, like example.com.";
  if (domain.length > 253) return "That domain is longer than any real domain can be — check it for typos.";
  if (!domain.includes(".")) return "A domain needs a dot in it, like example.com.";
  if (!HOSTNAME.test(domain)) return "That doesn't look like a domain — check it for typos, then type it like example.com.";
  return null;
}

/**
 * Two-label endings that behave like a top-level domain: the part before them is the name
 * somebody registered.
 *
 * This is a HEURISTIC, not the real public-suffix list — that list is thousands of entries,
 * changes constantly, and would have to be shipped and refreshed. The consequence is honest
 * and visible: the UI shows the user what we derived ("we'll set this up under example.co.uk,
 * with shop in front") and lets them correct it, because getting `root` wrong means asking
 * AWS to certify a domain the user does not own — which fails loudly rather than silently.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br",
  "co.za", "org.za", "web.za", "net.za",
  "co.in", "net.in", "org.in", "firm.in", "gen.in",
  "com.mx", "com.ar", "com.co", "com.pe", "com.uy",
  "com.sg", "com.hk", "com.tw", "com.cn", "net.cn", "org.cn",
  "co.kr", "or.kr", "ne.kr",
  "com.tr", "com.ua", "com.pl", "com.ru", "com.my", "com.ph", "com.vn", "co.th", "co.il", "co.id",
]);

export interface DomainParts {
  /** The domain the user actually registered — what Amplify must be given. */
  root: string;
  /** What sits in front of it ("www", "shop", "a.b"). Empty for the root domain itself. */
  prefix: string;
}

/**
 * Split what the user typed into the domain they OWN plus a prefix.
 *
 * Amplify needs both, separately: `CreateDomainAssociation` takes the registered domain and a
 * list of `subDomainSettings` prefixes, so "www.example.com" is not a domain to it — it is
 * "example.com" with a "www" in front. Multi-label endings (`co.uk`) are what make this more
 * than a `split(".").slice(-2)`, and why the list above exists.
 */
export function splitDomain(input: string): DomainParts {
  const domain = normalizeDomain(input);
  if (!domain) return { root: "", prefix: "" };

  const labels = domain.split(".");
  if (labels.length <= 2) return { root: domain, prefix: "" };

  const lastTwo = labels.slice(-2).join(".");
  const rootLabels = labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  // A bare "co.uk" has nothing in front of the suffix, so there is no registered name to find
  // — treat the whole thing as the root and let AWS refuse it, rather than inventing a split.
  if (labels.length <= rootLabels) return { root: domain, prefix: "" };

  return {
    root: labels.slice(-rootLabels).join("."),
    prefix: labels.slice(0, labels.length - rootLabels).join("."),
  };
}

/** What a DNS record type token looks like, so we can tell "www CNAME x" from prose. */
const TYPE_TOKEN = /^[A-Za-z][A-Za-z0-9]{0,14}$/;

/**
 * Read one of the DNS records Amplify hands back.
 *
 * AWS returns these as a SINGLE whitespace-separated string, and the shape varies:
 *   "_a1b2.example.com CNAME _c3d4.xyz.acm-validations.aws."   (proving the domain is yours)
 *   "www CNAME d111111abcdef8.cloudfront.net"                  (pointing a subdomain at it)
 * A root domain cannot be a CNAME, so AWS answers ANAME or ALIAS there instead — which is why
 * `type` is a free-form string and not a union: any fixed list would eventually be wrong.
 *
 * When the shape is not "name TYPE value…" we do NOT guess. The whole raw string becomes the
 * value with an empty name and type, and the UI shows it verbatim — a record the user
 * copy-pastes wrongly breaks their domain silently, so being visibly unhelpful beats being
 * invisibly wrong. The value is kept byte-for-byte (trailing dot included) for the same
 * reason; only the name loses a trailing dot, because registrar host fields are relative and
 * reject one.
 */
export function parseDnsRecord(raw: string, purpose: DnsRecord["purpose"]): DnsRecord {
  const text = (raw ?? "").trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const [name, type] = tokens;

  if (tokens.length < 3 || !name || !type || !TYPE_TOKEN.test(type)) {
    return { purpose, name: "", type: "", value: text };
  }

  return {
    purpose,
    name: name.replace(/\.+$/, ""),
    type, // exactly what AWS sent — CNAME, ANAME, ALIAS, whatever comes next
    value: tokens.slice(2).join(" "),
  };
}
