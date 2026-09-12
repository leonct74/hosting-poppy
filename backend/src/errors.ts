// AWS error → one calm human sentence (UX.md ground rule 5 + its error dictionary).
//
// The user of this poppy has never created hosting infrastructure. "LimitExceededException:
// Resource limit exceeded for app" tells them nothing they can act on, so nothing raw ever
// reaches a primary screen. It is not DELETED though — `rawDetail()` keeps it for the
// "technical details" disclosure, because a poppy that hides what AWS actually said is a
// poppy nobody can debug (AGENTS.md §9, "relocate technical detail, don't delete it").
//
// Everything here is pure: `friendlyError` is a lookup over the error's name, message and
// HTTP status, so every sentence the user can ever see is unit-testable without AWS.

import { regionNotSupportedMessage } from "./regions";

/**
 * An error whose message was already written for the user, carrying the status the route
 * layer should answer with. Anything thrown as an HttpError passes through `friendlyError`
 * untouched — that is the whole point of it.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** The AWS SDK's error name (`NotFoundException`, `ThrottlingException`, …), or "". */
function errName(e: unknown): string {
  return typeof (e as { name?: unknown })?.name === "string" ? (e as { name: string }).name : "";
}

function errMessage(e: unknown): string {
  const m = (e as { message?: unknown })?.message;
  if (typeof m === "string" && m) return m;
  return typeof e === "string" ? e : "";
}

/** The HTTP status AWS answered with, when the SDK attached one. */
function errStatus(e: unknown): number | undefined {
  const meta = (e as { $metadata?: { httpStatusCode?: unknown } })?.$metadata;
  return typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : undefined;
}

/** A deploy that AWS ran and failed — a job status, not a thrown error, so it needs its own sentence. */
export function deployFailedMessage(): string {
  return "That upload didn't go live — check the zip has your site's files at the top level (index.html, not a folder containing it), then try again.";
}

/** The wait every custom domain goes through before the certificate is issued. */
export function domainNotVerifiedMessage(domain?: string): string {
  const which = domain ? `${domain} isn't` : "Your domain isn't";
  return `${which} confirmed yet — add the records below wherever you bought it, then give it up to an hour. Your site stays live on its AWS address the whole time.`;
}

/** True when AWS says the thing is gone. On a delete that is SUCCESS, not a failure. */
export function isNotFound(e: unknown): boolean {
  const name = errName(e);
  if (name === "NotFoundException" || name === "ResourceNotFoundException") return true;
  return errStatus(e) === 404 && /not found|does not exist|no such/i.test(errMessage(e));
}

/** True when AWS is asking us to slow down — the caller should back off and retry, not report. */
export function isThrottling(e: unknown): boolean {
  const name = errName(e);
  if (/^(Throttling|TooManyRequests|RequestLimitExceeded)/.test(name)) return true;
  return errStatus(e) === 429 || /rate exceeded|too many requests|throttl/i.test(errMessage(e));
}

/**
 * The rules, in order. First match wins, so the specific ones (a paused connection) come
 * before the general ones (anything from the broker), and the catch-all statuses come last.
 * Kept as data rather than an if-ladder so the whole vocabulary of the poppy can be read —
 * and reviewed for jargon — in one screenful.
 */
interface Rule {
  when: (name: string, message: string, status: number | undefined) => boolean;
  say: string;
}

