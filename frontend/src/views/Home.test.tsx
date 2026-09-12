import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Home, type HomeApi } from "./Home";
import type { Site } from "../types";

// The backend is never reached: every test injects its own client, so what is under test is
// the screen's behaviour — what it shows, what it disables, what it calls — and not AWS.

const LIVE: Site = {
  id: "d1a2b3c4",
  name: "Portfolio",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: "2026-08-20T09:00:00.000Z",
  platform: "WEB",
  lastDeploy: { jobId: "3", phase: "succeeded", finishedAt: new Date().toISOString() },
};

function clientReturning(...sites: Site[]): HomeApi {
  return { listSites: async () => ({ sites }) };
}

describe("the first screen, with nothing hosted yet", () => {
  it("pitches the thing and promises the exit in the same breath", async () => {
    render(<Home api={clientReturning()} onAddSite={() => {}} />);

    expect(await screen.findByText(/Put your website online — in your own AWS account/i)).toBeInTheDocument();
    // UX.md ground rule 6: the exit is visible from the entrance. Fear of leaving a mess in
    // an AWS account is the biggest reason this user never presses anything.
    expect(screen.getByText(/Remove everything with one click/i)).toBeInTheDocument();
  });

  it("hands over to the setup screen when the one button is pressed", async () => {
    const onAddSite = vi.fn();
    render(<Home api={clientReturning()} onAddSite={onAddSite} />);

    await userEvent.click(await screen.findByRole("button", { name: /set up my website/i }));
    expect(onAddSite).toHaveBeenCalledTimes(1);
  });

  it("explains how it works without making the user leave the screen", async () => {
    render(<Home api={clientReturning()} onAddSite={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /how it works/i }));
    expect(screen.getByText(/Your AWS account/i)).toBeInTheDocument();
    expect(screen.getByText(/HostingPoppy keeps no copy/i)).toBeInTheDocument();
  });
});

describe("the first screen, once a website exists", () => {
  it("lists the site with what a person wants to know about it", async () => {
    render(<Home api={clientReturning(LIVE)} onAddSite={() => {}} />);

    expect(await screen.findByText("Portfolio")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add another website/i })).toBeInTheDocument();
  });

  it("opens the address through the host bridge, never through window.open", async () => {
    // Inside the host's sandboxed frame window.open is a silent no-op, so a link that used
    // it would look dead in the one place a user is most excited to click.
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const openExternal = vi.fn(async () => {});
    render(<Home api={clientReturning(LIVE)} onAddSite={() => {}} openExternal={openExternal} />);

    await userEvent.click(await screen.findByRole("button", { name: /main\.d1a2b3c4/i }));

    expect(openExternal).toHaveBeenCalledWith(LIVE.defaultUrl);
    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it("offers the address to copy by hand when the host refuses to open it", async () => {
    const openExternal = vi.fn(async () => {
      throw new Error("no opener");
    });
    render(<Home api={clientReturning(LIVE)} onAddSite={() => {}} openExternal={openExternal} />);

    await userEvent.click(await screen.findByRole("button", { name: /main\.d1a2b3c4/i }));

    expect(await screen.findByText(/copy the address in yourself/i)).toBeInTheDocument();
    expect(screen.getByText(LIVE.defaultUrl)).toBeInTheDocument();
  });
});

