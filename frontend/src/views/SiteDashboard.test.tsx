import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SiteDashboard, type SiteDashboardProps } from "./SiteDashboard";
import type { Site } from "../types";

// Nothing here reaches the bridge or AWS: every backend call this screen makes is injected.
//
// What is under test is the fork. A website is built from a repository or fed by hand, for as
// long as it exists (DESIGN §3.2), and this screen is where somebody publishes a new version
// of it — so offering the wrong one of those two actions is not a cosmetic slip: it sends a
// user off to pack a build folder for a website AWS will refuse it from, and the refusal
// arrives after the work.

const UPLOADED: Site = {
  id: "d1a2b3c4",
  name: "Portfolio",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: "2026-08-20T09:00:00.000Z",
  platform: "WEB",
  source: "upload",
  lastDeploy: { jobId: "7", phase: "succeeded", finishedAt: new Date().toISOString() },
};

const CONNECTED: Site = {
  ...UPLOADED,
  id: "d9z8y7x6",
  name: "Shop",
  source: "github",
  repository: "https://github.com/olly/shop",
  branch: "master",
};

function props(over: Partial<SiteDashboardProps> = {}): SiteDashboardProps {
  return {
    site: UPLOADED,
    onBack: () => {},
    onPutNewVersionOnline: () => {},
    onBuildStarted: () => {},
    onDomain: () => {},
    onRemoved: () => {},
    remove: async () => ({ ok: true }),
    build: async () => ({ jobId: "9" }),
    openExternal: async () => {},
    ...over,
  };
}

describe("a website AWS builds from a repository", () => {
  it("offers the build and never the upload", async () => {
    render(<SiteDashboard {...props({ site: CONNECTED })} />);

    expect(screen.getByRole("button", { name: /deploy the latest commit/i })).toBeInTheDocument();
    // The upload is refused by the backend for this website — after the user has chosen and
    // packed their files. It must not be on screen to choose in the first place.
    expect(screen.queryByRole("button", { name: /put a new version online/i })).not.toBeInTheDocument();
  });

  it("says which repository and branch it will build from", async () => {
    // "The latest commit" means nothing without them: this is the one line that says what is
    // about to go live, and it is above the button rather than after it.
    render(<SiteDashboard {...props({ site: CONNECTED })} />);

    expect(screen.getByText("olly/shop")).toBeInTheDocument();
    expect(screen.getByText("master")).toBeInTheDocument();
  });

  it("starts the build, showing it on the button, and hands the job up", async () => {
    let release: ((value: { jobId: string }) => void) | undefined;
    const build = vi.fn(
      () =>
        new Promise<{ jobId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const onBuildStarted = vi.fn();
    render(<SiteDashboard {...props({ site: CONNECTED, build, onBuildStarted })} />);

    await userEvent.click(screen.getByRole("button", { name: /deploy the latest commit/i }));

    // AGENTS.md §9: a control that sits there looking pressed-but-dead is the commonest
    // defect in a shipped poppy — and pressing twice here spends the user's build minutes
    // twice, on two builds of the same commit.
    const pending = await screen.findByRole("button", { name: /starting the build/i });
    expect(pending).toBeDisabled();
    expect(build).toHaveBeenCalledWith(CONNECTED.id);

    // Inside `act` because resolving this settles the button back out of its pending state.
    await act(async () => release?.({ jobId: "9" }));

    // The site travels with the id: following a job in AWS needs the branch it belongs to.
    expect(onBuildStarted).toHaveBeenCalledWith({ site: CONNECTED, jobId: "9" });
  });

  it("gives the button back after a refusal, with the backend's own sentence", async () => {
    // Shaped the way the host bridge shapes a rejection: our backend's JSON reply flattened
    // into `backend <status>: {…}`. A screen that printed it raw would still pass a test whose
    // mock threw a bare sentence.
    const build = vi.fn(async () => {
      throw new Error(
        'backend 400: {"message":"This website isn\'t connected to a repository, so there\'s no commit to build — upload your built site instead.","detail":"HttpError"}',
      );
    });
    render(<SiteDashboard {...props({ site: CONNECTED, build })} />);

    await userEvent.click(screen.getByRole("button", { name: /deploy the latest commit/i }));

    const banner = await screen.findByText(/no commit to build/i);
    expect(banner.textContent).not.toMatch(/backend 400|[{}]/);
    // Cleared in a finally: a failure must never leave the only way forward disabled.
    expect(screen.getByRole("button", { name: /deploy the latest commit/i })).toBeEnabled();
  });

  it("is offered even when nothing has ever been deployed", async () => {
    // The stranded case the backend names: the repository connected, its first build never
    // started, and this button is what the backend's own message tells the user to press.
    const { lastDeploy: _unused, ...neverBuilt } = CONNECTED;
    render(<SiteDashboard {...props({ site: neverBuilt })} />);

    expect(screen.getByRole("button", { name: /deploy the latest commit/i })).toBeEnabled();
  });

  it("waits for the build that is already running instead of stacking another on top", async () => {
    render(<SiteDashboard {...props({ site: { ...CONNECTED, lastDeploy: { jobId: "8", phase: "running" } } })} />);

    expect(screen.getByRole("button", { name: /deploy the latest commit/i })).toBeDisabled();
    // A disabled control with no explanation reads as broken, so it says why.
    expect(screen.getByText(/building right now/i)).toBeInTheDocument();
  });
});

describe("a website fed by hand", () => {
  it("keeps the upload and never offers a build", async () => {
    const onPutNewVersionOnline = vi.fn();
    render(<SiteDashboard {...props({ onPutNewVersionOnline })} />);

    await userEvent.click(screen.getByRole("button", { name: /put a new version online/i }));

    expect(onPutNewVersionOnline).toHaveBeenCalled();
    // There is no commit to build, and the backend refuses one.
    expect(screen.queryByRole("button", { name: /deploy the latest commit/i })).not.toBeInTheDocument();
  });

  it("treats a website made before repositories existed as one fed by hand", async () => {
    // `source` is absent on anything stored before the GitHub path shipped, and every one of
    // those was uploaded. Reading the absence as "connected" would take the upload away from
    // the only people who have ever used it.
    const { source: _unused, ...legacy } = UPLOADED;
    render(<SiteDashboard {...props({ site: legacy })} />);

    expect(screen.getByRole("button", { name: /put a new version online/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deploy the latest commit/i })).not.toBeInTheDocument();
  });
});
