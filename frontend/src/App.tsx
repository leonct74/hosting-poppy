// The shell — the one place every screen is wired up, and the only place that knows where
// the user is.
//
// Three things live here because everything else depends on them:
//
//  - **The AWS gate.** Nothing in this poppy can happen until AgentsPoppy has approved us and
//    started minting scoped credentials for our backend. "Not granted yet" is a normal state
//    to explain in a sentence, never an error to throw at somebody (UX.md ground rule 5) —
//    explained INSIDE the websites tab, so the tab bar survives it (see `websites()`).
//  - **Navigation.** Tabs across the top; inside the websites tab a small state machine — the
//    list, the setup flow, the wait, the offer of a domain, the everyday dashboard — because
//    this poppy hosts many sites and the wizard is a path through those screens rather than a
//    screen of its own.
//  - **The background-work promise (AGENTS.md §5).** AWS carries on whether this UI is open,
//    hidden behind another tab, or shut. So the websites area stays MOUNTED when the user
//    looks at something else, and every arrival re-derives where things actually got to by
//    asking AWS — never from anything we remembered.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, uploadSite, type UploadProgress } from "./api";
import { host, type AccessState } from "./host";
import { readFailure, type Failure } from "./lib/errors";
import type { DeployPhase, DeployStatus, DomainStatus, LedgerEntry, Meta, ResourceRow, Site } from "./types";
import { DomainStep } from "./views/DomainStep";
import { FeedbackTab } from "./views/FeedbackTab";
import { FailureBanner } from "./views/FailureBanner";
import { AddressLink, Home } from "./views/Home";
import { NewSite, type NewSiteApi } from "./views/NewSite";
import { Progress, isFinished, type ProgressApi } from "./views/Progress";
import { Resources } from "./views/Resources";
import { SiteDashboard } from "./views/SiteDashboard";

// Served from frontend/public → the dist root; the same file extension.json declares as our
// icon. It is worn top-left beside the name because that is the convention every poppy
// follows: the icon the user tapped in AgentsPoppy is the icon that greets them (AGENTS.md §9).
const ICON = "./hostingpoppy-icon.png";

