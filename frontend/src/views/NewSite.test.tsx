import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewSite, type NewSiteApi } from "./NewSite";
import { NO_INDEX_MESSAGE } from "../lib/zip";
import type { GithubSetup } from "../api";
import type { Site } from "../types";

// Nothing here touches the bridge or AWS: the client is injected, and the files are the ones
// a real folder pick hands over. What is under test is the promise this screen makes to the
// user — that a control always reacts, that a failure is a sentence, and that a folder we
// already know AWS would serve as a 404 never gets uploaded in the first place.

const SITE: Site = {
  id: "d1a2b3c4",
  name: "Portfolio",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: "2026-08-23T10:00:00.000Z",
  platform: "WEB",
};

const SETUP: GithubSetup = {
  region: "eu-west-1",
  appInstallUrl: "https://github.com/apps/aws-amplify-eu-west-1/installations/new",
};

/**
 * The upload half, which is now one click in rather than the first thing on screen: GitHub
 * is the recommended card and arrives selected. Every test below that hands over files
 * starts here, which is exactly the extra step a real user takes.
 */
async function chooseUpload() {
  await userEvent.click(screen.getByRole("button", { name: /Upload a built site/i }));
}

/** A file as the OS folder picker hands it over: the PATH is what gets archived, not the name. */
function picked(path: string, content = "<!doctype html><title>hi</title>"): File {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const file = new File([content], name);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

/**
 * The same, but as heavy as the operating system claims. A real 4 GB pick can't be built in
 * a test — and shouldn't be: the guard exists precisely so nothing that size is ever read,
 * so the metadata lies while the contents stay tiny.
 */
function heavy(path: string, size: number): File {
  const file = picked(path);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Name the site and hand over a folder that really does have index.html at its top. */
async function fillInAGoodSite(name = "Portfolio") {
  await chooseUpload();
  await userEvent.type(screen.getByRole("textbox", { name: /call this website/i }), name);
  await userEvent.upload(screen.getByTestId("pick-folder"), [
    picked("dist/index.html"),
    picked("dist/assets/app.js", "console.log(1)"),
  ]);
  return screen.findByRole("button", { name: /put my site online/i });
}

describe("handing over the files", () => {
  it("explains a folder with no index.html instead of throwing, and uploads nothing", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await chooseUpload();
    await userEvent.upload(screen.getByTestId("pick-folder"), [picked("dist/app.js", "console.log(1)")]);

    // The one mistake that deploys perfectly and serves a 404 on every address.
    expect(await screen.findByText(NO_INDEX_MESSAGE)).toBeInTheDocument();
    // And the screen stops there: nothing to confirm, nothing created in the user's account.
    expect(screen.queryByRole("button", { name: /put my site online/i })).not.toBeInTheDocument();
    expect(client.createSite).not.toHaveBeenCalled();
  });

  it("shows what the confirm panel promises once a real build folder is picked", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    const go = await fillInAGoodSite();

    expect(go).toBeEnabled();
    // Money before commitment (UX.md ground rule 2), and whose money it is.
    expect(screen.getByText(/Costs/i)).toBeInTheDocument();
    expect(screen.getByText(/Billed by AWS to you, at AWS's prices/i)).toBeInTheDocument();
    expect(screen.getByText(/remove all of this with one click/i)).toBeInTheDocument();
  });

  it("keeps the button out of reach until the site has a name", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await chooseUpload();
    await userEvent.upload(screen.getByTestId("pick-folder"), [picked("dist/index.html")]);

    const go = await screen.findByRole("button", { name: /put my site online/i });
    expect(go).toBeDisabled();
    expect(screen.getByText(/Give your website a name first/i)).toBeInTheDocument();
  });
});

describe("putting the site online", () => {
  it("disables the button the instant it is pressed and holds it until AWS answers", async () => {
    const upload = deferred<{ jobId: string }>();
    const onDeployStarted = vi.fn();
    const client: NewSiteApi = {
      createSite: vi.fn(async () => ({ site: SITE })),
      uploadSite: vi.fn(() => upload.promise),
    };
    render(<NewSite api={client} onDeployStarted={onDeployStarted} onCancel={() => {}} />);

    const go = await fillInAGoodSite();
    await userEvent.click(go);

    // AGENTS.md §9: a control that starts async work reacts immediately, and a second click
    // can never get through while the first is still running.
    const busy = await screen.findByRole("button", { name: /putting it online/i });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(client.uploadSite).toHaveBeenCalledTimes(1);

    upload.resolve({ jobId: "job-7" });
    await waitFor(() =>
      expect(onDeployStarted).toHaveBeenCalledWith(expect.objectContaining({ site: SITE, jobId: "job-7" })),
    );
  });

  it("turns a failure into a sentence and gives the button back", async () => {
    const client: NewSiteApi = {
      createSite: vi.fn(async () => ({ site: SITE })),
      uploadSite: vi.fn(async () => {
        throw new Error("Couldn't reach AWS just now — check your internet connection and try again.");
      }),
    };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    const go = await fillInAGoodSite();
    await userEvent.click(go);

    expect(await screen.findByText(/Couldn't reach AWS just now/i)).toBeInTheDocument();
    const again = await screen.findByRole("button", { name: /put my site online/i });
    await waitFor(() => expect(again).toBeEnabled());
  });

  it("keeps the bridge's envelope out of the banner and the AWS text behind the disclosure", async () => {
    // The reported defect, exactly: a name the backend refuses came back as
    // `backend 400: {"message":…}` in a red banner. The mock above throws a bare sentence —
    // already unwrapped — which is why it passed while the screen was broken.
    const client: NewSiteApi = {
      createSite: vi.fn(async () => {
        throw new Error(
          'backend 400: {"message":"That name is a little long — keep it under 100 characters.","detail":"BadRequestException: name exceeds 100 characters"}',
        );
      }),
      uploadSite: vi.fn(),
    };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.click(await fillInAGoodSite());

    const banner = await screen.findByText(/That name is a little long/i);
    expect(banner.textContent).not.toMatch(/backend 400|[{}]/);
    expect(screen.getByText(/BadRequestException: name exceeds 100 characters/).closest("details")).not.toBeNull();
    // Nothing was uploaded, and the button is back so the name can be shortened and retried.
    expect(client.uploadSite).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: /put my site online/i })).toBeEnabled());
  });

  it("reuses the website it already made, so a retry can't leave a spare one behind", async () => {
    let attempt = 0;
    const client: NewSiteApi = {
      createSite: vi.fn(async () => ({ site: SITE })),
      uploadSite: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("AWS is handling a lot of requests right now — wait a moment and try again.");
        return { jobId: "job-9" };
      }),
    };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    const go = await fillInAGoodSite();
    await userEvent.click(go);
    await screen.findByText(/AWS is handling a lot of requests/i);

    await userEvent.click(await screen.findByRole("button", { name: /put my site online/i }));

    await waitFor(() => expect(client.uploadSite).toHaveBeenCalledTimes(2));
    // The second attempt must not create a second empty website in the user's account.
    expect(client.createSite).toHaveBeenCalledTimes(1);
  });
});

