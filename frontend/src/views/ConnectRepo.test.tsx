import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectRepo, readKeyKind, readRepo, tokenName, tokenPageUrl } from "./ConnectRepo";
import type { GithubSetup } from "../api";
import type { Site, SiteKind } from "../types";

// Nothing here touches the bridge, GitHub or AWS. What is under test is the two promises
// this screen makes: that a user cannot be walked into the one mistake AWS cannot undo, and
// that their key is treated like the password it is — never in a URL, and gone from the
// screen the moment the request it was for has finished.

const SITE: Site = {
  id: "d1a2b3c4",
  name: "Portfolio",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: "2026-08-24T10:00:00.000Z",
  platform: "WEB",
};

const SETUP: GithubSetup = {
  region: "eu-west-1",
  appInstallUrl: "https://github.com/apps/aws-amplify-eu-west-1/installations/new",
};

/** A key of the kind that works. Not a real one — no real key belongs in a repository. */
const GOOD_KEY = "github_pat_11ABCDEFG0aaaaaaaaaaaa_exampleonly";
const CLASSIC_KEY = "ghp_exampleonlyexampleonlyexampleonly";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Injected {
  setup?: () => Promise<GithubSetup>;
  connect?: (input: Parameters<NonNullable<Parameters<typeof ConnectRepo>[0]["connect"]>>[0]) => Promise<{
    site: Site;
    jobId: string;
  }>;
  openExternal?: (url: string) => void | Promise<void>;
  onConnected?: (started: { site: Site; jobId: string }) => void;
  name?: string;
  /** Left out, the screen behaves as it did before Next.js existed — a finished site. */
  kind?: SiteKind;
}

function show({ setup, connect, openExternal, onConnected, name = "Portfolio", kind }: Injected = {}) {
  const calls = {
    connect: vi.fn(connect ?? (async () => ({ site: SITE, jobId: "job-1" }))),
    openExternal: vi.fn(openExternal ?? (async () => {})),
    onConnected: vi.fn(onConnected ?? (() => {})),
  };
  render(
    <ConnectRepo
      name={name}
      kind={kind}
      setup={setup ?? (async () => SETUP)}
      connect={calls.connect}
      openExternal={calls.openExternal}
      onConnected={calls.onConnected}
    />,
  );
  return calls;
}

