// S6 — the wait, and the moment it ends.
//
// Three rules shape this screen.
//
// First, every multi-minute AWS operation gets a staged checklist with plain labels and an
// honest time range, never a bare spinner (UX.md ground rule 4): a user who cannot tell
// "working" from "stuck" reloads, presses again, or gives up. Second, the user is never
// trapped here — AWS carries on whether this screen is open or not, so "Back to my websites"
// is available from the first second (AGENTS.md §5).
//
// Third — and this is the one the checklist got wrong for as long as repositories have been
// connectable — every line of it has to be true of the website actually on screen. There are
// two kinds, permanently: one where the user handed us a built site and we sent it up, and
// one where AWS fetches the code from a repository and builds it in their account. The
// checklist below said "Your files handed over to AWS — Sent from this computer" for both,
// which for a connected site is not a wording slip but the screen telling somebody their
// files went somewhere they never went; and it promised the seconds an unpacked upload takes
// while a build was running, which is minutes (UX.md S6: 1–5). So the two paths get their
// own steps, their own honest time range, and their own way out of a failure.

import { useEffect, useState } from "react";
import { api } from "../api";
import { readFailure, type Failure } from "../lib/errors";
import { describeBytes } from "../lib/format";
import type { DeployPhase, DeployStatus, Site, SiteSource } from "../types";
import { FailureBanner } from "./FailureBanner";
import { AddressLink } from "./Home";

/** The slice of the backend client this screen uses. Injected so tests never touch the bridge. */
export interface ProgressApi {
  /**
   * `branch` is which version of the site the job belongs to, and it travels on every call
   * because a job's address in AWS includes it: a website built from a repository whose
   * branch is `master`, asked about without one, is asked about on "main" instead. AWS
   * answers "no such job" — which also means "just started" — so the screen waits for ever
   * on a build that finished (see `api.deployStatus`).
   */
  deployStatus(siteId: string, jobId: string, branch?: string): Promise<{ deploy: DeployStatus }>;
}

export interface ProgressProps {
  site: Site;
  jobId: string;
  /** What was uploaded, for the handover step. Zero — or absent — on a connected site. */
  uploadedBytes?: number;
  api?: ProgressApi;
  openExternal?: (url: string) => void | Promise<void>;
  /** Back to the list of websites. Always offered, at every phase. */
  onDone: () => void;
  /**
   * Offered after a failure: back to picking files for this website. Only ever shown for an
   * uploaded site — a connected one has nothing on this computer to choose again, and AWS
   * refuses an upload to it outright.
   */
  onTryAgain?: () => void;
  /** How often to ask AWS. Injectable so tests don't wait four seconds a poll. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 4000;

const CHECK_FAILED = "We couldn't check on your site just now — still trying.";

export type StepState = "waiting" | "now" | "done" | "failed";

export interface Step {
  label: string;
  note: string;
  state: StepState;
}

export interface DeployStepsOptions {
  /** Where this website's code comes from. Absent means the upload path (types.ts). */
  source?: SiteSource;
  /** What crossed the bridge from this computer, when anything did. */
  uploadedBytes?: number;
  /** The backend's own sentence for a failure — it knows which kind of site this is too. */
  reason?: string;
  /** The connected repository, for the step that says where AWS reads the code. */
  repository?: string;
  /** The branch AWS builds and serves. */
  branch?: string;
}

/** True once AWS has stopped working on this deploy, one way or the other. */
export function isFinished(phase: DeployPhase): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled";
}

/**
 * The checklist, derived from the one thing AWS tells us: the job's phase, and which kind of
 * website it belongs to. Pure, so the whole vocabulary of this screen can be read — and
 * reviewed for jargon, and for claims it cannot back up — in one place.
 */
export function deploySteps(phase: DeployPhase, opts: DeployStepsOptions = {}): Step[] {
  return (opts.source ?? "upload") === "github" ? builtSteps(phase, opts) : uploadedSteps(phase, opts);
}

/**
 * The last step, whose state is the whole point of this screen. Shared by both paths so they
 * can differ in words without drifting apart in behaviour.
 */
function lastStep(
  phase: DeployPhase,
  words: { label: string; working: string; stopped: string; failed: string },
  reason?: string,
): Step {
  switch (phase) {
    case "succeeded":
      return { label: words.label, note: "Done — and secured with https.", state: "done" };
    case "failed":
    case "cancelled":
      // The reason is the backend's own sentence when it has one, and it is already written
      // for this kind of site (amplify.ts::deployReason). It lives HERE and nowhere else on
      // the screen — the same words in a banner underneath read as two separate things having
      // gone wrong. The words below are only for a failure AWS gave no explanation for.
      return {
        label: words.label,
        note: reason ?? (phase === "cancelled" ? words.stopped : words.failed),
        state: "failed",
      };
    default:
      return { label: words.label, note: words.working, state: "now" };
  }
}

