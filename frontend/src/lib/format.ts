// The small pure helpers every screen shares: sizes, times, and what AWS will charge.
//
// The rule these all serve (UX.md, "Copy tone"): numbers are rounded and honest —
// "about $4/mo", never "$3.87". A precise-looking number we cannot actually stand behind
// is worse than an obviously approximate one, because the user plans around it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Sizes are counted in 1024s, which is what the AWS console reports storage in. At the
// precision we ever display, the 1000-vs-1024 argument is smaller than our rounding.
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** One decimal below ten, whole numbers above — how people read a size out loud. */
function scaled(value: number): string {
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}

/**
 * A file size, as precise as it is useful: "512 bytes", "48 KB", "4.2 MB".
 * Use it in a chip beside a filename, where the exact number is the point.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < KB) return `${Math.round(bytes)} ${Math.round(bytes) === 1 ? "byte" : "bytes"}`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${scaled(bytes / MB)} MB`;
  return `${scaled(bytes / GB)} GB`;
}

/**
 * The same size as a sentence fragment: "about 4 MB". Below a kilobyte there is nothing
 * to approximate, so it stays exact — "about 512 bytes" would be pretending.
 */
export function describeBytes(bytes: number): string {
  const text = formatBytes(bytes);
  if (!Number.isFinite(bytes) || bytes < KB) return text;
  return `about ${text}`;
}

/**
 * How long ago something happened, in the words a person would use: "2 hours ago".
 * Anything older than a month becomes a date, because "43 days ago" is not a fact anyone
 * can picture. `iso` is whatever AWS reported; an unreadable one says so calmly.
 */
export function formatRelativeTime(iso: string | undefined | null, now: Date = new Date()): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";

  const seconds = (now.getTime() - then) / 1000;
  // Negative means the clock skewed — a deploy cannot really have started in the future,
  // and "in 4 seconds" would read as a bug. Treat the whole near window as "just now".
  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} minutes ago`;
  if (minutes < 90) return "an hour ago";
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = hours / 24;
  if (days < 2) return "yesterday";
  if (days < 30) return `${Math.round(days)} days ago`;

  const d = new Date(then);
  // Spelled out from our own table rather than toLocaleDateString: the browser's locale
  // would silently change this string between one user's machine and the next.
  const month = MONTHS[d.getMonth()] ?? "";
  return `on ${d.getDate()} ${month} ${d.getFullYear()}`;
}

/**
 * AWS Amplify Hosting's published prices for the regions this poppy can host in.
 *
 * These are BUILT IN rather than fetched, and that is a deliberate, narrow exception to
 * "never hardcode prices" (AGENTS.md §9): reading the Price List API needs a
 * `pricing:GetProducts` grant, and this poppy's manifest grants Amplify and nothing else.
 * Adding a second service to the consent screen to sweeten a cost estimate is a bad
 * trade. So the estimate is labelled approximate everywhere it appears — never dressed up
 * as live — and it is a per-GB price with no per-region variation to get wrong.
 */
export const STORAGE_USD_PER_GB_MONTH = 0.023;
export const SERVED_USD_PER_GB = 0.15;

/** The reassurance UX.md requires beside every number on this screen. */
export const AWS_PRICES_NOTE = "Billed by AWS to you, at AWS's prices — we add nothing.";

export interface CostInputs {
  /** What the site itself occupies — in practice, the size of what was uploaded. */
  storedBytes: number;
  /** What visitors download in a month: page weight × visits, roughly. */
  servedBytesPerMonth: number;
}

export interface CostEstimate {
  /** The raw figure, for comparing options — never show this one to the user. */
  usd: number;
  storageUsd: number;
  trafficUsd: number;
  /** The line the screen shows: "about $4 a month", or the pennies sentence. */
  text: string;
}

/**
 * What a static site costs to host for a month.
 *
 * There is no build-minutes line: an uploaded site is never built in AWS (DESIGN §4 —
 * a confined backend cannot build, so we ship the built files). Adding a build charge
 * here would overstate the bill for every site this poppy hosts today.
 */
export function estimateMonthlyCost(input: CostInputs): CostEstimate {
  const stored = Math.max(0, input.storedBytes) / GB;
  const served = Math.max(0, input.servedBytesPerMonth) / GB;
  const storageUsd = stored * STORAGE_USD_PER_GB_MONTH;
  const trafficUsd = served * SERVED_USD_PER_GB;
  const usd = storageUsd + trafficUsd;
  return { usd, storageUsd, trafficUsd, text: describeMonthlyUsd(usd) };
}

/**
 * A monthly figure in words. Below a dollar we say so plainly — for most of the sites
 * this poppy hosts that IS the honest answer, and "about $0 a month" sounds like a dodge.
 * Above it, the rounding gets coarser as the number grows, so the estimate never implies
 * a precision the inputs never had.
 */
export function describeMonthlyUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "unknown";
  // The most reassuring sentence a cost-anxious user can read (AGENTS.md §9), and here it
  // is simply true: nothing has been deployed, so there is nothing to bill.
  if (usd === 0) return "nothing — you aren't being billed for this yet";
  if (usd < 0.5) return "pennies — well under $1 a month";
  if (usd < 1) return "about $1 a month";
  if (usd < 10) return `about $${Math.round(usd)} a month`;
  if (usd < 100) return `about $${Math.round(usd / 5) * 5} a month`;
  return `about $${Math.round(usd / 10) * 10} a month`;
}
