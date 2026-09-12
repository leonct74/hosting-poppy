import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Progress, deploySteps, repoLabel, type ProgressApi } from "./Progress";
import type { DeployPhase, DeployStatus, Site } from "../types";

// Nothing here reaches the bridge or AWS: the status client is injected. What is under test is
// what this screen SAYS while it waits — the one thing a user judges a multi-minute wait by —
// and, since a website can now be built by AWS from a repository instead of uploaded from this
// computer, that every one of those things is true of the site actually on screen.

const SITE: Site = {
  id: "d1a2b3c4",
  name: "Portfolio",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: "2026-08-23T10:00:00.000Z",
  platform: "WEB",
  source: "upload",
};

const CONNECTED: Site = {
  id: "d9z8y7x6",
  name: "Docs",
  defaultUrl: "https://release.d9z8y7x6.amplifyapp.com",
  createdAt: "2026-08-24T09:00:00.000Z",
  platform: "WEB",
  source: "github",
  repository: "https://github.com/acme/docs",
  branch: "release",
};

/** Long enough that the retry the screen schedules never fires inside a test. */
const NO_RETRY_MS = 60_000;

const ALL_PHASES: DeployPhase[] = ["pending", "running", "succeeded", "failed", "cancelled"];

/** A backend that answers with one settled deploy, so the screen lands on it and stays there. */
function settled(deploy: DeployStatus): ProgressApi {
  return { deployStatus: vi.fn(async () => ({ deploy })) };
}

/** Every note the checklist shows, as one string — the claims, without the layout. */
function notes(phase: DeployPhase, opts: Parameters<typeof deploySteps>[1]): string {
  return deploySteps(phase, opts)
    .map((step) => `${step.label} — ${step.note}`)
    .join(" | ");
}