/** A site whose built files came from this computer. */
function uploadedSteps(phase: DeployPhase, opts: DeployStepsOptions): Step[] {
  const sent =
    opts.uploadedBytes !== undefined && opts.uploadedBytes > 0
      ? `${describeBytes(opts.uploadedBytes)}, sent from this computer.`
      : "Sent from this computer.";

  return [
    { label: "Your website's own space in AWS", note: "Made just now, in your account.", state: "done" },
    { label: "Your files handed over to AWS", note: sent, state: "done" },
    lastStep(
      phase,
      {
        label: "Putting your site online",
        // No build step, so this really is quick — unpacking and publishing what was sent.
        working: "Usually under a minute — sometimes two or three.",
        stopped: "AWS stopped this one before it finished.",
        failed: "It didn't go live. Check your built files have index.html at the top level, then try again.",
      },
      opts.reason,
    ),
  ];
}

/** A site AWS builds itself, from a repository. Nothing here left this computer. */
function builtSteps(phase: DeployPhase, opts: DeployStepsOptions): Step[] {
  const where = repoLabel(opts.repository);
  const branch = (opts.branch ?? "").trim();
  const reads = where ? `${where}${branch ? ` (${branch})` : ""}` : "GitHub";

  return [
    { label: "Your website's own space in AWS", note: "Made just now, in your account.", state: "done" },
    {
      // True from the moment this screen opens: the website exists because the repository was
      // connected to it, and AWS keeps reading it from there on every push afterwards.
      label: "Connected to your repository",
      note: `AWS reads your code from ${reads} itself — nothing goes up from this computer.`,
      state: "done",
    },
    lastStep(
      phase,
      {
        label: "Building your site and putting it online",
        // The honest range for a build (UX.md S6), not the one an upload takes: AWS installs
        // what the project needs and runs its build before anything can go live.
        working: "AWS is fetching your code and building it — usually 1 to 5 minutes.",
        stopped: "AWS stopped this build before it finished.",
        failed: "Your site didn't build. The last line of the build log usually says why — fix it on GitHub and push again.",
      },
      opts.reason,
    ),
  ];
}

/**
 * "owner/repo", the way GitHub itself writes it, out of the address we stored.
 *
 * The full `https://github.com/owner/repo` is right in a link and wrong in a sentence, where
 * it wraps across two lines and buries the only part the user recognises.
 */
export function repoLabel(repository: string | undefined): string | undefined {
  const trimmed = (repository ?? "").trim();
  if (!trimmed) return undefined;
  const path = trimmed
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return path || trimmed;
}

