import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type ShellApi, type ShellHost } from "./App";
import type { Meta, Site } from "./types";

// Nothing here reaches the host bridge or AWS: the shell takes its whole backend and its
// slice of the bridge as props, so what is under test is the wiring — which screen the user
// lands on, what a failure says, and what survives them looking somewhere else.

const META: Meta = {
  accountId: "123456789012",
  region: "eu-west-1",
  version: "0.1.0",
  regionSupported: true,
  supportedRegions: ["eu-west-1", "us-east-1"],
};

const LIVE: Site = {
  id: "d1a2b3c4",
  name: "Portfolio",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: "2026-08-20T09:00:00.000Z",
  platform: "WEB",
  lastDeploy: { jobId: "7", phase: "succeeded", finishedAt: new Date().toISOString() },
};

const DEPLOYING: Site = { ...LIVE, lastDeploy: { jobId: "8", phase: "running" } };

/**
 * A website AWS builds from a repository — and deliberately one whose branch is NOT `main`,
 * because "main" is what every call falls back to when nobody passes a branch, so a site on
 * it cannot tell a working shell from a broken one.
 */
const CONNECTED: Site = {
  ...LIVE,
  id: "d9z8y7x6",
  name: "Shop",
  source: "github",
  repository: "https://github.com/olly/shop",
  branch: "master",
};

function shellApi(over: Partial<ShellApi> = {}): ShellApi {
  return {
    meta: async () => META,
    listSites: async () => ({ sites: [] }),
    createSite: async (name) => ({ site: { ...LIVE, name } }),
    getSite: async () => ({ site: LIVE }),
    removeSite: async () => ({ ok: true }),
    build: async () => ({ jobId: "9" }),
    deployStatus: async (_id, jobId) => ({ deploy: { jobId, phase: "running" as const } }),
    getDomain: async () => ({ domain: null }),
    attachDomain: async (_id, address) => ({ domain: { domain: address, phase: "verifying" as const, records: [] } }),
    removeDomain: async () => ({ ok: true }),
    resources: async () => ({ resources: [], ledger: [] }),
    uploadSite: async () => ({ jobId: "8" }),
    ...over,
  };
}

function shellHost(over: Partial<ShellHost> = {}): ShellHost {
  return {
    ensureAccess: async () => "granted",
    getConnection: async () => ({ status: "active" }),
    openExternal: async () => {},
    ...over,
  };
}

describe("the AWS gate", () => {
  it("explains what it wants before asking the user to approve anything", async () => {
    // The approval prompt is raised by ensureAccess. Raising it the instant the poppy opens
    // means the user decides before reading a word about why — so an unapproved connection
    // must land here, and the prompt must wait for the button.
    const ensureAccess = vi.fn(async () => "granted" as const);
    render(<App api={shellApi()} host={shellHost({ ensureAccess, getConnection: async () => ({ status: "pending" }) })} />);

    expect(await screen.findByText(/HostingPoppy needs your permission first/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is created until you ask for it/i)).toBeInTheDocument();
    expect(ensureAccess).not.toHaveBeenCalled();
  });

  it("reacts on the first press and can't be fired twice while it waits", async () => {
    let approve: ((state: "granted") => void) | undefined;
    const ensureAccess = vi.fn(
      () =>
        new Promise<"granted">((resolve) => {
          approve = resolve;
        }),
    );
    render(<App api={shellApi()} host={shellHost({ ensureAccess, getConnection: async () => ({ status: "pending" }) })} />);

    await userEvent.click(await screen.findByRole("button", { name: /connect my aws account/i }));

    // AGENTS.md §9: a control that sits there looking pressed-but-dead is the single most
    // common defect in shipped poppies.
    const waiting = await screen.findByRole("button", { name: /waiting for approval/i });
    expect(waiting).toBeDisabled();

    approve?.("granted");
    expect(await screen.findByRole("button", { name: /set up my website/i })).toBeInTheDocument();
    expect(ensureAccess).toHaveBeenCalledTimes(1);
  });

  it("says so calmly when permission is refused, and leaves the way back open", async () => {
    render(
      <App
        api={shellApi()}
        host={shellHost({ ensureAccess: async () => "denied", getConnection: async () => ({ status: "pending" }) })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /connect my aws account/i }));

    expect(await screen.findByText(/Permission wasn't granted/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect my aws account/i })).toBeEnabled();
  });

  it("names a paused connection instead of failing at it", async () => {
    render(<App api={shellApi()} host={shellHost({ getConnection: async () => ({ status: "paused" }) })} />);

    expect(await screen.findByText(/paused in AgentsPoppy/i)).toBeInTheDocument();
  });

  it("goes straight in when the connection is already live", async () => {
    const ensureAccess = vi.fn(async () => "granted" as const);
    render(<App api={shellApi()} host={shellHost({ ensureAccess })} />);

    expect(await screen.findByRole("button", { name: /set up my website/i })).toBeInTheDocument();
    expect(ensureAccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/needs your permission/i)).not.toBeInTheDocument();
  });
});