describe("a status check that couldn't be heard", () => {
  it("says so in one sentence, with the AWS text behind the disclosure", async () => {
    // The rejection is shaped the way the host bridge shapes one: the backend's JSON reply
    // flattened into `backend <status>: {…}`. Unwrapped by hand — as every mock in this repo
    // used to be — a screen that printed the raw envelope would still have passed.
    const client: ProgressApi = {
      deployStatus: vi.fn(async () => {
        throw new Error(
          'backend 500: {"message":"AWS is handling a lot of requests right now — wait a moment and try again.","detail":"ThrottlingException: Rate exceeded"}',
        );
      }),
    };
    render(<Progress site={SITE} jobId="job-7" api={client} onDone={() => {}} pollMs={NO_RETRY_MS} />);

    const banner = await screen.findByText(/AWS is handling a lot of requests/i);
    expect(banner.textContent).not.toMatch(/backend 500|[{}]/);
    expect(screen.getByText(/ThrottlingException: Rate exceeded/).closest("details")).not.toBeNull();
  });

  it("keeps the tone of a check, not of a failed deploy", async () => {
    const client: ProgressApi = {
      deployStatus: vi.fn(async () => {
        throw new Error("backend 502: <html>Bad Gateway</html>");
      }),
    };
    render(<Progress site={SITE} jobId="job-7" api={client} onDone={() => {}} pollMs={NO_RETRY_MS} />);

    // A check we couldn't hear is not a site that broke: the deploy is still running, the
    // checklist still says so, and the banner is amber rather than red.
    const banner = await screen.findByText(/We couldn't check on your site just now/i);
    expect(banner.className).toContain("warn");
    expect(screen.getByText(/Putting your site online/i)).toBeInTheDocument();
    // The gateway's HTML never reaches the sentence, but it is still readable.
    expect(banner.textContent).not.toMatch(/html|backend 502/);
    expect(screen.getByText(/Bad Gateway/).closest("details")).not.toBeNull();
  });
});

describe("which job the screen watches", () => {
  it("asks about the site's own branch — the wrong one reads as a build that never starts", async () => {
    // A job's address in AWS includes its branch. A connected site on "release", asked about
    // without one, is asked about on "main": AWS answers "no such job", which this screen
    // reads as "not started yet" and waits on for ever, while the build has long since ended.
    const client = settled({ jobId: "job-7", phase: "running" });
    render(<Progress site={CONNECTED} jobId="job-7" api={client} onDone={() => {}} pollMs={NO_RETRY_MS} />);

    await screen.findByText(/AWS is fetching your code/i);
    expect(client.deployStatus).toHaveBeenCalledWith(CONNECTED.id, "job-7", "release");
  });
});

describe("the checklist for a website AWS builds from a repository", () => {
  const opts = { source: "github" as const, repository: CONNECTED.repository, branch: CONNECTED.branch };

  it("never claims anything was sent from this computer — because nothing was", () => {
    // The bug this replaces: `uploadedBytes` is 0 on this path, and 0 fell through to the
    // bare "Sent from this computer." — the checklist asserting a handover that never
    // happened, in the exact case where it never happens.
    for (const phase of ALL_PHASES) {
      const shown = notes(phase, { ...opts, uploadedBytes: 0 });
      expect(shown).not.toMatch(/sent from this computer|your files handed over/i);
      expect(shown).toMatch(/nothing goes up from this computer/i);
    }
  });

  it("says where AWS reads the code, in the words GitHub uses", () => {
    expect(notes("running", opts)).toContain("acme/docs (release)");
    // No repository on the site (older payload, or AWS not saying) still reads as a sentence.
    expect(notes("running", { source: "github" })).toMatch(/reads your code from GitHub itself/i);
  });

  it("gives the build the time range a build really takes", () => {
    const running = notes("running", opts);
    expect(running).toMatch(/1 to 5 minutes/i);
    // The upload path's promise. A build that took four minutes against it reads as stuck.
    expect(running).not.toMatch(/under a minute/i);
  });

  it("explains a failure as a build, not as a zip, when AWS gives no reason of its own", () => {
    const failed = notes("failed", opts);
    expect(failed).toMatch(/didn't build/i);
    expect(failed).toMatch(/push again/i);
    expect(failed).not.toMatch(/zip|index\.html|files at the top level/i);
  });

  it("prefers the backend's sentence, which is written for this kind of site too", () => {
    const failed = notes("failed", { ...opts, reason: "AWS couldn't read your repository — check it still exists." });
    expect(failed).toContain("AWS couldn't read your repository");
    // And a stop is a stopped build, not a stopped upload.
    expect(notes("cancelled", opts)).toMatch(/stopped this build/i);
  });
});

describe("the checklist for a website whose files came from this computer", () => {
  it("still describes the handover, and the size that crossed", () => {
    const shown = notes("running", { source: "upload", uploadedBytes: 4 * 1024 * 1024 });
    expect(shown).toMatch(/your files handed over to AWS/i);
    expect(shown).toContain("about 4 MB, sent from this computer.");
  });

  it("keeps the quick time range — there is no build on this path", () => {
    expect(notes("running", { source: "upload" })).toMatch(/under a minute/i);
  });

  it("still gives zip advice for a failure, and treats a site made before repositories existed as one", () => {
    expect(notes("failed", { source: "upload" })).toMatch(/index\.html/);
    // `source` absent is the wire contract's "made before the GitHub path existed" — an
    // uploaded site, and it must not be read as a connected one.
    expect(notes("failed", {})).toMatch(/index\.html/);
  });
});

describe("the one action after a failure", () => {
  const failed: DeployStatus = { jobId: "job-7", phase: "failed" };

  it("offers the files again for an uploaded site", async () => {
    const onTryAgain = vi.fn();
    render(
      <Progress
        site={SITE}
        jobId="job-7"
        api={settled(failed)}
        onDone={() => {}}
        onTryAgain={onTryAgain}
        pollMs={NO_RETRY_MS}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /choose my files again/i }));
    expect(onTryAgain).toHaveBeenCalled();
  });

  it("never offers the files again for a connected site — there are none to choose", async () => {
    // The shell hands this screen `onTryAgain` for every site, so the screen itself has to
    // refuse it: an Amplify app is connected or manual permanently, and the upload route
    // rejects an upload to a connected app outright. Offering it is a dead end, not a detour.
    const onTryAgain = vi.fn();
    render(
      <Progress
        site={CONNECTED}
        jobId="job-7"
        api={settled(failed)}
        onDone={() => {}}
        onTryAgain={onTryAgain}
        pollMs={NO_RETRY_MS}
      />,
    );

    await screen.findByText(/didn't build/i);
    expect(screen.queryByRole("button", { name: /choose my files again/i })).toBeNull();
    expect(screen.getByText(/push a fix to release/i)).toBeInTheDocument();
  });

  it("sends a connected site's owner to the repository, which is where the fix goes", async () => {
    const openExternal = vi.fn(async () => {});
    render(
      <Progress
        site={CONNECTED}
        jobId="job-7"
        api={settled(failed)}
        onDone={() => {}}
        onTryAgain={() => {}}
        openExternal={openExternal}
        pollMs={NO_RETRY_MS}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /open my repository on GitHub/i }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/docs");
  });
});

describe("the build log", () => {
  it("says where it really is rather than pretending to show one", async () => {
    render(
      <Progress site={CONNECTED} jobId="job-7" api={settled({ jobId: "job-7", phase: "running" })} onDone={() => {}} pollMs={NO_RETRY_MS} />,
    );

    const summary = await screen.findByText(/where to see the build log/i);
    expect(summary.closest("details")).not.toBeNull();
    expect(screen.getByText(/AWS keeps the full log with the build/i).textContent).toMatch(/Resources tab/);
  });

  it("is not offered for an uploaded site, which is never built", async () => {
    render(
      <Progress site={SITE} jobId="job-7" api={settled({ jobId: "job-7", phase: "running" })} onDone={() => {}} pollMs={NO_RETRY_MS} />,
    );

    await screen.findByText(/putting your site online/i);
    expect(screen.queryByText(/build log/i)).toBeNull();
  });
});

describe("repoLabel", () => {
  it("keeps the part a person recognises", () => {
    expect(repoLabel("https://github.com/acme/docs")).toBe("acme/docs");
    expect(repoLabel("https://github.com/acme/docs.git")).toBe("acme/docs");
    expect(repoLabel("https://github.com/acme/docs/")).toBe("acme/docs");
    expect(repoLabel(undefined)).toBeUndefined();
    expect(repoLabel("   ")).toBeUndefined();
    // Anything we can't make sense of is shown as it stands, never turned into nothing.
    expect(repoLabel("acme/docs")).toBe("acme/docs");
  });
});
