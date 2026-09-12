// S8 — the everyday screen. One website: how it's doing, where it lives, what it costs,
// and the three things a person ever wants to do to it.
//
// Two rules shape everything below:
//
//  - The truth is AWS, never this component's memory (AGENTS.md §5). The parent re-reads
//    the site and hands it back down; while an upload is in flight we ask it to re-read on
//    a timer and say out loud that the work carries on without us. Nothing here is
//    remembered across a remount, so closing the window mid-upload and coming back lands
//    on live progress rather than a frozen screen.
//  - No AWS words on this screen (UX.md). It is "your website", "its address", "putting a
//    new version online" — the words "Amplify", "job" and "deployment" appear in the
//    Resources tab, where transparency requires them, and nowhere else. "Repository",
//    "branch" and "commit" are the exception, and only on a website built from GitHub: they
//    are GitHub's words for things the user chose themselves, and this audience knows them
//    (UX.md's audience note lists GitHub among the words they have).
//  - A website takes its code from a repository or by hand, and that is decided when it is
//    made and never afterwards (DESIGN §3.2) — AWS offers no way across. So the one action
//    that publishes is TWO actions here, and exactly one of them is ever on screen: offering
//    the wrong one sends somebody off to pack a build folder for a website that will refuse
//    it, which is what the backend's refusals are the last line against, not the first.

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { readFailure, type Failure } from "../lib/errors";
import {
  AWS_PRICES_NOTE,
  SERVED_USD_PER_GB,
  STORAGE_USD_PER_GB_MONTH,
  estimateMonthlyCost,
  formatRelativeTime,
  type CostInputs,
} from "../lib/format";
import type { Site } from "../types";
import { readRepo } from "./ConnectRepo";
import { DangerZone } from "./DangerZone";
import { FailureBanner } from "./FailureBanner";
// The site list and this screen MUST say the same words about the same website — "Live"
// here and "Going live" one tap away reads as two different apps. So the status wording
// and the address link come from the list's own helpers rather than being re-derived here.
import { AddressLink, siteStatus } from "./Home";

/**
 * How often we re-read a site that AWS is still working on.
 *
 * Only while something is actually in flight — a screen that polls a finished site burns
 * the user's AWS API budget to learn nothing, and the poll stops the moment the upload
 * settles.
 */
const POLL_MS = 5_000;

/**
 * What the banner says when the build wouldn't start and nothing in the failure was written
 * for a person. One sentence and the one thing to do next (UX.md ground rule 5) — the
 * backend's own sentences are better than this whenever it has one, so this is the fallback.
 */
const BUILD_FAILED = "We couldn't start a build just now — try again in a moment.";

export interface SiteDashboardProps {
  site: Site;
  /** Re-read this site from AWS. Without it the screen simply doesn't poll. */
  refresh?: () => Promise<void>;
  /**
   * Back to the list of websites. Required, not optional: this is the deepest screen in the
   * poppy, and the tab that holds the list is already the selected one — so without a control
   * of its own here, opening a website is a one-way trip.
   */
  onBack: () => void;
  /**
   * Opens the upload flow. The parent owns it — the file picker lives up there.
   *
   * Only ever called for a website that is fed by hand: a website built from GitHub gets the
   * build button below instead, and never both.
   */
  onPutNewVersionOnline: () => void;
  /**
   * A build has started on a website built from GitHub — the parent takes over and shows the
   * wait. It gets the site back rather than just the id, because following a job in AWS needs
   * the branch it belongs to as well.
   *
   * Required, not optional: without it a press would start a real build in the user's account
   * and leave them looking at a screen where nothing had happened.
   */
  onBuildStarted: (started: { site: Site; jobId: string }) => void;
  /** Opens the domain screen (S7). */
  onDomain: () => void;
  /** The website is gone; the parent should go back to the list. */
  onRemoved: () => void;
  /**
   * What the site occupies and what visitors download in a month, when the parent knows
   * it (it does, right after an upload). Left out, the card quotes AWS's rates instead of
   * inventing numbers — see the cost card below.
   */
  usage?: CostInputs;
  /** Injected in tests so nothing reaches AWS. */
  remove?: (id: string) => Promise<unknown>;
  /** Builds the newest commit. Injected in tests; the real one is `api.build`. */
  build?: (id: string) => Promise<{ jobId: string }>;
  openExternal?: (url: string) => void | Promise<void>;
}