describe("when something below the shell doesn't answer", () => {
  it("keeps the sentence the backend wrote, and doesn't send an approved user back to approve again", async () => {
    const api = shellApi({
      meta: async () => {
        throw new Error("Can't reach your AgentsPoppy connection — close HostingPoppy and open it again.");
      },
    });
    render(<App api={api} host={shellHost()} />);

    expect(await screen.findByText(/Can't reach your AgentsPoppy connection/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect my aws account/i })).not.toBeInTheDocument();
    // The reassurance that matters to somebody who fears a mess in their AWS account.
    expect(screen.getByText(/Nothing has been created or changed/i)).toBeInTheDocument();
  });

  it("recovers when the helper answers on the retry", async () => {
    let attempt = 0;
    const api = shellApi({
      meta: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("The helper didn't answer — try again in a moment.");
        return META;
      },
    });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /set up my website/i })).toBeInTheDocument();
  });
});

describe("a region that can't host websites", () => {
  it("explains the region rather than letting every screen fail its own way", async () => {
    const api = shellApi({
      meta: async () => ({ ...META, region: "eu-south-2", regionSupported: false }),
    });
    render(<App api={api} host={shellHost()} />);

    expect(await screen.findByText(/can’t host websites in eu-south-2/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up my website/i })).not.toBeInTheDocument();
    // Whatever else is refused, the way to complain is never one of them (AGENTS.md §9a).
    expect(screen.getByRole("tab", { name: "Feedback" })).toBeInTheDocument();
  });

  it("lists the regions that do work, from the backend rather than a copy of its own", async () => {
    const api = shellApi({
      meta: async () => ({ ...META, regionSupported: false, supportedRegions: ["eu-west-1", "ap-southeast-1"] }),
    });
    render(<App api={api} host={shellHost()} />);

    await screen.findByText(/can’t host websites/i);
    expect(screen.getByText("ap-southeast-1")).toBeInTheDocument();
  });
});

describe("work that was already running", () => {
  it("puts the user back on live progress when the poppy is reopened mid-deploy", async () => {
    // AGENTS.md §5: come back to a deploy you started and you land on its live status — never
    // on a list that has quietly forgotten it.
    const deployStatus = vi.fn(async (_id: string, jobId: string, _branch?: string) => ({
      deploy: { jobId, phase: "running" as const },
    }));
    const api = shellApi({ listSites: async () => ({ sites: [DEPLOYING] }), deployStatus });
    render(<App api={api} host={shellHost()} />);

    expect(await screen.findByText(/Putting Portfolio online/i)).toBeInTheDocument();
    // No branch: a website fed by hand has one live version and the backend already knows
    // what it is called. Only a website built from a repository names its own — see below.
    await waitFor(() => expect(deployStatus).toHaveBeenCalledWith(DEPLOYING.id, "8", undefined));
  });

  it("survives the user looking at another tab while it runs", async () => {
    const api = shellApi({ listSites: async () => ({ sites: [DEPLOYING] }) });
    render(<App api={api} host={shellHost()} />);
    const heading = await screen.findByText(/Putting Portfolio online/i);

    await userEvent.click(screen.getByRole("tab", { name: "AWS Resources" }));

    // Still mounted, merely out of sight — which is what keeps its polling alive. Unmounting
    // it would stop the poll and lose the deploy the moment somebody looked elsewhere.
    expect(heading).toBeInTheDocument();
    expect(heading).not.toBeVisible();
    expect(await screen.findByText(/nothing hidden/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Your websites" }));
    expect(heading).toBeVisible();
  });
});

describe("the tabs", () => {
  it("puts Feedback last, as every poppy must", async () => {
    render(<App api={shellApi()} host={shellHost()} />);
    await screen.findByRole("button", { name: /set up my website/i });

    const labels = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(labels).toEqual(["Your websites", "AWS Resources", "Feedback"]);
  });

  // AGENTS.md §9a: the Feedback tab is a catalogue requirement and must survive a poppy that
  // cannot do its job — the states below are exactly when somebody wants to complain, so a
  // screen that renders INSTEAD of the tab bar takes the way to complain down with it.
  describe("the Feedback tab survives everything else refusing to work", () => {
    // The element inside the tab asks the AgentsPoppy feedback API for its star rating the
    // moment it mounts. Nothing in a unit test may reach the network, and it handles a refusal
    // by itself, so a rejecting fetch is the honest stand-in.
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("no network in tests");
        }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("is reachable while the AWS approval is still pending", async () => {
      render(<App api={shellApi()} host={shellHost({ getConnection: async () => ({ status: "pending" }) })} />);
      const gate = await screen.findByText(/HostingPoppy needs your permission first/i);

      await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));

      expect(screen.getByRole("heading", { name: "Feedback" })).toBeVisible();
      // The gate is merely out of sight, and the way back to it is the tab that is still there.
      expect(gate).not.toBeVisible();
      await userEvent.click(screen.getByRole("tab", { name: "Your websites" }));
      expect(gate).toBeVisible();
    });

    it("is reachable when the helper behind everything doesn't answer", async () => {
      const api = shellApi({
        meta: async () => {
          throw new Error("The helper didn't answer — try again in a moment.");
        },
      });
      render(<App api={api} host={shellHost()} />);
      await screen.findByRole("button", { name: /try again/i });

      await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));

      expect(screen.getByRole("heading", { name: "Feedback" })).toBeVisible();
    });
  });
});