/** Fill in step 2 and step 3 the way somebody who did it right would. */
async function fillInAGoodConnection(key = GOOD_KEY, repo = "https://github.com/acme/site") {
  await userEvent.type(screen.getByLabelText(/paste your github key/i), key);
  await userEvent.type(screen.getByLabelText(/repository's address/i), repo);
  return screen.findByRole("button", { name: /connect and put my site online/i });
}

describe("reading what was pasted", () => {
  it("recognises a repository however it was copied", () => {
    for (const typed of [
      "https://github.com/acme/site",
      "http://github.com/acme/site",
      "https://www.github.com/acme/site/",
      "https://github.com/acme/site.git",
      "https://github.com/acme/site/tree/main",
      "git@github.com:acme/site.git",
      "ssh://git@github.com/acme/site",
      "github.com/acme/site",
      "acme/site",
      "  acme/site  ",
    ]) {
      expect(readRepo(typed), typed).toEqual({
        kind: "ok",
        owner: "acme",
        repo: "site",
        url: "https://github.com/acme/site",
      });
    }
  });

  it("names the other place, rather than refusing without saying why", () => {
    expect(readRepo("https://gitlab.com/acme/site")).toEqual({ kind: "not-github", host: "gitlab.com" });
    expect(readRepo("git@bitbucket.org:acme/site.git")).toEqual({ kind: "not-github", host: "bitbucket.org" });
  });

  it("holds nothing back on an owner with no repository", () => {
    expect(readRepo("").kind).toBe("empty");
    expect(readRepo("   ").kind).toBe("empty");
    expect(readRepo("https://github.com/acme").kind).toBe("unreadable");
    expect(readRepo("acme").kind).toBe("unreadable");
  });
});

describe("telling GitHub's two kinds of key apart", () => {
  it("knows the fine-grained kind from the classic one", () => {
    expect(readKeyKind(GOOD_KEY)).toBe("fine-grained");
    expect(readKeyKind(`  ${GOOD_KEY}  `)).toBe("fine-grained");
    expect(readKeyKind(CLASSIC_KEY)).toBe("classic");
    expect(readKeyKind("gho_exampleonly")).toBe("classic");
    // GitHub's pre-2021 classic token: forty hexadecimal characters and no prefix at all.
    expect(readKeyKind("a".repeat(40))).toBe("classic");
    expect(readKeyKind("")).toBe("empty");
  });

  it("lets an unfamiliar key through rather than breaking the day GitHub changes it", () => {
    expect(readKeyKind("something_new_2030_abc")).toBe("unknown");
  });
});

describe("the key page we send people to", () => {
  it("asks GitHub for exactly the fine-grained key AWS needs", () => {
    const url = new URL(tokenPageUrl({ owner: "acme", repo: "site" }));
    // The fine-grained page, never the classic one: the page decides the kind of key, and
    // the kind of key decides how AWS wires the website — which cannot be changed later.
    expect(url.pathname).toBe("/settings/personal-access-tokens/new");
    expect(url.searchParams.get("target_name")).toBe("acme");
    expect(url.searchParams.get("contents")).toBe("read");
    expect(url.searchParams.get("metadata")).toBe("read");
    expect(url.searchParams.get("administration")).toBe("read");
    expect(url.searchParams.get("repository_hooks")).toBe("write");
    // Same month the backend's own copy of this URL uses (github.ts DEFAULT_TOKEN_DAYS).
    expect(url.searchParams.get("expires_in")).toBe("30");
  });

  it("still works before the repository has been typed", () => {
    const url = new URL(tokenPageUrl(null));
    expect(url.searchParams.get("target_name")).toBeNull();
    expect(url.searchParams.get("contents")).toBe("read");
  });

  // GitHub refuses a name over 40 characters — and it refuses it on ITS page, after the user
  // has left this app, in the middle of the one step that cannot be undone afterwards. The
  // founder hit this with a 27-character repository name (2026-09-10).
  it("never sends GitHub a name it will refuse", () => {
    const long = "a-rather-long-project-name-";
    const name = new URL(tokenPageUrl({ owner: "acme", repo: long })).searchParams.get("name")!;
    expect(name.length).toBeLessThanOrEqual(40);
    // Still recognisable months later: it is the repository's name that got shortened, not
    // dropped, and it does not trail off on a hyphen.
    expect(name).toContain("HostingPoppy");
    expect(name).toContain("a-rather-long");
    expect(name).not.toMatch(/[-_. ]$/);
  });

  it("leaves a name that already fits exactly as it is", () => {
    expect(tokenName({ repo: "site" })).toBe("HostingPoppy - site");
    // The boundary itself, both sides of it.
    const exact = "a".repeat(40 - "HostingPoppy - ".length);
    expect(tokenName({ repo: exact })).toHaveLength(40);
    expect(tokenName({ repo: exact + "a" })).toHaveLength(40);
  });

  it("falls back to the plain label rather than sending an empty name", () => {
    expect(tokenName(null)).toBe("HostingPoppy");
    // A name that is nothing but separators truncates to nothing; the label alone still
    // identifies the key, and GitHub would refuse an empty one.
    expect(tokenName({ repo: "-".repeat(50) })).toBe("HostingPoppy");
  });
});

describe("step 1 — letting AWS read the repository", () => {
  it("opens the region's own GitHub app through the bridge", async () => {
    const calls = show();

    await userEvent.click(await screen.findByRole("button", { name: /open github/i }));

    // The region matters: another region's app grants AWS nothing here, and the failure
    // arrives much later with no clue attached.
    expect(calls.openExternal).toHaveBeenCalledWith(SETUP.appInstallUrl);
    expect(await screen.findByText(/Opened in your browser/i)).toBeInTheDocument();
  });

  it("shows the address to copy when the host refuses to open it", async () => {
    // Inside the host's frame a link is a silent no-op, so a refused bridge call would
    // otherwise leave a button that visibly does nothing — and a screen that can't start.
    const calls = show({
      openExternal: async () => {
        throw new Error("openExternal is not allowed");
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: /open github/i }));

    expect(await screen.findByText(SETUP.appInstallUrl)).toBeInTheDocument();
    expect(calls.openExternal).toHaveBeenCalledTimes(1);
  });

  it("turns a failed look-up into a sentence with a way out", async () => {
    show({
      setup: async () => {
        throw new Error("Can't reach your AgentsPoppy connection — reopen HostingPoppy from AgentsPoppy.");
      },
    });

    expect(await screen.findByText(/Can't reach your AgentsPoppy connection/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
  });
});

describe("the key, before AWS ever sees it", () => {
  it("refuses the classic kind on the spot, and creates nothing", async () => {
    const calls = show();
    const go = await fillInAGoodConnection(CLASSIC_KEY);

    // The whole point of checking here: by the time AWS could tell us, a website exists in
    // the user's account wired a way that can only be fixed by deleting it.
    expect(await screen.findByText(/GitHub's older kind of key/i)).toBeInTheDocument();
    expect(screen.getByText(/can't be corrected afterwards/i)).toBeInTheDocument();
    expect(go).toBeDisabled();

    await userEvent.click(go);
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it("keeps the key out of the page and out of every address", async () => {
    const calls = show();
    await fillInAGoodConnection();

    const field = screen.getByLabelText(/paste your github key/i) as HTMLInputElement;
    // A password field, so the key is not readable over the user's shoulder…
    expect(field.type).toBe("password");
    // …and it is never carried in a URL, where it would be logged by everything it touches.
    await userEvent.click(screen.getByRole("button", { name: /open the key page/i }));
    for (const [url] of calls.openExternal.mock.calls) expect(url).not.toContain(GOOD_KEY);
    expect(document.body.textContent).not.toContain(GOOD_KEY);
  });

  it("wipes the key once the attempt is over, and says so", async () => {
    const calls = show({
      connect: async () => {
        throw new Error("AWS is handling a lot of requests right now — wait a moment and try again.");
      },
    });

    await userEvent.click(await fillInAGoodConnection());

    expect(await screen.findByText(/AWS is handling a lot of requests/i)).toBeInTheDocument();
    // Cleared even on the way out — but explained, so an empty box doesn't read as a paste
    // that didn't take and send somebody back to GitHub for a key they already have.
    expect((screen.getByLabelText(/paste your github key/i) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/cleared from this screen/i)).toBeInTheDocument();
    expect(calls.connect).toHaveBeenCalledTimes(1);
  });
});

describe("connecting", () => {
  it("sends what was read, not what was typed, and hands over when AWS answers", async () => {
    const started = deferred<{ site: Site; jobId: string }>();
    const calls = show({ connect: () => started.promise });

    const go = await fillInAGoodConnection(GOOD_KEY, "git@github.com:acme/site.git");
    await userEvent.click(go);

    // AGENTS.md §9: the control reacts at once, and a second press can't get through.
    const busy = await screen.findByRole("button", { name: /connecting…/i });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(calls.connect).toHaveBeenCalledTimes(1);

    expect(calls.connect).toHaveBeenCalledWith({
      name: "Portfolio",
      // Stated, not left to a default — AWS sets the website up from this and can never be
      // talked out of it afterwards.
      kind: "static",
      // The address AWS understands, derived from an SSH remote the user pasted.
      repository: "https://github.com/acme/site",
      branch: "main",
      accessToken: GOOD_KEY,
    });

    started.resolve({ site: SITE, jobId: "job-4" });
    await waitFor(() => expect(calls.onConnected).toHaveBeenCalledWith({ site: SITE, jobId: "job-4" }));
    // Gone from the screen the moment its one job is done.
    await waitFor(() =>
      expect((screen.getByLabelText(/paste your github key/i) as HTMLInputElement).value).toBe(""),
    );
  });

  it("sends the branch the panel named, even when the box was emptied", async () => {
    const calls = show();
    await userEvent.clear(screen.getByLabelText(/the branch that goes live/i));

    await userEvent.click(await fillInAGoodConnection());

    // Not a scolding and not a guess: the box's placeholder, the sentence above the button
    // and what AWS is asked for are all the same word.
    await waitFor(() => expect(calls.connect).toHaveBeenCalledWith(expect.objectContaining({ branch: "main" })));
  });

  it("says what will happen, what it costs and that the choice is permanent", async () => {
    show();
    await fillInAGoodConnection();

    expect(await screen.findByText(/Every push to that branch goes live/i)).toBeInTheDocument();
    // Money before commitment (UX.md ground rule 2), and never a promise of free.
    expect(screen.getByText(/about a penny for each minute AWS spends building/i)).toBeInTheDocument();
    expect(screen.getByText(/can't promise free/i)).toBeInTheDocument();
    expect(screen.getByText(/Billed by AWS to you, at AWS's prices/i)).toBeInTheDocument();
    expect(screen.getByText(/never\s+both/i)).toBeInTheDocument();
  });

  it("warns about both of GitHub's name rules before sending anyone to its page", async () => {
    // Each refuses on GitHub's side, mid-step, on a page we don't control — the founder hit
    // "Name is too long" and then "Name has already been taken" back to back (2026-09-10).
    // The length one we now prevent outright (see tokenName); the taken one we can only warn
    // about, because nothing here can know what keys the user already has.
    show();
    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://github.com/acme/site");
    expect(screen.getByText(/already taken/i)).toBeInTheDocument();
    expect(screen.getByText(/just a label/i)).toBeInTheDocument();
  });

  it("holds the key button shut until the repository is known, and says why", async () => {
    // The key is made FOR a repository. Opened early, GitHub's page asks the user to choose
    // among all of theirs — the founder watched that disorient a real user (2026-08-25),
    // which is why the repository is step 2 and the key is step 3.
    show();
    const keyButton = await screen.findByRole("button", { name: /open the key page/i });
    expect(keyButton).toBeDisabled();
    expect(screen.getByText(/paste your repository's address in step 2 first/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://github.com/acme/site");

    expect(keyButton).toBeEnabled();
    // And the reason is replaced by the one instruction GitHub's page can't pre-fill,
    // naming the exact repository to pick.
    expect(screen.getByText(/only select repositories/i)).toBeInTheDocument();
    expect(screen.queryByText(/paste your repository's address in step 2 first/i)).toBeNull();
  });

  it("asks for the repository before the key: install is 1, repository 2, key 3", async () => {
    show();
    const headings = await screen.findAllByRole("heading", { level: 3 });
    const order = headings.map((h) => h.textContent ?? "");
    expect(order.findIndex((s) => s.startsWith("2."))).toBeLessThan(order.findIndex((s) => s.startsWith("3.")));
    expect(order.find((s) => s.startsWith("2."))).toMatch(/repository/i);
    expect(order.find((s) => s.startsWith("3."))).toMatch(/key/i);
  });

  it("shows what it made of the address, the way the domain screen does", async () => {
    show();
    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://github.com/acme/site/tree/main");

    // Three times over: "this is what we read", the key hint naming which repository to
    // pick on GitHub's page, and the confirm panel saying what is about to happen — the
    // pasted /tree/main is not part of any of them, because it isn't part of the repository.
    expect(await screen.findAllByText("acme/site")).toHaveLength(3);
  });

  it("explains a repository somewhere GitHub isn't, instead of trying it", async () => {
    const calls = show();
    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://gitlab.com/acme/site");

    expect(await screen.findByText(/only deploy from GitHub today/i)).toBeInTheDocument();
    // No confirm panel at all: there is nothing here that could be connected.
    expect(screen.queryByRole("button", { name: /connect and put my site online/i })).not.toBeInTheDocument();
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it("won't go until the website has a name, and says which piece is missing", async () => {
    show({ name: "" });
    const go = await fillInAGoodConnection();

    expect(go).toBeDisabled();
    expect(screen.getByText(/Give your website a name first/i)).toBeInTheDocument();
  });
});

describe("an app that renders its own pages", () => {
  it("carries the choice to AWS, which can never be told otherwise afterwards", async () => {
    const calls = show({ kind: "nextjs" });

    await userEvent.click(await fillInAGoodConnection());

    await waitFor(() => expect(calls.connect).toHaveBeenCalledWith(expect.objectContaining({ kind: "nextjs" })));
  });

  it("quotes its own cost rather than the finished site's, and still promises nothing", async () => {
    show({ kind: "nextjs" });
    await fillInAGoodConnection();

    // Longer builds and a running server: repeating the static figure here would be an
    // understatement the user only meets on a bill.
    expect(await screen.findByText(/two to five minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/charges for the time it spends making pages/i)).toBeInTheDocument();
    expect(screen.getByText(/can't promise free/i)).toBeInTheDocument();
    expect(screen.getByText(/Billed by AWS to you, at AWS's prices/i)).toBeInTheDocument();
    // What AWS actually does with it, in the user's words and never in AWS's.
    expect(screen.getByText(/putting each page together as somebody asks for it/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/WEB_COMPUTE|platform/i);
  });

  it("doesn't offer a hand-fed alternative that never existed for it", async () => {
    show({ kind: "nextjs" });
    await fillInAGoodConnection();

    // The finished site's banner tells people they could have uploaded instead. For this kind
    // they could not, and pointing at a door that isn't there is its own kind of dead button.
    expect(await screen.findByText(/has to be built/i)).toBeInTheDocument();
    expect(screen.queryByText(/never\s+both/i)).not.toBeInTheDocument();
  });
});