const TABS = [
  { key: "sites", label: "Your websites" },
  // The ONE place real AWS names belong (UX.md S9). Named plainly on the tab so a user
  // looking for "what did this thing make in my account?" recognises it instantly.
  { key: "resources", label: "AWS Resources" },
  // Mandatory in every poppy and always LAST (AGENTS.md §9a) — rate it, ask for a feature,
  // report a bug, support the developer. Never gated, never hidden: it is the one tab that
  // must work even when everything else in this poppy is refusing to.
  { key: "feedback", label: "Feedback" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** The error dictionary's line for a bridge that isn't answering (UX.md). */
const CANT_REACH =
  "Can't reach your AgentsPoppy connection — close HostingPoppy and open it again from AgentsPoppy.";

/**
 * Everything the shell asks of the backend, in one object so a test can replace all of it.
 * The screens each take their own slice of this; nothing below ever imports the bridge itself.
 */
export interface ShellApi {
  meta(): Promise<Meta>;
  listSites(): Promise<{ sites: Site[] }>;
  createSite(name: string): Promise<{ site: Site }>;
  getSite(id: string): Promise<{ site: Site }>;
  removeSite(id: string): Promise<unknown>;
  /** Builds the newest commit of a website connected to a repository. */
  build(id: string): Promise<{ jobId: string }>;
  /** `branch` names which version of the site the job belongs to — see `api.deployStatus`. */
  deployStatus(id: string, jobId: string, branch?: string): Promise<{ deploy: DeployStatus }>;
  getDomain(id: string): Promise<{ domain: DomainStatus | null }>;
  attachDomain(id: string, address: string, alsoWww?: boolean): Promise<{ domain: DomainStatus }>;
  removeDomain(id: string): Promise<unknown>;
  resources(): Promise<{ resources: ResourceRow[]; ledger: LedgerEntry[] }>;
  uploadSite(
    siteId: string,
    bytes: Uint8Array,
    fileName: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ jobId: string }>;
}

/** The slice of the host bridge the shell uses. Same reason: tests inject, never postMessage. */
export interface ShellHost {
  ensureAccess(): Promise<AccessState>;
  getConnection(): Promise<{ status: string }>;
  openExternal(url: string): void | Promise<void>;
}

/** The real client: every backend call, plus the chunked upload helper that lives beside it. */
const DEFAULT_API: ShellApi = { ...api, uploadSite };
const DEFAULT_HOST: ShellHost = host;

export interface AppProps {
  api?: ShellApi;
  host?: ShellHost;
}

/**
 * Where the user is inside the websites tab.
 *
 * `firstTime` on a deploy is the difference between finishing a wizard and re-uploading a
 * site that already exists: only the first one ends with the offer of a domain.
 */
type Screen =
  | { at: "list" }
  | { at: "new" }
  | { at: "again"; site: Site }
  | { at: "deploying"; site: Site; jobId: string; uploadedBytes?: number; firstTime: boolean }
  | { at: "domain"; site: Site }
  | { at: "site"; site: Site };

export function App({ api: client = DEFAULT_API, host: bridge = DEFAULT_HOST }: AppProps = {}) {
  const [phase, setPhase] = useState<"checking" | "gate" | "stuck" | "ready">("checking");
  /** What the host answered last time we asked. Null until it has answered once. */
  const [access, setAccess] = useState<AccessState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [tab, setTab] = useState<TabKey>("sites");
  /** Mount the Feedback tab on its first visit and keep it — see the panels below. */
  const [feedbackOpened, setFeedbackOpened] = useState(false);

  const [screen, setScreen] = useState<Screen>({ at: "list" });
  /** Bumped whenever something has changed underneath the list, so it re-reads AWS. */
  const [listKey, setListKey] = useState(0);

  /**
   * The phase of the deploy on screen, learned from the progress screen's OWN polling (see
   * `progressApi`). It decides where "Done" lands, and it is a ref rather than state because
   * nothing renders it — turning every poll into a re-render of the whole shell would be a
   * cost paid for nothing.
   */
  const deployPhase = useRef<DeployPhase | null>(null);

  const goToList = useCallback(() => {
    setListKey((key) => key + 1);
    setScreen({ at: "list" });
  }, []);

  /** Re-read one website from AWS and hand it back down, if it is still the one on screen. */
  const refreshSite = useCallback(
    async (id: string) => {
      const { site } = await client.getSite(id);
      setScreen((current) => (current.at === "site" && current.site.id === id ? { at: "site", site } : current));
    },
    [client],
  );

  /**
   * Pick up work that was already running when this window opened (AGENTS.md §5).
   *
   * It costs one extra read at startup — the list screen makes its own — and that is the
   * price of never dropping somebody who started a deploy, closed the poppy and came back
   * onto a screen that has forgotten all about it.
   */
  const resume = useCallback(async () => {
    try {
      const { sites } = await client.listSites();
      const busy = sites.find((site) => site.lastDeploy && !isFinished(site.lastDeploy.phase));
      if (!busy?.lastDeploy) return;
      deployPhase.current = busy.lastDeploy.phase;
      setScreen({ at: "deploying", site: busy, jobId: busy.lastDeploy.jobId, firstTime: false });
    } catch {
      // Not worth a screen of its own: if AWS can't be read, the list says so in its own
      // words a moment later, and saying it twice in two places reads as two faults.
    }
  }, [client]);

  const connect = useCallback(async () => {
    setProblem(null);
    setConnecting(true);
    let granted = false;
    try {
      const state = await bridge.ensureAccess();
      setAccess(state);
      if (state !== "granted") {
        setPhase("gate");
        return;
      }
      granted = true;
      const info = await client.meta();
      setMeta(info);
      // No point probing for work in a region that cannot host anything — every call would
      // fail, and the screen below explains the region instead.
      if (info.regionSupported) await resume();
      setPhase("ready");
    } catch (e) {
      setProblem(readFailure(e, CANT_REACH));
      // Which failure this was matters: approval is the user's to give, but a backend that
      // won't answer is ours to explain — and offering "Connect my AWS account" for it would
      // send them to approve something they already approved.
      setPhase(granted ? "stuck" : "gate");
    } finally {
      setConnecting(false);
    }
  }, [bridge, client, resume]);

  /**
   * On open: ask what the connection already is, and only reach for `ensureAccess` when it
   * is live. `ensureAccess` raises an approval prompt in AgentsPoppy when it isn't — and a
   * prompt that arrives before the user has read a word about why is how a stranger's app
   * gets refused. So an unapproved connection lands on the explaining screen, and the button
   * there raises the prompt once they know what they are approving.
   */
  const askedOnce = useRef(false);
  useEffect(() => {
    if (askedOnce.current) return;
    // React's StrictMode mounts every component twice in development. Without this the poppy
    // would ask for access twice on one open, which the user sees.
    askedOnce.current = true;
    void (async () => {
      try {
        const connection = await bridge.getConnection();
        setConnectionStatus(connection.status);
        if (connection.status === "active") {
          await connect();
          return;
        }
      } catch (e) {
        setProblem(readFailure(e, CANT_REACH));
      }
      setPhase("gate");
    })();
  }, [bridge, connect]);

  // The dashboard is opened from a list that was read a moment (or an hour) ago, so ask AWS
  // for that website again as it opens — the address, the last deploy and the domain must be
  // what is true now, not what was true when the list loaded.
  const openSiteId = screen.at === "site" ? screen.site.id : null;
  useEffect(() => {
    if (!openSiteId) return;
    void refreshSite(openSiteId).catch(() => {
      // The dashboard keeps showing what the list already knew, which is never wildly wrong.
      // A banner for a single failed re-read would be noise the user cannot act on.
    });
  }, [openSiteId, refreshSite]);

  /**
   * The progress screen's backend, wrapped so the shell learns the deploy's phase from the
   * polling that screen is already doing. A second poller of our own would double this
   * poppy's calls into the user's account to answer a question that is already on its way.
   *
   * Memoised because the progress screen keys its polling loop on this object: a new one
   * every render would tear the loop down and start it again, forever.
   */
  const progressApi = useMemo<ProgressApi>(
    () => ({
      deployStatus: async (siteId, jobId, branch) => {
        // Passed straight through: the progress screen holds the site, so it is the one that
        // knows which branch this job is on, and a wrapper that dropped it here would put
        // every connected site whose branch isn't "main" back on an endless wait.
        const result = await client.deployStatus(siteId, jobId, branch);
        deployPhase.current = result.deploy.phase;
        return result;
      },
    }),
    [client],
  );

  /** The list screen keys its read on this object too — same reason, same fix. */
  const homeApi = useMemo(() => ({ listSites: client.listSites }), [client]);
  const newSiteApi = useMemo<NewSiteApi>(
    () => ({ createSite: client.createSite, uploadSite: client.uploadSite }),
    [client],
  );

  const startDeploy = (started: { site: Site; jobId: string; uploadedBytes: number }, firstTime: boolean) => {
    deployPhase.current = null;
    setScreen({ at: "deploying", ...started, firstTime });
  };

  /**
   * Where "Done" — and "Back to my websites" — lands.
   *
   * The progress screen offers one way out at every phase, so the destination has to come
   * from what AWS actually did rather than from which button was pressed: a wizard that
   * finished ends on the offer of a domain (UX.md S7), a re-upload ends on the website it
   * updated, and anything still running or failed goes back to the list the button names.
   */
  const leaveProgress = (site: Site) => {
    const live = deployPhase.current === "succeeded";
    // Every finished deploy lands on the website itself — the one screen that shows the
    // address big and carries every control for it, "Add a domain" included.
    //
    // It used to send a first-time site straight into the domain screen instead (UX.md S7,
    // "a finished wizard ends on the offer of a domain"). That made a button labelled Done
    // open a NEW task, and it meant the dashboard — the answer to "where is my website?" —
    // was a screen the happy path never visited. The offer survives as a button on the
    // dashboard, which is an offer you can decline rather than a room you are put in.
    if (live) setScreen({ at: "site", site });
    else goToList();
  };

  const openTab = (key: TabKey) => {
    if (key === "feedback") setFeedbackOpened(true);
    setTab(key);
  };

  /**
   * What the websites tab shows — including every "we can't get started yet" state.
   *
   * Those states are deliberately not returned from the shell itself. Returned above the tab
   * bar they took the Feedback tab off the screen with them, so a user waiting on approval —
   * or on a helper that isn't answering — had no way to rate this poppy or report the very
   * thing blocking them. That tab is a catalogue requirement for exactly those moments
   * (AGENTS.md §9a), so nothing in here may ever replace the frame at the end of this file.
   */
  function websites(): ReactNode {
    if (phase === "checking") {
      return (
        <div className="card row">
          <span className="spinner" /> <span className="muted">Checking your AWS connection…</span>
        </div>
      );
    }

    if (phase === "gate") {
      return (
        <PermissionNeeded
          access={access}
          connectionStatus={connectionStatus}
          problem={problem}
          connecting={connecting}
          onConnect={() => void connect()}
        />
      );
    }

    if (phase === "stuck") {
      return (
        <HelperNotAnswering problem={problem} connecting={connecting} onConnect={() => void connect()} />
      );
    }

    // A connection pointed at a region AWS cannot host in is a fact about the connection, not
    // a fault: say so once, here, rather than letting every screen fail its own way.
    if (meta && !meta.regionSupported) return <RegionNotSupported meta={meta} />;

    switch (screen.at) {
      case "list":
        return (
          <Home
            api={homeApi}
            refreshKey={listKey}
            openExternal={bridge.openExternal}
            onAddSite={() => setScreen({ at: "new" })}
            onOpenSite={(site) => setScreen({ at: "site", site })}
          />
        );

      case "new":
        return (
          <NewSite
            api={newSiteApi}
            onCancel={goToList}
            onDeployStarted={(started) => startDeploy(started, true)}
          />
        );

      case "again": {
        const site = screen.site;
        return (
          <NewSite
            // The upload screen, told which website it is a new version of: it then asks for
            // the files and nothing else, and says it is replacing what is live. It used to
            // be handed a blank form and a banner apologising for it — asking for a name it
            // discarded, while promising to make something new.
            updating={site}
            api={{
              // Never reached while `updating` is set, and deliberately not `createSite`:
              // the belt to that braces, because the failure it guards against — a second
              // press leaving a duplicate website in somebody's account — is invisible until
              // they go looking at their bill.
              createSite: async () => ({ site }),
              uploadSite: client.uploadSite,
            }}
            onCancel={() => setScreen({ at: "site", site })}
            onDeployStarted={(started) => startDeploy(started, false)}
          />
        );
      }

      case "deploying":
        return (
          <Progress
            site={screen.site}
            jobId={screen.jobId}
            uploadedBytes={screen.uploadedBytes}
            api={progressApi}
            openExternal={bridge.openExternal}
            onDone={() => leaveProgress(screen.site)}
            // "Choose my files again" goes back to the upload screen for the website that
            // already exists — the failure was the files, and remaking the site would only
            // leave the first one lying about.
            //
            // Offered ONLY to a website fed by hand. A website AWS builds from a repository
            // has no files to choose: its next version comes from a push, or from the build
            // button on its dashboard, and an upload to it is refused outright. Sending
            // somebody off to pack a build folder after a failed build would waste their
            // time and end in a second refusal.
            onTryAgain={
              screen.site.source === "github" ? undefined : () => setScreen({ at: "again", site: screen.site })
            }
          />
        );

      case "domain": {
        const site = screen.site;
        return (
          <DomainStep
            site={site}
            load={() => client.getDomain(site.id).then((r) => r.domain)}
            attach={(address, alsoWww) => client.attachDomain(site.id, address, alsoWww).then((r) => r.domain)}
            detach={() => client.removeDomain(site.id).then(() => undefined)}
            openExternal={bridge.openExternal}
            onBack={() => setScreen({ at: "site", site })}
          />
        );
      }

      case "site": {
        const site = screen.site;
        return (
          <SiteDashboard
            site={site}
            refresh={() => refreshSite(site.id)}
            remove={client.removeSite}
            openExternal={bridge.openExternal}
            // No `usage`: this poppy asks for permission to look after websites and nothing
            // else, so it cannot read what visitors actually downloaded. The dashboard's own
            // fallback quotes AWS's rates and says so — better than a total we invented.
            //
            // `goToList` rather than a plain screen change, so the list the user lands back on
            // is read from AWS again: a deploy they started from here may have finished since.
            onBack={goToList}
            onPutNewVersionOnline={() => setScreen({ at: "again", site })}
            build={client.build}
            // Nothing crossed the bridge — AWS reads the code from GitHub itself, so the wait
            // has no upload to describe. `firstTime` is false: this website already exists, so
            // finishing lands back on it rather than on the offer of a domain.
            onBuildStarted={({ site: building, jobId }) =>
              startDeploy({ site: building, jobId, uploadedBytes: 0 }, false)
            }
            onDomain={() => setScreen({ at: "domain", site })}
            onRemoved={goToList}
          />
        );
      }
    }
  }

  return (
    <Frame>
      <div className="tabs" role="tablist" aria-label="HostingPoppy sections" style={{ marginBottom: 14 }}>
        {TABS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={tab === entry.key}
            className={`tab${tab === entry.key ? " active" : ""}`}
            onClick={() => openTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* Hidden, never unmounted. A deploy is minutes long and the user WILL look at
          something else while it runs; unmounting this would stop its polling and lose the
          upload they had picked, so they would come back to a screen that had forgotten
          everything (AGENTS.md §5). */}
      <div role="tabpanel" aria-label="Your websites" hidden={tab !== "sites"}>
        {websites()}
      </div>

      {/* The opposite choice, for the opposite reason: this screen's whole promise is that it
          shows what your account really holds, so it is mounted fresh on every visit and
          re-reads AWS rather than showing what was true when the poppy opened. */}
      {tab === "resources" && (
        <div role="tabpanel" aria-label="AWS Resources">
          {/* Reachable now that the tab bar outlives the gate — and a read of somebody's
              account before they have connected one can only fail, so say the true and
              reassuring thing instead of showing them AWS refusing us. */}
          {phase === "ready" ? (
            <Resources
              load={client.resources}
              openExternal={bridge.openExternal}
              meta={meta ?? undefined}
              // Reads the website fresh rather than hunting a cached list: this tab is read
              // from AWS, so the row may name a site the list on the other tab has not seen.
              onOpenSite={(siteId) => {
                void client
                  .getSite(siteId)
                  .then(({ site }) => {
                    setTab("sites");
                    setScreen({ at: "site", site });
                  })
                  // Nothing to say here that the websites tab won't say better: send them
                  // there rather than leaving a button that visibly does nothing.
                  .catch(() => setTab("sites"));
              }}
            />
          ) : (
            <div className="card">
              <p style={{ margin: 0 }}>
                <strong>Nothing yet.</strong> HostingPoppy can only look inside your AWS account once you
                have connected it, and it hasn&rsquo;t created anything there. Start on the{" "}
                <em>Your websites</em> tab.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Mounted on its first visit and kept, so a half-written message survives somebody
          nipping back to check the name of the website they are complaining about. */}
      {feedbackOpened && (
        <div role="tabpanel" aria-label="Feedback" hidden={tab !== "feedback"}>
          <FeedbackTab />
        </div>
      )}

      <div className="muted" style={{ marginTop: 18, fontSize: 11.5 }}>
        HostingPoppy {meta?.version ?? ""} runs in your own AWS account and is provided &ldquo;as is&rdquo;
        under the{" "}
        <AddressLink url="https://agentspoppy.com/terms" openExternal={bridge.openExternal}>
          AgentsPoppy Terms
        </AddressLink>
        . The websites it creates are yours — and so is the bill AWS sends for them.
      </div>
    </Frame>
  );
}

/** The icon and the name, top-left on every screen, so the user always knows where they are. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <div className="app-header">
        <img src={ICON} alt="" />
        <h1>HostingPoppy</h1>
      </div>
      <p className="app-sub">
        Your websites, in your own AWS account — you own them, and one click removes everything.
      </p>
      {children}
    </div>
  );
}

/**
 * The AWS gate: AgentsPoppy hasn't approved us yet, or the connection behind us is paused,
 * revoked or refused. "Not granted yet" is a state to explain in a sentence, never an error
 * to throw at somebody (UX.md ground rule 5) — and the button below is what raises the
 * approval prompt, so the user reads why before deciding.
 */
function PermissionNeeded({
  access,
  connectionStatus,
  problem,
  connecting,
  onConnect,
}: {
  access: AccessState | null;
  connectionStatus: string | null;
  problem: Failure | null;
  connecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>HostingPoppy needs your permission first</h2>
      <p style={{ margin: 0 }}>
        Your website will live in <strong>your own AWS account</strong> — you own it, and AWS bills you
        directly at its own prices. To put it there, HostingPoppy needs your permission in AgentsPoppy.
      </p>
      <p className="muted" style={{ margin: 0 }}>
        It can only ever touch the websites it creates itself: nothing else in your account is visible to
        it, nothing is created until you ask for it, and you can remove everything with one click.
      </p>

      {connectionStatus === "paused" && (
        <div className="banner warn">
          Your AWS connection is paused in AgentsPoppy — turn it back on there, then try again.
        </div>
      )}
      {connectionStatus === "revoked" && (
        <div className="banner warn">
          Your AWS connection was removed in AgentsPoppy — connect it again there, then try again.
        </div>
      )}
      {access === "denied" && (
        <div className="banner err">
          Permission wasn't granted. You can approve HostingPoppy in AgentsPoppy, then try again here.
        </div>
      )}
      {access === "pending" && (
        <div className="banner info">
          Waiting for this to be approved in AgentsPoppy. Approve it there, then try again.
        </div>
      )}
      {problem && <FailureBanner error={problem} />}

      <div>
        <button
          className="btn btn-primary btn-lg"
          onClick={onConnect}
          disabled={connecting}
          aria-busy={connecting || undefined}
        >
          {connecting && <span className="spinner" aria-hidden="true" />}
          {connecting ? "Waiting for approval…" : "Connect my AWS account"}
        </button>
      </div>
    </div>
  );
}

/**
 * Approved, but our own helper isn't answering. Access was granted, so this is ours to explain
 * and never the user's fault — and never a reason to offer them an approval button again, which
 * would send them to approve something they already approved.
 */
function HelperNotAnswering({
  problem,
  connecting,
  onConnect,
}: {
  problem: Failure | null;
  connecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="card stack">
      <FailureBanner error={problem ?? { message: CANT_REACH }} />
      <p className="muted" style={{ margin: 0 }}>
        Nothing has been created or changed in your AWS account. Anything already online stays online.
      </p>
      <div>
        <button
          className="btn btn-primary"
          onClick={onConnect}
          disabled={connecting}
          aria-busy={connecting || undefined}
        >
          {connecting && <span className="spinner" aria-hidden="true" />}
          {connecting ? "Trying again…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

/**
 * The connection's region cannot host a website (UX.md error dictionary, "Region capability
 * missing"). The full list comes from the backend rather than a copy kept here, so the day
 * AWS switches a region on, this screen is right without a release.
 */
function RegionNotSupported({ meta }: { meta: Meta }) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>AWS can&rsquo;t host websites in {meta.region} yet</h2>
      <p style={{ margin: 0 }}>
        Your AgentsPoppy connection works in <span className="chip">{meta.region}</span>, and AWS doesn&rsquo;t
        offer website hosting there. Nothing is wrong with your account.
      </p>
      <p className="muted" style={{ margin: 0 }}>
        Connect HostingPoppy to a region that can host, and everything here will work. Nothing has been
        created, so there is nothing to remove first.
      </p>
      <details className="details">
        <summary>Regions that can host a website</summary>
        <div className="row" style={{ marginTop: 8 }}>
          {meta.supportedRegions.map((region) => (
            <span className="chip" key={region}>
              {region}
            </span>
          ))}
        </div>
      </details>
    </div>
  );
}