describe("moving between the websites screens", () => {
  it("opens a website, then its domain step, then comes back to it", async () => {
    const api = shellApi({ listSites: async () => ({ sites: [LIVE] }) });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));
    expect(await screen.findByText(/Your site's address/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add a domain/i }));
    expect(await screen.findByRole("heading", { name: "Your domain" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /back to portfolio/i }));
    expect(await screen.findByText(/Your site's address/i)).toBeInTheDocument();
  });

  it("offers the way back out of a website's dashboard", async () => {
    // Without a control of its own the dashboard is a dead end: the tab holding the list is
    // already the selected one, so nothing on screen invites the user back to it.
    const api = shellApi({ listSites: async () => ({ sites: [LIVE] }) });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));
    await screen.findByText(/Your site's address/i);

    await userEvent.click(screen.getByRole("button", { name: /all websites/i }));

    expect(await screen.findByRole("heading", { name: "Your websites" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add another website/i })).toBeInTheDocument();
  });

  it("re-reads the website from AWS as its dashboard opens", async () => {
    // The list it was opened from could be an hour old; the address, the last deploy and the
    // domain on this screen have to be what is true now.
    const getSite = vi.fn(async () => ({ site: LIVE }));
    const api = shellApi({ listSites: async () => ({ sites: [LIVE] }), getSite });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));
    await waitFor(() => expect(getSite).toHaveBeenCalledWith(LIVE.id));
  });

  it("goes back to a freshly read list when a website is removed", async () => {
    const sites = [LIVE];
    const removeSite = vi.fn(async () => {
      sites.pop();
      return { ok: true };
    });
    const api = shellApi({ listSites: async () => ({ sites: [...sites] }), removeSite });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove this website…" }));

    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByRole("textbox"), LIVE.name);
    await userEvent.click(dialog.getByRole("button", { name: "Remove this website" }));

    expect(removeSite).toHaveBeenCalledWith(LIVE.id);
    // The empty state, not a stale row: the list is read again rather than remembered.
    expect(await screen.findByRole("button", { name: /set up my website/i })).toBeInTheDocument();
  });

  it("re-uploads to the website that already exists instead of making a second one", async () => {
    const createSite = vi.fn(async (name: string) => ({ site: { ...LIVE, name } }));
    const api = shellApi({ listSites: async () => ({ sites: [LIVE] }), createSite });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));
    await userEvent.click(screen.getByRole("button", { name: /put a new version online/i }));

    expect(await screen.findByText(/A new version of/i)).toBeInTheDocument();
    expect(screen.getByText(/no second website is created/i)).toBeInTheDocument();
    expect(createSite).not.toHaveBeenCalled();
  });
});