const RULES: Rule[] = [
  // The user's AWS connection is switched off in AgentsPoppy. Distinct from "unreachable"
  // because the fix is a click they can make right now.
  {
    when: (_n, m) => /paused|revoked|disconnected/i.test(m) && /agentspoppy|connection/i.test(m),
    say: "Your AWS connection is paused in AgentsPoppy — turn it back on there, then try again.",
  },
  // No credentials at all: the broker isn't answering, or refused to mint. boot.ts already
  // phrases its own version of this; we restate it in the dictionary's words so the poppy has
  // one voice wherever the failure surfaced.
  {
    when: (n, m) =>
      n === "CredentialsProviderError" ||
      // Matches boot.ts's own sentence, NOT the bare word "agentspoppy". Every AccessDenied
      // message from AWS quotes the assumed-role ARN — which contains "AgentsPoppyBroker" and
      // the connection id — so a substring match on the name swallowed every permission error
      // and told the user to reconnect, which can never fix a missing permission. Found on the
      // first live run; the unit tests missed it because their fixtures had no real ARN in them.
      /waiting for AWS access from AgentsPoppy/i.test(m) ||
      /resolved credential object is not valid|could not load credentials/i.test(m),
    say: "Can't reach your AgentsPoppy connection — reopen HostingPoppy from AgentsPoppy.",
  },
  // The credentials exist but the action was refused. Under this poppy's grants that means
  // one of: acting on an app that isn't ours, or a connection whose scope changed.
  {
    when: (n, m, s) =>
      n === "UnauthorizedException" ||
      n === "AccessDeniedException" ||
      s === 403 ||
      /not authorized|access denied/i.test(m),
    say: "Your AgentsPoppy connection wouldn't allow that — reopen HostingPoppy from AgentsPoppy, then try again.",
  },
  // Amplify isn't offered here. Rarely thrown (we gate on it at /meta), but a connection can
  // be moved to another region while the poppy is open.
  {
    when: (_n, m) => /region/i.test(m) && /not (supported|available|enabled)/i.test(m),
    say: regionNotSupportedMessage(),
  },
  // AWS caps how many Amplify apps an account may have per region. No number in the sentence:
  // AWS changes it, and a stale number would be a lie.
  {
    when: (n, m) => n === "LimitExceededException" || /limit exceeded|quota/i.test(m),
    say: "Your AWS account has reached its limit for websites — remove one you no longer need, or ask AWS to raise the limit.",
  },
  {
    when: (n, m, s) => n === "NotFoundException" || n === "ResourceNotFoundException" || (s === 404 && /not found|does not exist/i.test(m)),
    say: "That website isn't in your AWS account any more — it looks like it was already removed.",
  },
  {
    when: (n, m, s) => /^(Throttling|TooManyRequests|RequestLimitExceeded)/.test(n) || s === 429 || /rate exceeded|throttl/i.test(m),
    say: "AWS is handling a lot of requests right now — wait a moment and try again.",
  },
  // The laptop, not AWS. Worth its own sentence: nothing in the user's account is wrong.
  {
    when: (_n, m) => /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network error/i.test(m),
    say: "Couldn't reach AWS just now — check your internet connection and try again.",
  },
  // The domain association exists but AWS hasn't verified ownership yet. Not a failure, a wait.
  {
    when: (_n, m) => /pending[_ ]verification|not verified|verification failed/i.test(m),
    say: domainNotVerifiedMessage(),
  },
  {
    when: (n, _m, s) =>
      n === "InternalFailureException" || n === "DependentServiceFailureException" || (typeof s === "number" && s >= 500),
    say: "AWS had a problem on its side — wait a minute and try again.",
  },
  {
    when: (n, _m, s) => n === "BadRequestException" || s === 400,
    say: "AWS wouldn't accept that — the technical details say exactly what it objected to.",
  },
];

const FALLBACK = "Something went wrong while working with your website — the technical details say what AWS reported.";

/** One calm sentence for the user, naming the one thing to do next. Never a raw AWS error. */
export function friendlyError(e: unknown): string {
  if (e instanceof HttpError) return e.message; // already written for a human
  const name = errName(e);
  const message = errMessage(e);
  const status = errStatus(e);
  for (const rule of RULES) {
    if (rule.when(name, message, status)) return rule.say;
  }
  return FALLBACK;
}

/** How much raw AWS text we keep. Long enough for a real diagnosis, short enough for a disclosure. */
const MAX_DETAIL = 600;

/**
 * The raw text, for the "technical details" disclosure — never for the main message.
 * Returns undefined when there is nothing extra to show, so the UI can leave the disclosure
 * out entirely rather than offering an empty one.
 */
export function rawDetail(e: unknown): string | undefined {
  const name = errName(e);
  const message = errMessage(e);
  if (!message) return undefined;
  if (e instanceof HttpError) return undefined; // our own sentence; there is no hidden depth
  const full = name && name !== "Error" ? `${name}: ${message}` : message;
  return full.length > MAX_DETAIL ? `${full.slice(0, MAX_DETAIL)}…` : full;
}

export interface ErrorReply {
  status: number;
  /** The sentence the user reads. */
  message: string;
  /** What AWS actually said, for the disclosure. Absent when there is nothing more to say. */
  detail?: string;
}

/**
 * What a route hands back when something fails.
 *
 * Deliberately never 404: the host bridge and the frontend both read a 404 as "no such
 * route", and "the site is already gone" is usually SUCCESS anyway — routes should check
 * `isNotFound()` and answer 200, rather than passing the error here.
 */
export function describeError(e: unknown): ErrorReply {
  const status = e instanceof HttpError ? e.status : isThrottling(e) ? 429 : errStatus(e) === 403 ? 403 : 500;
  const detail = rawDetail(e);
  return detail === undefined ? { status, message: friendlyError(e) } : { status, message: friendlyError(e), detail };
}