export function Progress({
  site,
  jobId,
  uploadedBytes,
  api: client = api,
  openExternal,
  onDone,
  onTryAgain,
  pollMs = DEFAULT_POLL_MS,
}: ProgressProps) {
  const [deploy, setDeploy] = useState<DeployStatus>({ jobId, phase: "pending" });
  const [pollError, setPollError] = useState<Failure | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    async function ask() {
      try {
        const result = await client.deployStatus(site.id, jobId, site.branch);
        if (!alive) return;
        setDeploy(result.deploy);
        setPollError(null);
        if (!isFinished(result.deploy.phase)) timer = window.setTimeout(() => void ask(), pollMs);
      } catch (e) {
        if (!alive) return;
        // A failed check is not a failed deploy. AWS is still working; we simply couldn't
        // hear it this time, so we say so quietly and keep asking rather than declaring a
        // failure that hasn't happened.
        setPollError(readFailure(e, CHECK_FAILED));
        timer = window.setTimeout(() => void ask(), pollMs);
      }
    }

    void ask();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // Deliberately not keyed on the phase: one loop for the life of this screen, which stops
    // itself the moment AWS reports a finished job.
    // The branch is in the key for the same reason site.id is: it is part of WHICH job we are
    // asking about, so a screen handed a different one has to ask about the new one.
  }, [client, site.id, site.branch, jobId, pollMs]);

  async function checkNow() {
    setChecking(true);
    try {
      const result = await client.deployStatus(site.id, jobId, site.branch);
      setDeploy(result.deploy);
      setPollError(null);
    } catch (e) {
      setPollError(readFailure(e, CHECK_FAILED));
    } finally {
      setChecking(false);
    }
  }

  // An Amplify app is connected to a repository or it is manual, permanently — so this one
  // answer decides every word and every button below, and it comes from what AWS said about
  // the app rather than from how this screen happened to be reached.
  const fromRepo = (site.source ?? "upload") === "github";
  const branch = (site.branch ?? "").trim();
  const steps = deploySteps(deploy.phase, {
    source: site.source,
    uploadedBytes,
    reason: deploy.reason,
    repository: site.repository,
    branch: site.branch,
  });
  const live = deploy.phase === "succeeded";
  const address = site.domain?.url || site.defaultUrl;

  return (
    <div>
      <h2>{live ? "Your site is live" : `Putting ${site.name} online`}</h2>

      {live ? (
        <div className="card" style={{ borderColor: "var(--poppy-accent)" }}>
          <div className="banner ok" style={{ marginBottom: 12 }}>
            It's online now, on a secure address of its own.
          </div>
          {address ? (
            <>
              <AddressLink url={address} openExternal={openExternal} size="big" />
              <p className="hint" style={{ marginTop: 8 }}>
                Anyone can open this from anywhere. Put your own domain in front of it whenever
                you like — this address keeps working either way.
              </p>
            </>
          ) : (
            <p className="muted">
              AWS hasn't reported the address yet. It'll be on your websites list in a moment.
            </p>
          )}
          {/* The payoff of connecting a repository, said once, at the moment it becomes true. */}
          {fromRepo && (
            <p className="hint" style={{ marginTop: 8 }}>
              From now on, every push {branch ? `to ${branch}` : "to that branch"} updates it —
              you don't have to come back here.
            </p>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <ol className="steps">
            {steps.map((step) => (
              <li className={`step ${step.state}`} key={step.label}>
                <span className="step-mark" aria-hidden="true">
                  {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : ""}
                </span>
                <div className="step-body">
                  <div className="step-label">{step.label}</div>
                  <div className="step-note break" role={step.state === "failed" ? "alert" : undefined}>
                    {step.note}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          {/* UX.md S6 asks for the build log behind a disclosure. We don't have it: AWS keeps
              the log with the build, and the status this screen polls carries a phase and a
              sentence — no log lines. So this says where it really is rather than showing an
              empty panel that reads as broken. AWS's own words are allowed here; UX.md bans
              them on primary screens, not behind a disclosure. */}
          {fromRepo && (
            <details className="details" style={{ marginTop: 12 }}>
              <summary>Where to see the build log</summary>
              <p className="small muted" style={{ marginTop: 6 }}>
                AWS keeps the full log with the build itself. The Resources tab has a link
                straight to this website in the AWS console — open it and pick{" "}
                {branch ? `"${branch}"` : "the branch it builds"}, where every build is listed
                with its log.
              </p>
            </details>
          )}
        </div>
      )}

      {(deploy.phase === "failed" || deploy.phase === "cancelled") && (
        <div className="card">
          {/* What went wrong is already on the failed step above; this is only what to do
              next, which UX.md asks to be exactly one action — and which action that is
              depends on where the code comes from. "Choose my files again" is not a
              slightly-wrong offer for a connected site: there are no files here to choose,
              and the upload route refuses one outright. */}
          {fromRepo ? (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>
                {/* A stopped build isn't a broken one — telling that user to "push a fix"
                    invents a problem they don't have. Either way the mechanism is the same:
                    the repository is what starts a build, so that is what this points at. */}
                {deploy.phase === "cancelled"
                  ? `Pushing ${branch ? `to ${branch}` : "to that branch"} starts a new build by itself — there's nothing to re-send from here.`
                  : `Push a fix ${branch ? `to ${branch}` : "to that branch"} and AWS builds it again by itself — there's nothing to re-send from here.`}
              </p>
              {site.repository && (
                <div style={{ marginTop: 8 }}>
                  <AddressLink url={site.repository} openExternal={openExternal}>
                    Open my repository on GitHub
                  </AddressLink>
                </div>
              )}
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn" onClick={onDone}>
                  Back to my websites
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              {onTryAgain && (
                <button className="btn btn-primary" onClick={onTryAgain}>
                  Choose my files again
                </button>
              )}
              <button className="btn" onClick={onDone}>
                Back to my websites
              </button>
            </div>
          )}
        </div>
      )}

      {!isFinished(deploy.phase) && (
        <div className="card card-2">
          {/* Warn, not err, and it says "still trying": a check we couldn't hear is not a
              deploy that failed, and AWS is carrying on either way. */}
          {pollError && <FailureBanner error={pollError} tone="warn" style={{ marginBottom: 10 }} />}
          <p className="small muted">
            You can leave this screen — AWS carries on without the app, and your websites list
            will show it as soon as it's live.
          </p>
          <div className="row">
            <button
              className="btn btn-sm"
              onClick={() => void checkNow()}
              disabled={checking}
              aria-busy={checking || undefined}
            >
              {checking && <span className="spinner" aria-hidden="true" />}
              {checking ? "Checking…" : "Check now"}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onDone}>
              Back to my websites
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