describe("a pick too big to upload", () => {
  it("says no on the spot, naming the size and the folder to pick instead", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    // Somebody who picked their project folder rather than the built one. The contents here
    // are two bytes; what makes it too big is the size the operating system reported, which
    // is the only thing that can be known before reading gigabytes.
    await chooseUpload();
    await userEvent.upload(screen.getByTestId("pick-folder"), [
      heavy("project/index.html", 900 * 1024 * 1024),
      heavy("project/node_modules/big.js", 900 * 1024 * 1024),
    ]);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/That folder comes to 1.8 GB/);
    expect(banner).toHaveTextContent(/dist, build or out/);
    // Nothing to confirm and nothing sent — the refusal is the whole interaction.
    expect(screen.queryByRole("button", { name: /put my site online/i })).not.toBeInTheDocument();
    expect(client.uploadSite).not.toHaveBeenCalled();
  });

  it("refuses an oversized .zip before opening it", async () => {
    const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await chooseUpload();
    const archive = new File(["x"], "site.zip", { type: "application/zip" });
    Object.defineProperty(archive, "size", { value: 3 * 1024 * 1024 * 1024 });
    await userEvent.upload(screen.getByTestId("pick-zip"), [archive]);

    expect(await screen.findByText(/That \.zip comes to 3 GB/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});

describe("a new version of a website that already exists", () => {
  it("asks for the files and nothing else, and says what it replaces", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn(async () => ({ jobId: "job-3" })) };
    render(<NewSite api={client} updating={SITE} onDeployStarted={() => {}} onCancel={() => {}} />);

    // No name to give: AWS is already holding one, and nothing here could change it.
    expect(screen.queryByRole("textbox", { name: /call this website/i })).not.toBeInTheDocument();
    expect(screen.getByText(/A new version of/)).toBeInTheDocument();
    expect(screen.getByText(/stays online until the new version is ready/i)).toBeInTheDocument();

    // The helper prompt is the kit's quiet size here rather than a second info banner — and
    // still wired: the webview that refuses the clipboard gets the prompt on screen instead.
    await userEvent.click(screen.getByRole("button", { name: /copy the helper prompt/i }));
    expect(await screen.findByLabelText(/helper prompt, to select and copy/i)).toBeInTheDocument();
  });

  it("uploads to the website it was handed, without a name and without creating anything", async () => {
    const onDeployStarted = vi.fn();
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn(async () => ({ jobId: "job-3" })) };
    render(<NewSite api={client} updating={SITE} onDeployStarted={onDeployStarted} onCancel={() => {}} />);

    await userEvent.upload(screen.getByTestId("pick-folder"), [picked("dist/index.html")]);
    const go = await screen.findByRole("button", { name: /put the new version online/i });
    // The old screen left this disabled until the name it discarded had been typed again.
    expect(go).toBeEnabled();
    expect(screen.getByText(/keeps serving them until the new one is ready/i)).toBeInTheDocument();

    await userEvent.click(go);

    await waitFor(() => expect(client.uploadSite).toHaveBeenCalledWith(SITE.id, expect.anything(), expect.any(String), expect.any(Function)));
    expect(client.createSite).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onDeployStarted).toHaveBeenCalledWith(expect.objectContaining({ site: SITE, jobId: "job-3" })),
    );
  });
});