describe("a website built from a repository", () => {
  it("asks AWS about the branch the build is actually on", async () => {
    // The defect this guards: a job's address in AWS includes its branch, and without one the
    // backend falls back to "main". A site whose branch is `master` then polls a job that does
    // not exist — AWS says "no such thing", which also means "just started", so the screen
    // waits for ever on a build that succeeded minutes ago.
    const deployStatus = vi.fn(async (_id: string, jobId: string, _branch?: string) => ({
      deploy: { jobId, phase: "running" as const },
    }));
    const building: Site = { ...CONNECTED, lastDeploy: { jobId: "8", phase: "running" } };
    const api = shellApi({ listSites: async () => ({ sites: [building] }), deployStatus });
    render(<App api={api} host={shellHost()} />);

    await screen.findByText(/Putting Shop online/i);
    await waitFor(() => expect(deployStatus).toHaveBeenCalledWith(building.id, "8", "master"));
  });

  it("builds the latest commit from its dashboard and follows the job", async () => {
    const build = vi.fn(async () => ({ jobId: "9" }));
    const deployStatus = vi.fn(async (_id: string, jobId: string, _branch?: string) => ({
      deploy: { jobId, phase: "running" as const },
    }));
    const api = shellApi({ listSites: async () => ({ sites: [CONNECTED] }), getSite: async () => ({ site: CONNECTED }), build, deployStatus });
    render(<App api={api} host={shellHost()} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));
    await userEvent.click(await screen.findByRole("button", { name: /deploy the latest commit/i }));

    expect(build).toHaveBeenCalledWith(CONNECTED.id);
    expect(await screen.findByText(/Putting Shop online/i)).toBeInTheDocument();
    // Started from the dashboard, followed on the right branch — the same trap as above, one
    // screen further on.
    await waitFor(() => expect(deployStatus).toHaveBeenCalledWith(CONNECTED.id, "9", "master"));
  });

  it("never offers to choose files again when its build fails", async () => {
    // There are no files to choose: AWS reads this website's code from GitHub, and an upload
    // to it is refused. The way on is a push, or the build button on its dashboard.
    const failed: Site = { ...CONNECTED, lastDeploy: { jobId: "8", phase: "running" } };
    const api = shellApi({
      listSites: async () => ({ sites: [failed] }),
      deployStatus: async (_id, jobId) => ({ deploy: { jobId, phase: "failed" as const, reason: "The build stopped at npm run build." } }),
    });
    render(<App api={api} host={shellHost()} />);

    expect(await screen.findByText(/The build stopped at npm run build/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose my files again/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to my websites/i })).toBeInTheDocument();
  });

  it("still offers it to a website fed by hand", async () => {
    const api = shellApi({
      listSites: async () => ({ sites: [DEPLOYING] }),
      deployStatus: async (_id, jobId) => ({ deploy: { jobId, phase: "failed" as const } }),
    });
    render(<App api={api} host={shellHost()} />);

    expect(await screen.findByRole("button", { name: /choose my files again/i })).toBeInTheDocument();
  });
});

describe("what a failure looks like on the gate screens", () => {
  // Every mock above throws a bare sentence, already unwrapped. The host bridge never does:
  // it flattens the backend's reply into `backend <status>: {"message":…,"detail":…}`, so a
  // screen that shows the thrown message verbatim shows the user the envelope. That is what
  // these two check — the banner holds only the sentence, and the AWS text is one click away.
  const THROTTLED =
    'backend 500: {"message":"AWS is handling a lot of requests right now — wait a moment and try again.","detail":"ThrottlingException: Rate exceeded"}';

  it("unwraps it on the 'helper isn't answering' screen", async () => {
    const api = shellApi({
      meta: async () => {
        throw new Error(THROTTLED);
      },
    });
    render(<App api={api} host={shellHost()} />);

    const banner = await screen.findByText(/AWS is handling a lot of requests/i);
    expect(banner.textContent).not.toMatch(/backend 500|[{}]/);
    expect(screen.getByText(/ThrottlingException: Rate exceeded/).closest("details")).not.toBeNull();
    // Still the approved-but-stuck screen, so the way forward is a retry, not a re-approval.
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("unwraps it on the permission screen too", async () => {
    // Nothing was approved yet, so this failure lands beside the explanation of what we want.
    const bridge = shellHost({
      getConnection: async () => {
        throw new Error(THROTTLED);
      },
    });
    render(<App api={shellApi()} host={bridge} />);

    const banner = await screen.findByText(/AWS is handling a lot of requests/i);
    expect(banner.textContent).not.toMatch(/backend 500|[{}]/);
    expect(screen.getByText(/ThrottlingException: Rate exceeded/).closest("details")).not.toBeNull();
    expect(screen.getByRole("button", { name: /connect my aws account/i })).toBeEnabled();
  });
});