export function SiteDashboard({
  site,
  refresh,
  onBack,
  onPutNewVersionOnline,
  onBuildStarted,
  onDomain,
  onRemoved,
  usage,
  remove = (id) => api.removeSite(id),
  build = (id) => api.build(id),
  openExternal,
}: SiteDashboardProps) {
  const status = siteStatus(site);
  const phase = site.lastDeploy?.phase;
  const working = phase === "pending" || phase === "running";
  /**
   * Which of the two publishing paths this website is on.
   *
   * An absent `source` is a website made before repositories could be connected, and every
   * one of those is fed by hand — so "not github" is the safe reading, and it is also the
   * one the backend takes.
   */
  const fromGithub = site.source === "github";

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<Failure | null>(null);

  // Held in a ref, not a dependency: a parent that passes an inline arrow would otherwise
  // hand us a different `refresh` on every render, and the timer would be torn down and
  // restarted each time — which on a busy parent means the poll never actually fires.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Re-attach to work already in flight, and let it go the moment it settles. The parent's
  // refresh is what actually re-reads AWS; we only decide when it is worth asking.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => {
      void refreshRef.current?.().catch(() => {
        // A failed poll is not worth a banner — the next one usually succeeds, and an error
        // that flashes every five seconds is noise the user cannot act on.
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  async function deployLatestCommit() {
    if (building) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const { jobId } = await build(site.id);
      onBuildStarted({ site, jobId });
    } catch (e) {
      setBuildError(readFailure(e, BUILD_FAILED));
    } finally {
      // Always — a rejection must never leave the button spinning (AGENTS.md §9). On success
      // the parent has already moved to the wait, so this lands on a screen that has gone,
      // which React treats as the no-op it is.
      setBuilding(false);
    }
  }

  const domain = site.domain;

  return (
    <div className="stack">
      <div className="card">
        {/* The same way out, worded and styled as on the domain screen, so the way back is
            always the same control wherever the user has got to. */}
        <div style={{ marginBottom: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← All websites
          </button>
        </div>

        <div className="spread" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }} className="break">
            {site.name}
          </h2>
          <span className={`badge ${status.tone}`}>
            <span className="dot" /> {status.label}
          </span>
        </div>

        {/* The address first. It is the thing the user came to click, and it works from the
            very first upload — before any domain of theirs, and whatever DNS is doing. */}
        {site.defaultUrl ? (
          <div className="stack">
            <div>
              <div className="section-title">Your site's address</div>
              <AddressLink url={site.defaultUrl} openExternal={openExternal} size="big" />
            </div>
            {domain?.phase === "live" && domain.url && (
              <div>
                <div className="section-title">Your own address</div>
                <AddressLink url={domain.url} openExternal={openExternal} size="big" />
              </div>
            )}
          </div>
        ) : (
          <p className="muted">
            AWS hasn't given this website its address yet — it appears here within a minute or two.
          </p>
        )}
      </div>

      {/* What happened last, in the same words the site list uses for the same state. */}
      <div className="card">
        <div className="section-title">Last time it went live</div>
        {working ? (
          <div className="stack">
            <div className="row">
              <span className="spinner" />
              <span>{status.note}</span>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              This carries on in AWS even if you close this window. Come back any time and you'll see where
              it got to.
            </p>
          </div>
        ) : status.tone === "bad" || status.tone === "warn" ? (
          <div className="stack">
            {/* Already one calm sentence when it arrives — the backend never puts a raw AWS
                error in a deploy's reason (see the wire contract). */}
            <div className="banner err">{status.note}</div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Your site is still being served from the last version that worked, if there was one.
            </p>
          </div>
        ) : (
          <p style={{ marginBottom: 0 }} className={status.tone === "ok" ? undefined : "muted"}>
            {status.note}
            {status.tone === "ok" && site.createdAt && (
              <span className="muted"> · set up {formatRelativeTime(site.createdAt)}</span>
            )}
          </p>
        )}
      </div>

      {/* Money, where the decision is (AGENTS.md §9). Two honest shapes: a real figure when
          the parent knows what the site holds and serves, and AWS's own rates when it does
          not — because HostingPoppy asks for permission to manage websites and nothing else,
          so it genuinely cannot read a traffic total. Inventing one would be worse than
          saying so. */}
      <div className="card">
        <div className="section-title">What AWS charges for this</div>
        {usage ? (
          <p style={{ marginBottom: 6 }}>
            At this month's size and traffic, that's <strong>{estimateMonthlyCost(usage).text}</strong>.
          </p>
        ) : (
          <>
            <p style={{ marginBottom: 6 }}>
              Roughly <strong>${STORAGE_USD_PER_GB_MONTH.toFixed(3)}</strong> a month per gigabyte stored,
              plus <strong>${SERVED_USD_PER_GB.toFixed(2)}</strong> per gigabyte downloaded. For a small
              site, pennies.
            </p>
            <details className="details" style={{ marginBottom: 6 }}>
              <summary>Why not my real bill?</summary>
              <p className="muted small" style={{ margin: "8px 0 0" }}>
                HostingPoppy can't total it. It only asks for permission to look after the websites
                themselves — not your account's spending — so these are AWS's published rates, not a
                reading of what you are actually charged.
              </p>
            </details>
          </>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          {AWS_PRICES_NOTE}
        </p>
      </div>

      {/* The user's own address. Three states, each with the one action that moves it on. */}
      <div className="card">
        <div className="section-title">Your own domain</div>
        {!domain && (
          <div className="spread">
            <p className="muted" style={{ margin: 0, maxWidth: "46ch" }}>
              Your site is on the address above. Point a domain you own at it whenever you like — your site
              stays live the whole time.
            </p>
            <button className="btn" onClick={onDomain}>
              Add a domain
            </button>
          </div>
        )}
        {domain && domain.phase === "live" && (
          <div className="spread">
            <p style={{ margin: 0 }}>
              <span className="badge ok">
                <span className="dot" /> {domain.domain} is live
              </span>
            </p>
            <button className="btn btn-sm" onClick={onDomain}>
              Domain settings
            </button>
          </div>
        )}
        {domain && domain.phase !== "live" && (
          <div className="stack">
            <div className="spread">
              <span className={`badge ${domain.phase === "failed" ? "bad" : "warn"}`}>
                <span className="dot" /> {domain.domain}
              </span>
              <button className="btn btn-sm" onClick={onDomain}>
                {domain.phase === "failed" ? "See what's wrong" : "Finish setting this up"}
              </button>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              {domain.reason ??
                "Waiting for the internet to notice — usually minutes, sometimes up to an hour. Your site stays live on its AWS address the whole time."}
            </p>
          </div>
        )}
      </div>

      {/* The ONE publishing action, and which one it is was settled when the website was made.
          Never both: an upload to a website AWS builds itself is refused — after the user has
          chosen and packed their build folder — and a website fed by hand has no commit to
          build. This branch is what keeps either from being offered in the first place. */}
      <div className="card">
        <div className="section-title">Actions</div>
        {fromGithub ? (
          <>
            {/* Where it will build from, before the button rather than after it: this is the
                one thing that decides what "the latest commit" actually means. */}
            <p className="small" style={{ margin: "0 0 10px" }}>
              Built from <strong className="mono break">{repoLabel(site.repository)}</strong>
              {site.branch && (
                <>
                  {" · "}
                  <span className="chip">{site.branch}</span>
                </>
              )}
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                onClick={() => void deployLatestCommit()}
                disabled={building || working}
                aria-busy={building || undefined}
              >
                {building && <span className="spinner" aria-hidden="true" />}
                {building ? "Starting the build…" : "Deploy the latest commit"}
              </button>
            </div>
            {buildError && <FailureBanner error={buildError} style={{ marginTop: 10 }} />}
            <p className="muted small" style={{ margin: "10px 0 0" }}>
              {working
                ? "It's building right now — you can start another build once this one has finished."
                : `Every push ${site.branch ? `to ${site.branch} ` : ""}goes live on its own. This rebuilds the newest commit without one. Visitors keep seeing the live version until the new one is ready.`}
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <button className="btn btn-primary" onClick={onPutNewVersionOnline}>
                Put a new version online
              </button>
            </div>
            <p className="muted small" style={{ margin: "10px 0 0" }}>
              A new version replaces the old one within a minute or two. Visitors never see an empty page —
              the version that's live now keeps serving until the new one is ready.
            </p>
          </>
        )}
      </div>

      <DangerZone
        siteName={site.name}
        address={site.defaultUrl}
        domain={domain?.domain}
        disabled={working}
        // A rejection is deliberately not caught here: DangerZone shows the one calm
        // sentence inside its own dialog, where the button that failed still is. Catching
        // it here would print the same failure twice, in two places.
        onRemove={async () => {
          await remove(site.id);
          onRemoved();
        }}
      />

      {/* A sibling poppy, mentioned once and quietly. Same promise, same account — but this
          screen's job is this website, so it never becomes an advert. */}
      <p className="muted small">
        Want to know who visits? TrafficPoppy counts your visitors in your own AWS account too — no cookies,
        no banners.
      </p>
    </div>
  );
}

/**
 * The repository as a person recognises it — `owner/repo` — from the full address AWS holds.
 *
 * Read with the connect screen's own parser rather than a second one of our own: two readings
 * of the same string are two chances to disagree about which repository this website is
 * built from, and this screen is where somebody checks that before pressing a button.
 * Anything it can't read is shown exactly as it came back, because a website really is built
 * from that, and a blank space would be a worse answer than an ugly one.
 */
function repoLabel(repository: string | undefined): string {
  if (!repository) return "your repository";
  const reading = readRepo(repository);
  return reading.kind === "ok" ? `${reading.owner}/${reading.repo}` : repository;
}