describe("a deploy the user walked away from", () => {
  const DEPLOYING: Site = { ...LIVE, lastDeploy: { jobId: "9", phase: "running" } };

  it("re-reads the list by itself until the deploy lands, then stops", async () => {
    // The progress screen promises the user they can leave and this list will show the site
    // as soon as it's live (AGENTS.md §5). This is where that promise is kept: without the
    // re-read the row says "Going live" until the whole poppy is reopened.
    let answers = 0;
    const listSites = vi.fn(async () => {
      answers += 1;
      return { sites: [answers < 3 ? DEPLOYING : LIVE] };
    });
    render(<Home api={{ listSites }} onAddSite={() => {}} pollMs={10} />);

    expect(await screen.findByText("Going live")).toBeInTheDocument();
    expect(await screen.findByText("Live")).toBeInTheDocument();

    // And now nothing is in flight, so the polling must stop rather than keep calling AWS
    // for the rest of the afternoon.
    const settled = listSites.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(listSites.mock.calls.length).toBe(settled);
  });

  it("never polls a list where nothing is happening", async () => {
    const listSites = vi.fn(async () => ({ sites: [LIVE] }));
    render(<Home api={{ listSites }} onAddSite={() => {}} pollMs={10} />);

    expect(await screen.findByText("Live")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(listSites).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the window comes back, however long the user was away", async () => {
    // An interval only helps somebody who stayed. The poll is set far out of reach here, so
    // only the return to the window can explain the row changing.
    const listSites = vi
      .fn<() => Promise<{ sites: Site[] }>>()
      .mockResolvedValueOnce({ sites: [DEPLOYING] })
      .mockResolvedValue({ sites: [LIVE] });
    render(<Home api={{ listSites }} onAddSite={() => {}} pollMs={600_000} />);

    expect(await screen.findByText("Going live")).toBeInTheDocument();
    fireEvent.focus(window);

    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  it("keeps the list on screen when a background re-read fails", async () => {
    // A read the user never asked for may only improve the screen: swapping a good list for
    // an error banner would be a fault the app invented out of one network blip.
    let answers = 0;
    const listSites = vi.fn(async () => {
      answers += 1;
      if (answers === 1) return { sites: [DEPLOYING] };
      throw new Error("Couldn't reach AWS just now — check your internet connection and try again.");
    });
    render(<Home api={{ listSites }} onAddSite={() => {}} pollMs={10} />);

    await screen.findByText("Going live");
    await waitFor(() => expect(listSites.mock.calls.length).toBeGreaterThan(1));

    expect(screen.getByText("Portfolio")).toBeInTheDocument();
    expect(screen.getByText("Going live")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't reach AWS just now/i)).not.toBeInTheDocument();
  });
});

describe("when AWS can't be read", () => {
  it("shows the sentence the backend wrote, not a raw error", async () => {
    // The rejection is shaped the way the host bridge really shapes one: it flattens the
    // backend's JSON reply into `backend <status>: {…}`. Earlier tests here threw the bare
    // sentence instead — already unwrapped — which is why this screen shipped printing the
    // whole envelope, braces and AWS text and all, and no test noticed.
    const client: HomeApi = {
      listSites: async () => {
        throw new Error(
          'backend 500: {"message":"Your AWS connection is paused in AgentsPoppy — turn it back on there, then try again.","detail":"CredentialsProviderError: connection paused"}',
        );
      },
    };
    render(<Home api={client} onAddSite={() => {}} />);

    const banner = await screen.findByText(/Your AWS connection is paused in AgentsPoppy/i);
    expect(banner.textContent).not.toMatch(/backend 500|[{}]/);
    // Relocated, not deleted (AGENTS.md §9) — the AWS text is still there to read.
    expect(screen.getByText(/CredentialsProviderError: connection paused/).closest("details")).not.toBeNull();
    // And never the empty-state hero: someone with five websites must not be told they have none.
    expect(screen.queryByText(/Put your website online/i)).not.toBeInTheDocument();
  });

  it("keeps 'Try again' disabled while its own request is in flight, then recovers", async () => {
    let attempt = 0;
    let release: (() => void) | undefined;
    const client: HomeApi = {
      listSites: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Couldn't reach AWS just now — check your internet connection and try again.");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { sites: [LIVE] };
      },
    };
    render(<Home api={client} onAddSite={() => {}} />);

    const tryAgain = await screen.findByRole("button", { name: /try again/i });
    await userEvent.click(tryAgain);

    // The button must react on the first click — the single most common defect in shipped
    // poppies is a control that sits there looking pressed-but-dead (AGENTS.md §9).
    const busy = await screen.findByRole("button", { name: /trying again/i });
    expect(busy).toBeDisabled();

    release?.();
    expect(await screen.findByText("Portfolio")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /trying again/i })).not.toBeInTheDocument());
  });
});