describe("the name, before it is set in stone", () => {
  it("shows the name AWS will store when it differs from what was typed", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: /call this website/i }), "Café ☕");

    // Before the button, not after the fact: this name cannot be changed once the site exists.
    expect(await screen.findByText(/Saved as/)).toBeInTheDocument();
    expect(screen.getByText("Cafe")).toBeInTheDocument();
  });

  it("promises nothing it can't keep, and stays quiet when the name survives as typed", async () => {
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: /call this website/i }), "portfolio");

    expect(screen.queryByText(/Saved as/)).not.toBeInTheDocument();
    // The field used to say "you can change your mind later". Nothing in this poppy can rename
    // a website, so the copy must never imply it again.
    expect(screen.queryByText(/change your mind/i)).not.toBeInTheDocument();
    expect(screen.getByText(/can't be changed once the site exists/i)).toBeInTheDocument();
  });
});

describe("where the code comes from", () => {
  /** The GitHub half needs its own two calls; without them ConnectRepo reaches for the bridge. */
  const connected: NewSiteApi = {
    createSite: vi.fn(),
    uploadSite: vi.fn(),
    githubSetup: vi.fn(async () => SETUP),
    connectRepo: vi.fn(async () => ({ site: SITE, jobId: "job-11" })),
  };

  it("opens on GitHub, with uploading offered rather than buried", async () => {
    render(<NewSite api={connected} onDeployStarted={() => {}} onCancel={() => {}} />);

    // The recommended card is the one the screen arrives on (UX.md ground rule 1)…
    expect(await screen.findByText(/Let AWS read your repository/i)).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    // …and the fallback is a click away, not a footnote.
    await chooseUpload();
    expect(screen.getByText(/Where do your files come from\?/i)).toBeInTheDocument();
    expect(screen.getByTestId("pick-folder")).toBeInTheDocument();
    expect(screen.queryByText(/Let AWS read your repository/i)).not.toBeInTheDocument();
  });

  it("hands a connected repository over exactly as an upload does", async () => {
    const onDeployStarted = vi.fn();
    render(<NewSite api={connected} onDeployStarted={onDeployStarted} onCancel={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: /call this website/i }), "Portfolio");
    await userEvent.type(screen.getByLabelText(/paste your github key/i), "github_pat_exampleonly");
    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://github.com/acme/site");
    await userEvent.click(await screen.findByRole("button", { name: /connect and put my site online/i }));

    await waitFor(() =>
      // Nothing crossed the bridge from this computer, and the progress screen is told so.
      expect(onDeployStarted).toHaveBeenCalledWith({ site: SITE, jobId: "job-11", uploadedBytes: 0 }),
    );
    expect(connected.createSite).not.toHaveBeenCalled();
    expect(connected.uploadSite).not.toHaveBeenCalled();
  });

  it("never offers the fork for a new version of a website that already exists", async () => {
    render(<NewSite api={connected} updating={SITE} onDeployStarted={() => {}} onCancel={() => {}} />);

    // A website is connected or hand-fed for as long as it exists, so offering the choice
    // again here could only ever be a promise this screen can't keep.
    expect(screen.queryByText(/Where does your code live\?/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deploy from GitHub/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("pick-folder")).toBeInTheDocument();
  });
});

