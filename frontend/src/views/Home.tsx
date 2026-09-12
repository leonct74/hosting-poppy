// S1 — the first screen. Empty at first, a list of websites forever after.
//
// The empty state carries the whole pitch in three lines, and one of those lines is the
// promise that all of this can be undone with one click. That is not marketing: fear of
// leaving a mess in an AWS account they don't fully understand is the biggest reason this
// user never tries anything, so the exit is visible from the entrance (UX.md ground rule 6).

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { host } from "../host";
import { readFailure, type Failure } from "../lib/errors";
import { formatRelativeTime } from "../lib/format";
import type { Site } from "../types";
import { FailureBanner } from "./FailureBanner";

/** The slice of the backend client this screen uses. Injected so tests never touch the bridge. */
export interface HomeApi {
  listSites(): Promise<{ sites: Site[] }>;
}

export interface HomeProps {
  /** "Set up my website" / "Add another website" — hands over to the NewSite screen. */
  onAddSite: () => void;
  /** Opening one of the listed websites. Omit while there is nowhere yet to open it. */
  onOpenSite?: (site: Site) => void;
  api?: HomeApi;
  openExternal?: (url: string) => void | Promise<void>;
  /**
   * Change this number to make the screen read the list from AWS again — after a deploy,
   * or after a removal. The list is deliberately never cached across that boundary: a site
   * that has just gone live and still shows "Not online yet" reads as a broken app.
   */
  refreshKey?: number;
  /** How often to re-read while a deploy is running. Injectable so tests don't wait ten seconds. */
  pollMs?: number;
}

/**
 * A website's address, as a link that opens in the user's real browser.
 *
 * It has to be a button: inside the host's sandboxed frame `window.open` and a plain
 * `<a target="_blank">` are silent no-ops, so a link that skips the bridge looks dead. And
 * because the bridge can refuse, the failure has somewhere to go — we show the address
 * itself, selectable, rather than leaving the user clicking a link that does nothing.
 */
