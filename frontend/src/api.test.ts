import { beforeEach, describe, expect, it, vi } from "vitest";

// The bridge is the only thing between this client and the backend, so it is what a test
// watches: what is under test here is the REQUEST — its method, its path and its query — and
// nothing else in this repo checks that. A wrong path is invisible to every other test in the
// frontend (they all inject a fake client) and shows up only against real AWS.
vi.mock("./host", () => ({ host: { invokeBackend: vi.fn(async () => ({})) } }));

import { api } from "./api";
import { host } from "./host";

const invoke = vi.mocked(host.invokeBackend);

/** The request the client sent, and the timeout it asked the bridge for. */
function sent(call = 0) {
  const args = invoke.mock.calls[call];
  return { request: args?.[0], timeoutMs: args?.[1] };
}

beforeEach(() => invoke.mockClear());

describe("asking how far a deploy has got", () => {
  it("names the branch the job is on", async () => {
    // The bug this exists for: without a branch the backend falls back to "main", so a site
    // built from a repository whose branch is `master` polls a job that does not exist. AWS
    // says "no such thing", which the backend reads as "not started yet" — so the screen
    // waits for ever on a build that has already succeeded.
    await api.deployStatus("d1a2b3c4", "7", "master");

    expect(sent().request).toEqual({ method: "GET", path: "/sites/d1a2b3c4/deploy/7?branch=master" });
  });

  it("escapes a branch name with a slash in it rather than growing another path segment", async () => {
    await api.deployStatus("d1a2b3c4", "7", "feature/new-look");

    expect(sent().request?.path).toBe("/sites/d1a2b3c4/deploy/7?branch=feature%2Fnew-look");
  });

  it("says nothing about a branch when the site has none, so the backend's own default stands", async () => {
    // A website uploaded by hand — and every website made before repositories could be
    // connected — has one live version, and the backend already knows what it is called.
    await api.deployStatus("d1a2b3c4", "7");

    expect(sent().request?.path).toBe("/sites/d1a2b3c4/deploy/7");
  });
});

describe("building the latest commit", () => {
  it("posts to the website's build route", async () => {
    await api.build("d1a2b3c4");

    expect(sent().request).toEqual({ method: "POST", path: "/sites/d1a2b3c4/build" });
  });

  it("gives AWS longer than the bridge's default to answer", async () => {
    // Not because it is slow, but because losing this reply loses the id needed to follow a
    // build the user is already paying build minutes for — so they press again and pay twice.
    await api.build("d1a2b3c4");

    expect(sent().timeoutMs).toBeGreaterThan(2 * 60_000);
  });
});