describe("what kind of thing is going online", () => {
  /** A fresh client per test: these count calls, and a shared `vi.fn()` remembers the last one's. */
  function client(): NewSiteApi {
    return {
      createSite: vi.fn(),
      uploadSite: vi.fn(),
      githubSetup: vi.fn(async () => SETUP),
      connectRepo: vi.fn(async () => ({ site: SITE, jobId: "job-11" })),
    };
  }

  /** The card that is now a real choice rather than a "coming later" notice. */
  const nextjsCard = () => screen.getByRole("button", { name: /A Next.js app/i });

  it("still offers both ways in for a finished site", async () => {
    render(<NewSite api={client()} onDeployStarted={() => {}} onCancel={() => {}} />);

    // The screen opens on a finished site connected to GitHub…
    expect(await screen.findByText(/Let AWS read your repository/i)).toBeInTheDocument();
    // …and uploading is still one click away, exactly as before Next.js existed.
    await chooseUpload();
    expect(screen.getByTestId("pick-folder")).toBeInTheDocument();
  });

  it("sends a Next.js app straight to GitHub, and never offers the upload", async () => {
    render(<NewSite api={client()} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.click(nextjsCard());

    // There is no fork to make: AWS has to build it, and this poppy can build nothing here.
    expect(await screen.findByText(/Let AWS read your repository/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload a built site/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("pick-folder")).not.toBeInTheDocument();
    // And the one person who CAN still take the other path is told so rather than left stuck.
    expect(screen.getByText(/export a static site/i)).toBeInTheDocument();
  });

  it("tells AWS which kind of website to make", async () => {
    const calls = client();
    render(<NewSite api={calls} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.click(nextjsCard());
    await userEvent.type(screen.getByRole("textbox", { name: /call this website/i }), "Shop");
    await userEvent.type(screen.getByLabelText(/paste your github key/i), "github_pat_exampleonly");
    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://github.com/acme/shop");
    await userEvent.click(await screen.findByRole("button", { name: /connect and put my site online/i }));

    // The whole point of the card. AWS sets the website up from this once and can never be
    // talked out of it: a Next.js app made as a finished site builds and then serves nothing.
    await waitFor(() =>
      expect(calls.connectRepo).toHaveBeenCalledWith(expect.objectContaining({ kind: "nextjs" })),
    );
  });

  it("says a finished site is a finished site, rather than leaving AWS to guess", async () => {
    const calls = client();
    render(<NewSite api={calls} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: /call this website/i }), "Portfolio");
    await userEvent.type(screen.getByLabelText(/paste your github key/i), "github_pat_exampleonly");
    await userEvent.type(screen.getByLabelText(/repository's address/i), "https://github.com/acme/site");
    await userEvent.click(await screen.findByRole("button", { name: /connect and put my site online/i }));

    await waitFor(() =>
      expect(calls.connectRepo).toHaveBeenCalledWith(expect.objectContaining({ kind: "static" })),
    );
  });
});

describe("the helper prompt", () => {
  it("puts the prompt on screen when the webview refuses the clipboard", async () => {
    // jsdom has neither navigator.clipboard nor execCommand — which is exactly the webview
    // that refuses `clipboard-write`. A copy button that silently fails is a dead button.
    const client: NewSiteApi = { createSite: vi.fn(), uploadSite: vi.fn() };
    render(<NewSite api={client} onDeployStarted={() => {}} onCancel={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /copy the helper prompt/i }));

    const box = (await screen.findByLabelText(/helper prompt, to select and copy/i)) as HTMLTextAreaElement;
    expect(box.value).toContain("MY WEBSITE:");
  });
});