export function AddressLink({
  url,
  openExternal = host.openExternal,
  size = "normal",
  children,
}: {
  url: string;
  openExternal?: (url: string) => void | Promise<void>;
  size?: "normal" | "big";
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open() {
    setBusy(true);
    setFailed(false);
    try {
      await openExternal(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="break"
        title={`Open ${url}`}
        aria-busy={busy || undefined}
        onClick={() => void open()}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
          font: "inherit",
          fontSize: size === "big" ? 17 : "inherit",
          fontWeight: size === "big" ? 600 : "inherit",
          color: "var(--poppy-accent)",
          textDecoration: "underline",
          textUnderlineOffset: 3,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {children ?? url.replace(/^https?:\/\//, "")}
      </button>
      {/* A div, not a p: this renders inside whatever the caller wrapped the address in, and
          a <p> nested in a <p> is invalid HTML the browser silently un-nests. */}
      {failed && (
        <div className="hint break">
          We couldn't hand that to your browser — copy the address in yourself:{" "}
          <span className="chip" style={{ userSelect: "all" }}>
            {url}
          </span>
        </div>
      )}
    </>
  );
}

/** What the list says about a website, in the words the user thinks in. */
export function siteStatus(site: Site): { label: string; tone: "" | "ok" | "warn" | "bad" | "run"; note: string } {
  const deploy = site.lastDeploy;
  if (!deploy) {
    return { label: "Nothing online yet", tone: "", note: "Its space exists, but no files have been sent up." };
  }
  switch (deploy.phase) {
    case "succeeded":
      return { label: "Live", tone: "ok", note: `Last updated ${formatRelativeTime(deploy.finishedAt ?? deploy.startedAt)}` };
    case "failed":
      return { label: "Needs attention", tone: "bad", note: deploy.reason ?? "The last upload didn't go live." };
    case "cancelled":
      return { label: "Stopped", tone: "warn", note: "The last upload was stopped before it finished." };
    default:
      return { label: "Going live", tone: "run", note: "AWS is putting your files online right now." };
  }
}

/**
 * AWS is still working on this website, so what its row says will change without us.
 *
 * The same two phases the progress screen calls unfinished. It is repeated rather than
 * imported because that screen imports the address link from here, and a cycle between two
 * views is a hazard for the sake of one comparison. A site with no deploy at all is NOT
 * settling — nothing has been sent up, so nothing is going to change on its own.
 */
export function isSettling(site: Site): boolean {
  const phase = site.lastDeploy?.phase;
  return phase === "pending" || phase === "running";
}

const LOAD_FAILED = "We couldn't read your websites from AWS just now — try again in a moment.";

/**
 * How often the list asks AWS again while a deploy is still running.
 *
 * A deploy is minutes long, so this only has to be quick enough that "Going live" becomes
 * "Live" while somebody is still looking at the list — and slow enough that a list left open
 * all afternoon is a handful of calls into their account rather than a flood.
 */
const DEPLOY_POLL_MS = 10_000;

export function Home({
  onAddSite,
  onOpenSite,
  api: client = api,
  openExternal,
  refreshKey = 0,
  pollMs = DEPLOY_POLL_MS,
}: HomeProps) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [explaining, setExplaining] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    client.listSites().then(
      (result) => {
        if (alive) setSites(result.sites);
      },
      (e: unknown) => {
        // The list stays as it was rather than emptying: showing the "no websites yet" hero
        // to someone who has five would be a lie told by a network blip.
        if (alive) setError(readFailure(e, LOAD_FAILED));
      },
    );
    return () => {
      alive = false;
    };
  }, [client, refreshKey]);

  // One read at a time. A slow answer must not stack up behind the timer below and turn a
  // background refresh into a queue of calls against somebody's AWS account.
  const reading = useRef(false);

  /**
   * Read the list again without saying so — no skeleton, no spinner, no error banner.
   *
   * This read is one the user never asked for, so it may only ever improve what is on screen:
   * on success the rows change status by themselves, and on failure the list they are looking
   * at is left exactly as it was. Replacing a good list with an error screen because one
   * background call blipped would be a fault invented by the app.
   */
  const refreshQuietly = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await client.listSites();
      setSites(result.sites);
      setError(null);
    } catch {
      /* silence is the point — see above */
    } finally {
      reading.current = false;
    }
  }, [client]);

  /**
   * Keep re-reading while any website is mid-deploy.
   *
   * The progress screen tells the user in as many words that they can leave and this list
   * will show the site as soon as it is live (AGENTS.md §5) — so this is where that promise
   * is kept or broken. Keyed on the boolean rather than on the list itself: a refresh that
   * finds the deploy still running leaves it true, so the timer keeps its rhythm instead of
   * being torn down and restarted on every answer. The moment nothing is in flight the
   * effect tears the timer down and the polling simply stops.
   */
  const anyDeploying = sites?.some(isSettling) ?? false;
  useEffect(() => {
    if (!anyDeploying) return;
    const timer = window.setInterval(() => void refreshQuietly(), pollMs);
    return () => window.clearInterval(timer);
  }, [anyDeploying, pollMs, refreshQuietly]);

  /**
   * Coming back to the window is its own reason to re-read.
   *
   * Somebody who started a deploy and went to lunch has been away far longer than any
   * interval, and a poppy that was in the background may not have been given its timers at
   * all. This runs whatever the list last looked like, because a deploy can also have been
   * started somewhere else entirely.
   */
  useEffect(() => {
    const onFocus = () => void refreshQuietly();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshQuietly();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshQuietly]);

  // "Try again" reads AWS itself rather than nudging the effect, so the button can stay
  // disabled for exactly as long as its own request is in flight. A spinner driven by a
  // re-render somewhere else flashes for a frame and tells the user nothing.
  async function tryAgain() {
    setRetrying(true);
    try {
      const result = await client.listSites();
      setSites(result.sites);
      setError(null);
    } catch (e) {
      setError(readFailure(e, LOAD_FAILED));
    } finally {
      setRetrying(false);
    }
  }

  if (error) {
    return (
      <div className="stack">
        <FailureBanner error={error} />
        <button className="btn" onClick={() => void tryAgain()} disabled={retrying} aria-busy={retrying || undefined}>
          {retrying && <span className="spinner" aria-hidden="true" />}
          {retrying ? "Trying again…" : "Try again"}
        </button>
      </div>
    );
  }

  if (sites === null) {
    return (
      <div className="card" aria-busy="true">
        <div className="skeleton" style={{ height: 15, width: "45%", marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 12, width: "70%" }} />
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div>
        <div className="card">
          <h2>Put your website online — in your own AWS account.</h2>
          <p className="muted">
            Pay AWS at cost. No middleman, no lock-in. Remove everything with one click.
          </p>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary btn-lg" onClick={onAddSite}>
              Set up my website
            </button>
            <button className="btn btn-ghost" onClick={() => setExplaining((open) => !open)}>
              {explaining ? "Hide" : "How it works"}
            </button>
          </div>
        </div>

        {explaining && <HowItWorks />}
      </div>
    );
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Your websites</h2>
        <button className="btn btn-primary" onClick={onAddSite}>
          Add another website
        </button>
      </div>

      {sites.map((site) => {
        const status = siteStatus(site);
        return (
          <div className="card" key={site.id}>
            <div className="spread">
              <h3 style={{ margin: 0 }} className="break">
                {site.name}
              </h3>
              <span className={`badge ${status.tone}`}>
                <span className="dot" aria-hidden="true" />
                {status.label}
              </span>
            </div>
            {site.defaultUrl ? (
              /* Big, like the dashboard's. This is the thing somebody opens the poppy to
                 click, and at "normal" it read as one more line of small print in a card
                 full of them. */
              <div style={{ marginTop: 8 }}>
                <AddressLink url={site.domain?.url || site.defaultUrl} openExternal={openExternal} size="big" />
              </div>
            ) : (
              <p className="hint">AWS hasn't given this one an address yet.</p>
            )}
            <p className="small muted" style={{ marginTop: 6 }}>
              {status.note}
            </p>
            {onOpenSite && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => onOpenSite(site)}>
                  Manage this website
                </button>
              </div>
            )}
          </div>
        );
      })}

      <p className="small muted-2" style={{ marginTop: 16 }}>
        Remove any website — or everything HostingPoppy ever made — with one click, any time.
      </p>
    </div>
  );
}

/** The three-panel explainer behind "How it works": your code → your AWS → your domain. */
function HowItWorks() {
  return (
    <div className="stack">
      <div className="card card-2">
        <h3>1. Your code</h3>
        <p className="small muted">
          You build your site the way you already do, and hand over the folder it produced. Your
          browser packs it up — nothing else on your computer is read.
        </p>
      </div>
      <div className="card card-2">
        <h3>2. Your AWS account</h3>
        <p className="small muted">
          The files go straight into your own AWS account and are served worldwide over a secure
          (https) address AWS gives them. HostingPoppy keeps no copy of anything.
        </p>
      </div>
      <div className="card card-2">
        <h3>3. Your domain</h3>
        <p className="small muted">
          Point your own domain at it whenever you like — your site is already live on the AWS
          address, and stays live the whole time the domain is being set up.
        </p>
      </div>
    </div>
  );
}
