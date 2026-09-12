import { afterEach, describe, expect, it, vi } from "vitest";
import type { AmplifyClient } from "@aws-sdk/client-amplify";

import {
  absoluteRecordName,
  amplifySetupFor,
  wwwSettings,
  attachDomain,
  BRANCH_TAG,
  branchOf,
  connectRepository,
  createSite,
  deleteSite,
  deployStatus,
  describeDomainCheck,
  detachDomain,
  domainStatus,
  explainDomainFailure,
  getSite,
  listSites,
  mapDomainStatus,
  mapJob,
  planDomainRecords,
  plannedWrites,
  siteFromApp,
  siteTarget,
  startBuild,
  startDeploy,
  teardownAll,
  writeDomainRecords,
  type ConnectRepositoryInput,
  type HostingCtx,
  type NameVerdict,
  type RecordWrite,
  type ZoneAccess,
} from "./amplify";
import { LIVE_BRANCH, amplifyAppName, defaultUrlFor, splitDomain } from "./sites";
import { defaultBuildSpec, nextBuildSpec } from "./github";
import { resourceTags } from "./tags";
import type { HttpError } from "./errors";
import type { DnsRecord, DomainStatus, HostedZoneRef, NameFacts } from "./types";

// A hand-written stand-in for the Amplify client: it dispatches on the command's class name
// and records every call, so a test can assert both what we asked AWS for and what we did
// NOT ask for (the tag guard's whole point is a DeleteApp that never happens).

type Handler = (input: Record<string, unknown>) => unknown;

class FakeAmplify {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];

  constructor(private readonly handlers: Record<string, Handler>) {}

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name.replace(/Command$/, "");
    this.calls.push({ name, input: command.input });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`the test did not expect a ${name} call`);
    return handler(command.input);
  }

  /** Every command name we were sent, in order. */
  names(): string[] {
    return this.calls.map((c) => c.name);
  }

  input(name: string): Record<string, unknown> {
    const call = this.calls.find((c) => c.name === name);
    if (!call) throw new Error(`no ${name} call was made`);
    return call.input;
  }
}

const ATTRIBUTION = { accountId: "111122223333", connectionId: "conn-1" };

function ctxWith(handlers: Record<string, Handler>): { ctx: HostingCtx; fake: FakeAmplify } {
  const fake = new FakeAmplify(handlers);
  return {
    ctx: { amp: fake as unknown as AmplifyClient, region: "eu-west-1", attribution: ATTRIBUTION },
    fake,
  };
}

const OURS = resourceTags(ATTRIBUTION);
const THEIRS = { Name: "someone-elses-site" };

function app(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: "d1abc",
    name: "my-site",
    defaultDomain: "d1abc.amplifyapp.com",
    createTime: new Date("2026-08-01T10:00:00.000Z"),
    platform: "WEB",
    tags: OURS,
    ...over,
  };
}

/** An AWS "it isn't there" error, shaped the way the SDK throws it. */
function notFound(): Error {
  const e = new Error("app not found");
  e.name = "NotFoundException";
  return e;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listSites", () => {
  it("keeps only apps tagged as ours — ListApps is account-wide", async () => {
    const { ctx } = ctxWith({
      ListApps: () => ({
        apps: [app({ appId: "mine", tags: OURS }), app({ appId: "theirs", tags: THEIRS }), app({ appId: "untagged", tags: undefined })],
      }),
    });
    const sites = await listSites(ctx);
    expect(sites.map((s) => s.id)).toEqual(["mine"]);
  });

  it("pages to the very end — a site it never sees is a site teardown leaves behind", async () => {
    const pages = [
      { apps: [app({ appId: "a", createTime: new Date("2026-08-01T00:00:00Z") })], nextToken: "t1" },
      { apps: [app({ appId: "b", createTime: new Date("2026-08-02T00:00:00Z") })], nextToken: "t2" },
      { apps: [app({ appId: "c", createTime: new Date("2026-08-03T00:00:00Z") })] },
    ];
    let page = 0;
    const { ctx, fake } = ctxWith({ ListApps: () => pages[page++]! });

    const sites = await listSites(ctx);

    expect(sites.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(fake.calls.map((c) => c.input["nextToken"])).toEqual([undefined, "t1", "t2"]);
  });

  it("stops when AWS repeats a page token instead of paging forever", async () => {
    let calls = 0;
    const { ctx } = ctxWith({
      ListApps: () => {
        calls++;
        return { apps: [app({ appId: `a${calls}` })], nextToken: "stuck" };
      },
    });
    const sites = await listSites(ctx);
    expect(calls).toBe(2);
    expect(sites).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// What a site's KIND decides (DESIGN §3)
//
// Four settings, one decision. They are asserted together, in one place, because that is
// the whole reason the function exists: any one of them set the other way round ships a
// website that AWS builds without complaint and that then does not work.
// ---------------------------------------------------------------------------

describe("amplifySetupFor", () => {
  it("gives a finished site the static platform, the deep-link rewrite and the static build spec", () => {
    expect(amplifySetupFor("static")).toEqual({
      platform: "WEB",
      spaRewrite: true,
      buildSpec: defaultBuildSpec(),
    });
    // No framework: AWS's own default is already right for a site it only serves, and saying
    // it here would be inventing a value we would then have to keep correct forever.
    expect(amplifySetupFor("static").framework).toBeUndefined();
  });

  it("gives a Next.js app a server, no rewrite, the .next build spec and the SSR framework", () => {
    // Each of the four is load-bearing, and each fails SILENTLY the other way round:
    //  WEB_COMPUTE — a Next.js app created as WEB builds and then serves nothing useful;
    //  no rewrite  — /index.html for every extension-less path shadows every server route;
    //  .next spec  — the static spec copies finished files and produces no server, and NO
    //                spec is not a safe middle: framework detection is part of Amplify's
    //                console flow, not its API, and this poppy only uses the API;
    //  framework   — a WEB_COMPUTE branch left as plain `Web` fails every build, and the
    //                documented repair (UpdateBranch) is not a permission this poppy holds.
    expect(amplifySetupFor("nextjs")).toEqual({
      platform: "WEB_COMPUTE",
      spaRewrite: false,
      buildSpec: nextBuildSpec(),
      framework: "Next.js - SSR",
    });
  });

  it("reads an unknown answer as a finished site — never as a server nobody asked for", () => {
    // The one that costs money is the direction this must never guess in.
    expect(amplifySetupFor("something-else" as never)).toEqual(amplifySetupFor("static"));
  });
});

describe("createSite", () => {
  it("births both resources tagged, on WEB, with the single-page-app rewrite", async () => {
    const { ctx, fake } = ctxWith({
      CreateApp: () => ({ app: app() }),
      CreateBranch: () => ({ branch: { branchName: LIVE_BRANCH } }),
    });

    const site = await createSite(ctx, "My Site", "static");

    const created = fake.input("CreateApp");
    expect(created["name"]).toBe(amplifyAppName("My Site"));
    expect(created["platform"]).toBe("WEB");
    expect(created["tags"]).toEqual(OURS);
    const rules = created["customRules"] as { source: string; target: string; status: string }[];
    expect(rules).toHaveLength(1);
    expect(rules[0]!.target).toBe("/index.html");
    expect(rules[0]!.status).toBe("200");
    // The extension-less-path rewrite: without it every deep link 404s.
    expect(rules[0]!.source).toContain("^[^.]+$");

    const branch = fake.input("CreateBranch");
    expect(branch).toMatchObject({
      appId: "d1abc",
      branchName: LIVE_BRANCH,
      stage: "PRODUCTION",
      enableAutoBuild: false,
      tags: OURS,
    });

    expect(site.id).toBe("d1abc");
    expect(site.defaultUrl).toBe(defaultUrlFor(LIVE_BRANCH, "d1abc.amplifyapp.com"));
  });

  it("refuses a Next.js app here, and says what to do instead", async () => {
    // No handlers at all: reaching AWS would be the bug. FakeAmplify throws on any call.
    const { ctx, fake } = ctxWith({});

    const err = (await createSite(ctx, "My Site", "nextjs").catch((e: unknown) => e)) as HttpError;

    expect(err.status).toBe(400);
    // A refusal that helps: the one thing to do next, and the one case where staying on this
    // path is right. A Next.js app has to be built, and only AWS can build it — this poppy
    // is confined and cannot run anything on the user's machine.
    expect(err.message).toMatch(/connect its repository on GitHub/i);
    expect(err.message).toMatch(/static export/i);
    expect(err.message).toMatch(/works today/i);
    // Nothing was created, so there is nothing to clean up and nothing on the user's bill.
    expect(fake.names()).toEqual([]);
  });

  it("removes the half-made website when the live branch fails, and reports the branch error", async () => {
    const { ctx, fake } = ctxWith({
      CreateApp: () => ({ app: app() }),
      CreateBranch: () => {
        throw new Error("LimitExceeded");
      },
      DeleteApp: () => ({}),
    });

    await expect(createSite(ctx, "My Site", "static")).rejects.toThrow(/LimitExceeded/);
    expect(fake.names()).toEqual(["CreateApp", "CreateBranch", "DeleteApp"]);
    expect(fake.input("DeleteApp")).toEqual({ appId: "d1abc" });
  });

  it("still reports the branch failure when the cleanup itself fails", async () => {
    const { ctx } = ctxWith({
      CreateApp: () => ({ app: app() }),
      CreateBranch: () => {
        throw new Error("LimitExceeded");
      },
      DeleteApp: () => {
        throw new Error("AccessDenied");
      },
    });
    await expect(createSite(ctx, "My Site", "static")).rejects.toThrow(/LimitExceeded/);
  });
});

describe("getSite", () => {
  it("answers null for a website that isn't there", async () => {
    const { ctx } = ctxWith({
      GetApp: () => {
        throw notFound();
      },
    });
    expect(await getSite(ctx, "gone")).toBeNull();
  });

  it("answers null for an app somebody else made", async () => {
    const { ctx } = ctxWith({ GetApp: () => ({ app: app({ tags: THEIRS }) }) });
    expect(await getSite(ctx, "d1abc")).toBeNull();
  });

  it("lets a refused call through rather than reporting an empty account", async () => {
    const denied = new Error("not authorized");
    denied.name = "UnauthorizedException";
    const { ctx } = ctxWith({
      GetApp: () => {
        throw denied;
      },
    });
    await expect(getSite(ctx, "d1abc")).rejects.toThrow(/not authorized/);
  });
});

describe("deleteSite", () => {
  it("refuses an app that isn't ours — and sends no delete at all", async () => {
    const { ctx, fake } = ctxWith({ GetApp: () => ({ app: app({ tags: THEIRS }) }) });

    await expect(deleteSite(ctx, "d1abc")).rejects.toThrow(/didn't create that website/i);
    expect(fake.names()).toEqual(["GetApp"]);
  });

  it("re-reads the tags rather than trusting the id it was handed", async () => {
    const { ctx, fake } = ctxWith({ GetApp: () => ({ app: app() }), DeleteApp: () => ({}) });
    await deleteSite(ctx, "d1abc");
    expect(fake.names()).toEqual(["GetApp", "DeleteApp"]);
  });

  it("treats an already-missing website as done — teardown may run twice", async () => {
    const { ctx, fake } = ctxWith({
      GetApp: () => {
        throw notFound();
      },
    });
    await expect(deleteSite(ctx, "gone")).resolves.toBeUndefined();
    expect(fake.names()).toEqual(["GetApp"]);
  });

  it("treats a website that disappears mid-delete as done", async () => {
    const { ctx } = ctxWith({
      GetApp: () => ({ app: app() }),
      DeleteApp: () => {
        throw notFound();
      },
    });
    await expect(deleteSite(ctx, "d1abc")).resolves.toBeUndefined();
  });
});

describe("startDeploy", () => {
  const zip = Buffer.from("PK pretend zip");

  it("PUTs the bytes to the presigned address with no auth header, then publishes", async () => {
    const put = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", put);

    const { ctx, fake } = ctxWith({
      CreateDeployment: () => ({ jobId: "7", zipUploadUrl: "https://upload.example/put?X-Amz-Signature=abc" }),
      StartDeployment: () => ({ jobSummary: { jobId: "7" } }),
    });

    const jobId = await startDeploy(ctx, "d1abc", zip);

    expect(jobId).toBe("7");
    expect(fake.names()).toEqual(["CreateDeployment", "StartDeployment"]);
    expect(fake.input("StartDeployment")).toEqual({ appId: "d1abc", branchName: LIVE_BRANCH, jobId: "7" });

    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("X-Amz-Signature");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(zip);
    // A signature travels in the query string; an Authorization header turns this into a 403.
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("falls back to the id from the first call when publishing doesn't echo one", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => "" }));
    const { ctx } = ctxWith({
      CreateDeployment: () => ({ jobId: "12", zipUploadUrl: "https://upload.example/put" }),
      StartDeployment: () => ({}),
    });
    expect(await startDeploy(ctx, "d1abc", zip)).toBe("12");
  });

  it("turns a refused upload into a sentence, and never publishes half an upload", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 403,
      text: async () => "<Error><Code>SignatureDoesNotMatch</Code></Error>",
    }));

    const { ctx, fake } = ctxWith({
      CreateDeployment: () => ({ jobId: "7", zipUploadUrl: "https://upload.example/put" }),
    });

    await expect(startDeploy(ctx, "d1abc", zip)).rejects.toThrow(/files couldn't reach AWS \(403\)/);
    expect(fake.names()).toEqual(["CreateDeployment"]);
  });

  it("keeps AWS's raw explanation out of the sentence and behind the error's cause", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403, text: async () => "SignatureDoesNotMatch" }));
    const { ctx } = ctxWith({
      CreateDeployment: () => ({ jobId: "7", zipUploadUrl: "https://upload.example/put" }),
    });

    const err: Error = await startDeploy(ctx, "d1abc", zip).then(
      () => {
        throw new Error("the upload should not have been accepted");
      },
      (e: Error) => e,
    );
    expect(err.message).not.toContain("SignatureDoesNotMatch");
    expect(err.cause).toBe("SignatureDoesNotMatch");
  });

  it("turns a dropped connection into a sentence rather than an unhandled rejection", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { ctx } = ctxWith({
      CreateDeployment: () => ({ jobId: "7", zipUploadUrl: "https://upload.example/put" }),
    });
    await expect(startDeploy(ctx, "d1abc", zip)).rejects.toThrow(/internet connection/i);
  });

  it("says so plainly when AWS gives us nowhere to upload to", async () => {
    const { ctx } = ctxWith({ CreateDeployment: () => ({ jobId: "7" }) });
    await expect(startDeploy(ctx, "d1abc", zip)).rejects.toThrow(/anywhere to put your files/i);
  });
});

describe("deployStatus", () => {
  it("reads the live branch's job", async () => {
    const { ctx, fake } = ctxWith({
      GetJob: () => ({ job: { summary: { jobId: "7", status: "RUNNING" }, steps: [] } }),
    });
    const status = await deployStatus(ctx, "d1abc", "7");
    expect(status.phase).toBe("running");
    expect(fake.input("GetJob")).toEqual({ appId: "d1abc", branchName: LIVE_BRANCH, jobId: "7" });
  });

  it("reports a job AWS hasn't caught up with as pending, not as a failure", async () => {
    const { ctx } = ctxWith({
      GetJob: () => {
        throw notFound();
      },
    });
    expect(await deployStatus(ctx, "d1abc", "7")).toEqual({ jobId: "7", phase: "pending" });
  });

  it("follows a connected site's own branch — the wrong one reads as a build that never starts", async () => {
    const { ctx, fake } = ctxWith({
      GetJob: () => ({ job: { summary: { jobId: "7", status: "RUNNING" }, steps: [] } }),
    });
    await deployStatus(ctx, "d1abc", "7", "master");
    expect(fake.input("GetJob")).toEqual({ appId: "d1abc", branchName: "master", jobId: "7" });
  });
});

describe("mapJob", () => {
  it("maps every status AWS can report", () => {
    const phases = ["CREATED", "PENDING", "PROVISIONING", "RUNNING", "SUCCEED", "FAILED", "CANCELLING", "CANCELLED"].map(
      (status) => mapJob({ jobId: "1", status }).phase,
    );
    expect(phases).toEqual([
      "pending",
      "pending",
      "running",
      "running",
      "succeeded",
      "failed",
      "running", // still winding down — the screen must keep polling
      "cancelled",
    ]);
  });

  it("treats a status it has never seen as pending rather than guessing", () => {
    expect(mapJob({ jobId: "1", status: "SOMETHING_NEW" }).phase).toBe("pending");
  });

  it("accepts a bare summary as well as a whole job", () => {
    const summary = { jobId: "9", status: "SUCCEED", startTime: new Date("2026-08-01T10:00:00Z") };
    expect(mapJob(summary)).toEqual(mapJob({ summary, steps: [] }));
  });

  it("reports times as ISO strings and survives a timestamp AWS mangled", () => {
    const good = mapJob({
      jobId: "9",
      status: "SUCCEED",
      startTime: new Date("2026-08-01T10:00:00Z"),
      endTime: new Date("2026-08-01T10:02:00Z"),
    });
    expect(good.startedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(good.finishedAt).toBe("2026-08-01T10:02:00.000Z");

    const bad = mapJob({ jobId: "9", status: "SUCCEED", startTime: new Date("nonsense") });
    expect(bad.startedAt).toBeUndefined();
  });

  it("says nothing when an upload is fine, and something useful when it isn't", () => {
    expect(mapJob({ jobId: "1", status: "SUCCEED" }).reason).toBeUndefined();
    expect(mapJob({ summary: { jobId: "1", status: "CANCELLED" } }).reason).toMatch(/stopped before it finished/i);

    const unzip = mapJob({
      summary: { jobId: "1", status: "FAILED" },
      steps: [{ statusReason: "Unable to extract the uploaded archive" }],
    });
    expect(unzip.reason).toMatch(/couldn't open that file/i);

    const other = mapJob({ summary: { jobId: "1", status: "FAILED" }, steps: [{ statusReason: "InternalFailure" }] });
    expect(other.reason).toMatch(/index\.html/);
    // Never AWS's own words.
    expect(other.reason).not.toContain("InternalFailure");
  });
});

describe("what a failed deploy is explained as", () => {
  // An Amplify app is connected to a repository or it is manual, permanently, and the two
  // fail in ways with nothing in common. This used to answer both with zip advice, which for
  // a connected site sends the user hunting for a file they never made while the thing that
  // would actually help — the build log, and a push — goes unmentioned.

  it("tells an uploaded site about its zip, and a connected one about its build", () => {
    const failed = { summary: { jobId: "1", status: "FAILED" }, steps: [{ statusReason: "InternalFailure" }] };

    expect(mapJob(failed, "upload").reason).toMatch(/index\.html/);
    const built = mapJob(failed, "github").reason ?? "";
    expect(built).toMatch(/didn't build/i);
    expect(built).toMatch(/push again/i);
    expect(built).not.toMatch(/zip|index\.html/i);
  });

  it("separates a repository AWS can no longer read from a build that broke", () => {
    // Pushing again fixes one and does nothing at all for the other.
    const denied = mapJob(
      { summary: { jobId: "1", status: "FAILED" }, steps: [{ statusReason: "Access denied cloning the repository" }] },
      "github",
    ).reason;
    expect(denied).toMatch(/couldn't read your repository/i);

    const broke = mapJob(
      { summary: { jobId: "1", status: "FAILED" }, steps: [{ statusReason: "Command failed: npm run build" }] },
      "github",
    ).reason;
    expect(broke).toMatch(/didn't build/i);
    // Never AWS's own words, on either path.
    expect(`${denied} ${broke}`).not.toContain("npm run build");
  });

  it("calls a stopped build a build and a stopped upload an upload", () => {
    expect(mapJob({ jobId: "1", status: "CANCELLED" }, "github").reason).toMatch(/that build was stopped/i);
    expect(mapJob({ jobId: "1", status: "CANCELLED" }, "upload").reason).toMatch(/that upload was stopped/i);
  });

  it("treats a site it was told nothing about as an uploaded one — the wire contract's own default", () => {
    expect(mapJob({ jobId: "1", status: "CANCELLED" }).reason).toMatch(/that upload was stopped/i);
  });
});

describe("deployStatus — learning which kind of site it is describing", () => {
  const failedJob = { job: { summary: { jobId: "7", status: "FAILED" }, steps: [{ statusReason: "Command failed" }] } };

  it("asks AWS when the caller didn't say and a job has ended badly", async () => {
    // The status route is polled every few seconds and holds nothing about the site, so this
    // is the only place the sentence can be got right. It is one extra call, at the end of an
    // unhappy deploy, by which time the app has long since settled.
    const { ctx, fake } = ctxWith({
      GetJob: () => failedJob,
      GetApp: () => ({ app: app({ repository: "https://github.com/acme/docs" }) }),
    });

    const status = await deployStatus(ctx, "d1abc", "7");

    expect(status.reason).toMatch(/didn't build/i);
    expect(fake.names()).toContain("GetApp");
  });

  it("reads an app with no repository as the uploaded site it is", async () => {
    const { ctx } = ctxWith({ GetJob: () => failedJob, GetApp: () => ({ app: app({ repository: "" }) }) });
    expect(await deployStatus(ctx, "d1abc", "7").then((s) => s.reason)).toMatch(/index\.html/);
  });

  it("costs nothing on the happy path, or when the caller already knows", async () => {
    const running = { job: { summary: { jobId: "7", status: "RUNNING" }, steps: [] } };
    const { ctx, fake } = ctxWith({ GetJob: () => running });
    await deployStatus(ctx, "d1abc", "7");
    expect(fake.names()).toEqual(["GetJob"]);

    const known = ctxWith({ GetJob: () => failedJob });
    const status = await deployStatus(known.ctx, "d1abc", "7", LIVE_BRANCH, "github");
    expect(status.reason).toMatch(/didn't build/i);
    expect(known.fake.names()).toEqual(["GetJob"]);
  });

  it("still reports the deploy when that second read fails — the user is waiting on the status, not the wording", async () => {
    const { ctx } = ctxWith({
      GetJob: () => failedJob,
      GetApp: () => {
        throw notFound();
      },
    });
    const status = await deployStatus(ctx, "d1abc", "7");
    expect(status.phase).toBe("failed");
    expect(status.reason).toBeTruthy();
  });
});

describe("attachDomain", () => {
  it("creates the association on the root with the prefix pointed at the live branch", async () => {
    const { ctx, fake } = ctxWith({
      CreateDomainAssociation: () => ({
        domainAssociation: {
          domainName: "example.com",
          domainStatus: "CREATING",
          subDomains: [{ subDomainSetting: { prefix: "www", branchName: LIVE_BRANCH }, verified: false }],
        },
      }),
    });

    const status = await attachDomain(ctx, "d1abc", "www.example.com");

    const { root, prefix } = splitDomain("www.example.com");
    expect(fake.input("CreateDomainAssociation")).toEqual({
      appId: "d1abc",
      domainName: root,
      subDomainSettings: [{ prefix, branchName: LIVE_BRANCH }],
    });
    expect(status.domain).toBe("www.example.com");
    expect(status.phase).toBe("verifying");
  });

  it("points the address at a connected site's own branch — the one that actually serves", async () => {
    const { ctx, fake } = ctxWith({
      CreateDomainAssociation: () => ({
        domainAssociation: { domainName: "example.com", domainStatus: "CREATING", subDomains: [] },
      }),
    });

    await attachDomain(ctx, "d1abc", "example.com", "master");

    const sent = fake.input("CreateDomainAssociation")["subDomainSettings"] as { branchName: string }[];
    expect(sent[0]!.branchName).toBe("master");
  });
});

describe("domainStatus", () => {
  it("answers null when no address is attached", async () => {
    const { ctx } = ctxWith({
      GetDomainAssociation: () => {
        throw notFound();
      },
    });
    expect(await domainStatus(ctx, "d1abc", "example.com")).toBeNull();
  });

  it("recovers the full address from AWS even though it was only asked about the root", async () => {
    const { ctx } = ctxWith({
      GetDomainAssociation: () => ({
        domainAssociation: {
          domainName: "example.com",
          domainStatus: "AVAILABLE",
          subDomains: [{ subDomainSetting: { prefix: "www" }, verified: true }],
        },
      }),
    });
    const status = await domainStatus(ctx, "d1abc", "example.com");
    expect(status?.domain).toBe("www.example.com");
    expect(status?.url).toBe("https://www.example.com");
  });
});

describe("detachDomain", () => {
  it("refuses an app that isn't ours — and sends no delete", async () => {
    const { ctx, fake } = ctxWith({ GetApp: () => ({ app: app({ tags: THEIRS }) }) });
    await expect(detachDomain(ctx, "d1abc", "example.com")).rejects.toThrow(/didn't create that website/i);
    expect(fake.names()).toEqual(["GetApp"]);
  });

  it("removes the association, and treats an already-detached address as done", async () => {
    const { ctx, fake } = ctxWith({ GetApp: () => ({ app: app() }), DeleteDomainAssociation: () => ({}) });
    await detachDomain(ctx, "d1abc", "example.com");
    expect(fake.input("DeleteDomainAssociation")).toEqual({ appId: "d1abc", domainName: "example.com" });

    const second = ctxWith({
      GetApp: () => ({ app: app() }),
      DeleteDomainAssociation: () => {
        throw notFound();
      },
    });
    await expect(detachDomain(second.ctx, "d1abc", "example.com")).resolves.toBeUndefined();
  });
});

describe("mapDomainStatus", () => {
  const certRecord = "_a1b2.example.com CNAME _c3d4.xyz.acm-validations.aws.";
  const wwwRecord = "www CNAME d111111abcdef8.cloudfront.net";

  it("shows the certificate record while AWS checks the domain is yours", () => {
    for (const domainStatusValue of ["CREATING", "REQUESTING_CERTIFICATE", "PENDING_VERIFICATION", "IMPORTING_CUSTOM_CERTIFICATE"]) {
      const status = mapDomainStatus(
        {
          domainName: "example.com",
          domainStatus: domainStatusValue,
          certificateVerificationDNSRecord: certRecord,
          subDomains: [{ subDomainSetting: { prefix: "www" }, verified: false, dnsRecord: wwwRecord }],
        },
        "www.example.com",
      );
      expect(status.phase).toBe("verifying");
      expect(status.records.map((r) => r.purpose)).toEqual(["certificate-validation"]);
      expect(status.reason).toMatch(/Add the record below/);
      expect(status.url).toBeUndefined();
    }
  });

  it("shows the pointing records once the certificate step is behind it", () => {
    for (const domainStatusValue of ["AWAITING_APP_CNAME", "PENDING_DEPLOYMENT", "IN_PROGRESS", "UPDATING"]) {
      const status = mapDomainStatus(
        {
          domainName: "example.com",
          domainStatus: domainStatusValue,
          certificateVerificationDNSRecord: certRecord,
          subDomains: [{ subDomainSetting: { prefix: "www" }, verified: false, dnsRecord: wwwRecord }],
        },
        "www.example.com",
      );
      expect(status.phase).toBe("pending-dns");
      expect(status.records.map((r) => r.purpose)).toEqual(["point-your-domain"]);
    }
  });

  it("asks nothing more of a sub-domain AWS has already verified", () => {
    const status = mapDomainStatus(
      {
        domainName: "example.com",
        domainStatus: "IN_PROGRESS",
        subDomains: [
          { subDomainSetting: { prefix: "www" }, verified: true, dnsRecord: wwwRecord },
          { subDomainSetting: { prefix: "" }, verified: false, dnsRecord: "example.com ANAME d111111abcdef8.cloudfront.net" },
        ],
      },
      "www.example.com",
    );
    expect(status.records).toHaveLength(1);
    expect(status.reason).toMatch(/Add the record below/);
  });

  it("is calm rather than silent when everything is published and nothing is left to do", () => {
    const status = mapDomainStatus(
      {
        domainName: "example.com",
        domainStatus: "IN_PROGRESS",
        subDomains: [{ subDomainSetting: { prefix: "www" }, verified: true, dnsRecord: wwwRecord }],
      },
      "www.example.com",
    );
    expect(status.records).toEqual([]);
    expect(status.reason).toMatch(/usually takes a few minutes/i);
  });

  it("goes live with a URL and stops explaining itself", () => {
    const status = mapDomainStatus(
      {
        domainName: "example.com",
        domainStatus: "AVAILABLE",
        subDomains: [{ subDomainSetting: { prefix: "www" }, verified: true, dnsRecord: wwwRecord }],
      },
      "www.example.com",
    );
    expect(status.phase).toBe("live");
    expect(status.url).toBe("https://www.example.com");
    expect(status.records).toEqual([]);
    expect(status.reason).toBeUndefined();
  });

  it("serves a root domain with no prefix", () => {
    const status = mapDomainStatus(
      {
        domainName: "example.com",
        domainStatus: "AVAILABLE",
        subDomains: [{ subDomainSetting: { prefix: "" }, verified: true }],
      },
      "example.com",
    );
    expect(status.domain).toBe("example.com");
    expect(status.url).toBe("https://example.com");
  });

  it("falls back to the address it was asked about before AWS echoes the sub-domains", () => {
    const status = mapDomainStatus({ domainName: "example.com", domainStatus: "CREATING" }, "www.example.com");
    expect(status.domain).toBe("www.example.com");
  });

  it("on failure shows everything still outstanding, in a sentence with an action in it", () => {
    const status = mapDomainStatus(
      {
        domainName: "example.com",
        domainStatus: "FAILED",
        statusReason: "Certificate validation timed out",
        certificateVerificationDNSRecord: certRecord,
        subDomains: [{ subDomainSetting: { prefix: "www" }, verified: false, dnsRecord: wwwRecord }],
      },
      "www.example.com",
    );
    expect(status.phase).toBe("failed");
    expect(status.records.map((r) => r.purpose)).toEqual(["certificate-validation", "point-your-domain"]);
    expect(status.reason).toMatch(/wasn't confirmed in time/i);
    // AWS's own words never reach the user.
    expect(status.reason).not.toContain("Certificate validation timed out");
  });

  it("names the real problem when the address belongs to another website", () => {
    const status = mapDomainStatus(
      { domainName: "example.com", domainStatus: "FAILED", statusReason: "Domain is already associated with another app" },
      "example.com",
    );
    expect(status.reason).toMatch(/already connected to another website/i);
  });

  it("still says something useful when AWS explains nothing", () => {
    const status = mapDomainStatus({ domainName: "example.com", domainStatus: "FAILED" }, "example.com");
    expect(status.reason).toMatch(/remove it here and try adding it again/i);
  });

  it("treats a status it has never seen as an early wait, so the screen keeps polling", () => {
    const status = mapDomainStatus(
      { domainName: "example.com", domainStatus: "SOME_NEW_STATE", certificateVerificationDNSRecord: certRecord },
      "example.com",
    );
    expect(status.phase).toBe("verifying");
    expect(status.records).toHaveLength(1);
  });

  it("keeps an empty record string out of the copy-paste table", () => {
    const status = mapDomainStatus(
      { domainName: "example.com", domainStatus: "CREATING", certificateVerificationDNSRecord: "   " },
      "example.com",
    );
    expect(status.records).toEqual([]);
  });
});

describe("teardownAll", () => {
  it("removes every website and names the ones it removed", async () => {
    const deleted: string[] = [];
    const { ctx } = ctxWith({
      ListApps: () => ({ apps: [app({ appId: "a", name: "site-a" }), app({ appId: "b", name: "site-b" })] }),
      GetApp: (input) => ({ app: app({ appId: input["appId"], name: `site-${input["appId"] as string}` }) }),
      DeleteApp: (input) => {
        deleted.push(input["appId"] as string);
        return {};
      },
    });

    expect(await teardownAll(ctx)).toEqual(["site-a", "site-b"]);
    expect(deleted).toEqual(["a", "b"]);
  });

  it("keeps going past a website it can't remove, and says which one is left", async () => {
    const deleted: string[] = [];
    const { ctx } = ctxWith({
      ListApps: () => ({
        apps: [
          app({ appId: "a", name: "site-a", createTime: new Date("2026-08-01T00:00:00Z") }),
          app({ appId: "b", name: "site-b", createTime: new Date("2026-08-02T00:00:00Z") }),
          app({ appId: "c", name: "site-c", createTime: new Date("2026-08-03T00:00:00Z") }),
        ],
      }),
      GetApp: (input) => ({ app: app({ appId: input["appId"], name: `site-${input["appId"] as string}` }) }),
      DeleteApp: (input) => {
        if (input["appId"] === "b") throw new Error("DependentServiceFailure");
        deleted.push(input["appId"] as string);
        return {};
      },
    });

    const err = (await teardownAll(ctx).catch((e: unknown) => e)) as Error & { removed: string[]; remaining: string[] };

    // The sweep finished — the failure did not strand site-c.
    expect(deleted).toEqual(["a", "c"]);
    expect(err.removed).toEqual(["site-a", "site-c"]);
    expect(err.remaining).toEqual(["site-b"]);
    expect(err.message).toContain("site-b");
  });

  it("is happy to run again on an account that is already clean", async () => {
    const { ctx } = ctxWith({ ListApps: () => ({ apps: [] }) });
    expect(await teardownAll(ctx)).toEqual([]);
  });

  it("leaves other people's hosting alone", async () => {
    const { ctx, fake } = ctxWith({ ListApps: () => ({ apps: [app({ appId: "theirs", tags: THEIRS })] }) });
    expect(await teardownAll(ctx)).toEqual([]);
    expect(fake.names()).toEqual(["ListApps"]);
  });
});

describe("siteFromApp", () => {
  it("maps an app onto the wire contract", () => {
    const site = siteFromApp(
      {
        appId: "d1abc",
        name: "my-site",
        defaultDomain: "d1abc.amplifyapp.com",
        createTime: new Date("2026-08-01T10:00:00Z"),
        platform: "WEB",
      },
      "eu-west-1",
    );
    expect(site).toEqual({
      id: "d1abc",
      name: "my-site",
      defaultUrl: defaultUrlFor(LIVE_BRANCH, "d1abc.amplifyapp.com"),
      createdAt: "2026-08-01T10:00:00.000Z",
      platform: "WEB",
      // No repository on the app means the site can only be uploaded to — and the screens
      // have to know that before they offer anybody a button.
      source: "upload",
      branch: LIVE_BRANCH,
    });
  });

  it("keeps a clickable address even when AWS omits the default one", () => {
    const site = siteFromApp({ appId: "d1abc", name: "my-site" }, "eu-west-1");
    expect(site.defaultUrl).toBe(defaultUrlFor(LIVE_BRANCH, "d1abc.amplifyapp.com"));
    // No timestamp is shown as nothing rather than as 1970.
    expect(site.createdAt).toBe("");
  });

  it("reports the retired server-rendering platform as a finished site", () => {
    expect(siteFromApp({ appId: "d1abc", platform: "WEB_DYNAMIC" }, "eu-west-1").platform).toBe("WEB");
    expect(siteFromApp({ appId: "d1abc", platform: "WEB_COMPUTE" }, "eu-west-1").platform).toBe("WEB_COMPUTE");
  });

  it("tells a connected site from an uploaded one by what AWS says, not by what we remember", () => {
    const connected = siteFromApp(app({ repository: REPO, tags: { ...OURS, [BRANCH_TAG]: "master" } }), "eu-west-1");
    expect(connected.source).toBe("github");
    expect(connected.repository).toBe(REPO);
    expect(connected.branch).toBe("master");

    const uploaded = siteFromApp(app({ repository: "" }), "eu-west-1");
    expect(uploaded.source).toBe("upload");
    expect(uploaded.repository).toBeUndefined();
  });

  it("links to the branch that actually serves, not to the uploaded-site default", () => {
    const site = siteFromApp(app({ repository: REPO, tags: { ...OURS, [BRANCH_TAG]: "master" } }), "eu-west-1");
    expect(site.defaultUrl).toBe("https://master.d1abc.amplifyapp.com");
  });

  it("writes a branch name that a web address can't hold the way AWS does", () => {
    // AWS serves release/2.0 at release-2-0.<app>.amplifyapp.com — a web address holds only
    // letters, digits and hyphens.
    const site = siteFromApp(app({ repository: REPO, tags: { ...OURS, [BRANCH_TAG]: "release/2.0" } }), "eu-west-1");
    expect(site.defaultUrl).toBe("https://release-2-0.d1abc.amplifyapp.com");
    // The branch itself is untouched — it is what AWS is asked about, not what is displayed.
    expect(site.branch).toBe("release/2.0");
  });
});

// ---------------------------------------------------------------------------
// Connecting a GitHub repository (DESIGN §3.2)
// ---------------------------------------------------------------------------

const REPO = "https://github.com/olly/my-site";
const TOKEN = "github_pat_11ABCDEFG0abcdefghijklmnop";

/** What connectRepository is asked for, unless a test says otherwise. */
function connectInput(over: Partial<ConnectRepositoryInput> = {}): ConnectRepositoryInput {
  // A finished site by default: it is what every test written before Next.js existed meant,
  // and the Next.js tests say so in as many words.
  return { name: "My Site", repository: REPO, accessToken: TOKEN, branch: "main", kind: "static", ...over };
}

/** AWS's answers on the happy path: created, read back correctly wired, branch, first build. */
function connectHandlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    CreateApp: () => ({ app: app({ repository: REPO }) }),
    GetApp: () => ({ app: app({ repository: REPO, repositoryCloneMethod: "TOKEN" }) }),
    CreateBranch: () => ({ branch: { branchName: "main" } }),
    StartJob: () => ({ jobSummary: { jobId: "1" } }),
    ...over,
  };
}

describe("connectRepository", () => {
  it("connects, checks the wiring, turns on push-to-deploy, then starts the first build", async () => {
    const { ctx, fake } = ctxWith(connectHandlers());

    const { site, jobId } = await connectRepository(ctx, connectInput());

    // The order is the mechanism: an app created through the API does not build by itself,
    // and the wiring can only be checked after it exists (DESIGN §3.2).
    expect(fake.names()).toEqual(["CreateApp", "GetApp", "CreateBranch", "StartJob"]);

    const created = fake.input("CreateApp");
    expect(created["repository"]).toBe(REPO);
    expect(created["accessToken"]).toBe(TOKEN);
    expect(created["platform"]).toBe("WEB");
    // We supply build instructions because a repository with no amplify.yml of its own has
    // nothing to build with when the app was made through the API.
    expect(String(created["buildSpec"])).toContain("version: 1");
    expect(created["tags"]).toEqual({ ...OURS, [BRANCH_TAG]: "main" });
    // The rewrite is set here as well, rather than left to Amplify's framework detection:
    // without it every deep link and every refresh on a connected React/Vue site 404s, which
    // our own copy promises does not happen.
    const rules = created["customRules"] as { source: string; target: string; status: string }[];
    expect(rules).toHaveLength(1);
    expect(rules[0]!.target).toBe("/index.html");
    expect(rules[0]!.status).toBe("200");
    expect(rules[0]!.source).toContain("^[^.]+$");

    expect(fake.input("CreateBranch")).toMatchObject({
      appId: "d1abc",
      branchName: "main",
      stage: "PRODUCTION",
      enableAutoBuild: true,
      tags: { ...OURS, [BRANCH_TAG]: "main" },
    });
    expect(fake.input("StartJob")).toEqual({ appId: "d1abc", branchName: "main", jobType: "RELEASE" });

    expect(jobId).toBe("1");
    expect(site).toMatchObject({ id: "d1abc", source: "github", repository: REPO, branch: "main" });
  });

  it("uses the very same rewrite the uploaded-site path does — two copies would drift", async () => {
    const uploaded = ctxWith({
      CreateApp: () => ({ app: app() }),
      CreateBranch: () => ({ branch: { branchName: LIVE_BRANCH } }),
    });
    await createSite(uploaded.ctx, "My Site", "static");

    const connected = ctxWith(connectHandlers());
    await connectRepository(connected.ctx, connectInput());

    // A connected React site and an uploaded one are the same kind of site to a browser, so
    // the routing they get has to be identical — and identical because it is one constant,
    // not because two literals happen to agree today.
    expect(connected.fake.input("CreateApp")["customRules"]).toEqual(uploaded.fake.input("CreateApp")["customRules"]);
  });

  it("sets all three of a finished site's settings — the rewrite and the build spec are conditional now", async () => {
    const { ctx, fake } = ctxWith(connectHandlers());

    await connectRepository(ctx, connectInput({ kind: "static" }));

    const created = fake.input("CreateApp");
    expect(created["platform"]).toBe("WEB");
    expect((created["customRules"] as unknown[]) ?? []).toHaveLength(1);
    expect(String(created["buildSpec"])).toContain("version: 1");
    // No framework claimed for a site AWS only serves: AWS's default is already right, and a
    // value invented here is one more thing that has to stay correct forever.
    expect(fake.input("CreateBranch")).not.toHaveProperty("framework");
  });

  it("puts a Next.js app on a server, with no rewrite, the .next spec and the SSR framework", async () => {
    // AWS echoes back what it made, which for this kind is a server-rendering app.
    const nextApp = app({ repository: REPO, platform: "WEB_COMPUTE" });
    const { ctx, fake } = ctxWith(
      connectHandlers({
        CreateApp: () => ({ app: nextApp }),
        GetApp: () => ({ app: { ...nextApp, repositoryCloneMethod: "TOKEN" } }),
      }),
    );

    const { site } = await connectRepository(ctx, connectInput({ kind: "nextjs" }));

    const created = fake.input("CreateApp");
    // Without this the app builds and then serves nothing useful — nothing is running to
    // render its pages.
    expect(created["platform"]).toBe("WEB_COMPUTE");
    // Absent, not empty and not undefined: the rewrite would send every extension-less path
    // to /index.html, which is every route Next.js serves for itself.
    expect(created).not.toHaveProperty("customRules");
    // Present, and the Next.js one — NOT the static spec, which copies a built folder to a
    // static directory and produces no server. Sending none is not a safe middle either:
    // framework detection belongs to Amplify's console flow, not the API this poppy uses,
    // so a repository without its own amplify.yml would have nothing to build with.
    expect(String(created["buildSpec"])).toContain("baseDirectory: .next");
    expect(String(created["buildSpec"])).not.toContain(".hostingpoppy-site");

    // Said at CREATION, because it cannot be said afterwards: a WEB_COMPUTE branch whose
    // framework resolves to plain `Web` fails every build, and the documented repair is
    // UpdateBranch — an action this poppy deliberately does not grant itself.
    expect(fake.input("CreateBranch")["framework"]).toBe("Next.js - SSR");

    // And the website reports what it is, so the screens can say it renders on a server.
    expect(site.platform).toBe("WEB_COMPUTE");
  });

  it("reports the platform AWS confirms, not the one we asked for", async () => {
    // AWS's answer to CreateApp is not always complete — and after a reinstall the only
    // source is AWS anyway, so the read-back that proved the wiring is what the site is
    // described from.
    const { ctx } = ctxWith(
      connectHandlers({
        CreateApp: () => ({ app: app({ repository: REPO, platform: undefined }) }),
        GetApp: () => ({ app: app({ repository: REPO, platform: "WEB_COMPUTE", repositoryCloneMethod: "TOKEN" }) }),
      }),
    );

    const { site } = await connectRepository(ctx, connectInput({ kind: "nextjs" }));

    expect(site.platform).toBe("WEB_COMPUTE");
    // The branch tag is still ours: we set it in the create call and AWS's copy can lag.
    expect(site.branch).toBe("main");
    expect(site.repository).toBe(REPO);
  });

  it("uses the branch the user named everywhere, not the uploaded-site default", async () => {
    const { ctx, fake } = ctxWith(connectHandlers({ CreateBranch: () => ({ branch: { branchName: "master" } }) }));

    const { site } = await connectRepository(ctx, connectInput({ branch: "master" }));

    expect(fake.input("CreateBranch")["branchName"]).toBe("master");
    expect(fake.input("StartJob")["branchName"]).toBe("master");
    // And it is written onto the app, because nothing here is remembered between calls.
    expect((fake.input("CreateApp")["tags"] as Record<string, string>)[BRANCH_TAG]).toBe("master");
    expect(site.branch).toBe("master");
  });

  it("throws the whole thing away when AWS used the old wiring — the only moment that is free", async () => {
    const { ctx, fake } = ctxWith(
      connectHandlers({
        GetApp: () => ({ app: app({ repository: REPO, repositoryCloneMethod: "SSH" }) }),
        DeleteApp: () => ({}),
      }),
    );

    await expect(connectRepository(ctx, connectInput())).rejects.toThrow(/fine-grained key/i);
    // No branch, no build: nothing is built on wiring that can never be repaired.
    expect(fake.names()).toEqual(["CreateApp", "GetApp", "DeleteApp"]);
    expect(fake.input("DeleteApp")).toEqual({ appId: "d1abc" });
  });

  it("treats AWS not saying how it wired it as the wrong kind, rather than hoping", async () => {
    const { ctx, fake } = ctxWith(
      connectHandlers({ GetApp: () => ({ app: app({ repository: REPO }) }), DeleteApp: () => ({}) }),
    );
    await expect(connectRepository(ctx, connectInput())).rejects.toThrow(/fine-grained key/i);
    expect(fake.names()).toContain("DeleteApp");
  });

  it("names the consequence and the fix, without ever quoting the key", async () => {
    const { ctx } = ctxWith(
      connectHandlers({
        GetApp: () => ({ app: app({ repository: REPO, repositoryCloneMethod: "SSH" }) }),
        DeleteApp: () => ({}),
      }),
    );
    const err: Error = await connectRepository(ctx, connectInput()).then(
      () => {
        throw new Error("the wrong wiring should not have been accepted");
      },
      (e: Error) => e,
    );
    expect(err.message).toMatch(/nothing was kept/i);
    expect(err.message).toMatch(/github_pat_/);
    expect(err.message).not.toContain(TOKEN);
    // No AWS words on a screen the user reads.
    expect(err.message).not.toMatch(/repositoryCloneMethod|SSH|Amplify/);
  });

  it("never claims a cleanup that failed — it names what is left and where to remove it", async () => {
    const { ctx } = ctxWith(
      connectHandlers({
        GetApp: () => ({ app: app({ repository: REPO, repositoryCloneMethod: "SSH" }) }),
        DeleteApp: () => {
          // Throttled, or refused for a moment: the rollback is best-effort by design.
          throw new Error("ThrottlingException");
        },
      }),
    );

    const err: Error = await connectRepository(ctx, connectInput()).then(
      () => {
        throw new Error("the wrong wiring should not have been accepted");
      },
      (e: Error) => e,
    );

    // The website survived, it can never be repaired, and it is on the user's bill — being
    // told "nothing was kept" would send them away from a mess only they can now clear up.
    expect(err.message).not.toMatch(/nothing was kept/i);
    expect(err.message).toMatch(/couldn't remove/i);
    // The name AWS stored, which is the one their websites list and Resources tab show.
    expect(err.message).toContain('"my-site"');
    expect(err.message).toMatch(/websites list/i);
    expect(err.message).toMatch(/resources tab/i);
    // Still the same refusal with the same fix, so the screen behaves exactly as before.
    expect((err as HttpError).status).toBe(400);
    expect(err.message).toMatch(/github_pat_/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("still says nothing was kept when AWS says the half-made website is already gone", async () => {
    const { ctx } = ctxWith(
      connectHandlers({
        GetApp: () => ({ app: app({ repository: REPO, repositoryCloneMethod: "SSH" }) }),
        DeleteApp: () => {
          throw notFound();
        },
      }),
    );

    const err: Error = await connectRepository(ctx, connectInput()).then(
      () => {
        throw new Error("the wrong wiring should not have been accepted");
      },
      (e: Error) => e,
    );

    // A delete that fails because there is nothing to delete still leaves nothing behind —
    // warning about a leftover website that does not exist would be its own small lie.
    expect(err.message).toMatch(/nothing was kept/i);
    expect(err.message).not.toMatch(/couldn't remove/i);
  });

  it("leaves nothing behind when the wiring can't be read at all", async () => {
    const { ctx, fake } = ctxWith(
      connectHandlers({
        GetApp: () => {
          throw new Error("fetch failed");
        },
        DeleteApp: () => ({}),
      }),
    );
    await expect(connectRepository(ctx, connectInput())).rejects.toThrow(/fetch failed/);
    expect(fake.names()).toEqual(["CreateApp", "GetApp", "DeleteApp"]);
  });

  it("leaves nothing behind when the branch can't be made, and reports that failure", async () => {
    const { ctx, fake } = ctxWith(
      connectHandlers({
        CreateBranch: () => {
          throw new Error("LimitExceeded");
        },
        DeleteApp: () => ({}),
      }),
    );
    await expect(connectRepository(ctx, connectInput())).rejects.toThrow(/LimitExceeded/);
    expect(fake.names()).toEqual(["CreateApp", "GetApp", "CreateBranch", "DeleteApp"]);
  });

  it("still reports the real failure when the cleanup itself fails", async () => {
    const { ctx } = ctxWith(
      connectHandlers({
        CreateBranch: () => {
          throw new Error("LimitExceeded");
        },
        DeleteApp: () => {
          throw new Error("AccessDenied");
        },
      }),
    );
    await expect(connectRepository(ctx, connectInput())).rejects.toThrow(/LimitExceeded/);
  });

  it("keeps a correctly connected repository even when the first build won't start", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx, fake } = ctxWith(
      connectHandlers({
        StartJob: () => {
          throw new Error("ThrottlingException");
        },
      }),
    );

    const { site, jobId } = await connectRepository(ctx, connectInput());

    // The repository IS connected and every push will build it — throwing that away over a
    // build that can be started again with one button would be the worse outcome.
    expect(site.source).toBe("github");
    expect(jobId).toBeUndefined();
    expect(fake.names()).not.toContain("DeleteApp");
    quiet.mockRestore();
  });

  it("takes the key back out of anything AWS says on the way past", async () => {
    const { ctx } = ctxWith({
      CreateApp: () => {
        // AWS has no reason to echo the key, but this is the one call it is handed to, and a
        // key that reaches a log line or a "technical details" disclosure is a leaked key.
        throw new Error(`BadRequestException: the token ${TOKEN} was refused`);
      },
    });

    const err: Error = await connectRepository(ctx, connectInput()).then(
      () => {
        throw new Error("that should have failed");
      },
      (e: Error) => e,
    );
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[the access key you pasted]");
    // The error itself survives, so errors.ts can still recognise it.
    expect(err.message).toContain("BadRequestException");
  });

  it("never returns the key to whoever asked", async () => {
    const { ctx } = ctxWith(connectHandlers());
    const result = await connectRepository(ctx, connectInput());
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("refuses to report a website AWS didn't finish making", async () => {
    const { ctx } = ctxWith({ CreateApp: () => ({}) });
    await expect(connectRepository(ctx, connectInput())).rejects.toThrow(/didn't finish connecting/i);
  });
});

describe("startBuild", () => {
  it("asks AWS to build and publish the latest commit", async () => {
    const { ctx, fake } = ctxWith({ StartJob: () => ({ jobSummary: { jobId: "9" } }) });
    expect(await startBuild(ctx, "d1abc", "master")).toBe("9");
    expect(fake.input("StartJob")).toEqual({ appId: "d1abc", branchName: "master", jobType: "RELEASE" });
  });

  it("falls back to the one live version an uploaded site uses", async () => {
    const { ctx, fake } = ctxWith({ StartJob: () => ({ jobSummary: { jobId: "9" } }) });
    await startBuild(ctx, "d1abc");
    expect(fake.input("StartJob")["branchName"]).toBe(LIVE_BRANCH);
  });

  it("says so rather than handing back a build nobody can follow", async () => {
    const { ctx } = ctxWith({ StartJob: () => ({}) });
    await expect(startBuild(ctx, "d1abc", "main")).rejects.toThrow(/didn't say how to follow it/i);
  });
});

describe("branchOf", () => {
  it("trusts our own tag first — it is right from the moment the app exists", () => {
    expect(branchOf({ tags: { ...OURS, [BRANCH_TAG]: "master" }, productionBranch: { branchName: "main" } })).toBe("master");
  });

  it("falls back to what AWS says it serves", () => {
    expect(branchOf({ tags: OURS, productionBranch: { branchName: "release" } })).toBe("release");
  });

  it("falls back to the uploaded-site default when neither is there", () => {
    expect(branchOf({})).toBe(LIVE_BRANCH);
    expect(branchOf({ tags: { ...OURS, [BRANCH_TAG]: "  " } })).toBe(LIVE_BRANCH);
  });
});

// ---------------------------------------------------------------------------
// Reading the zone before touching a domain (DESIGN §3.3)
//
// Every test below runs against a hand-written ZoneAccess rather than Route 53: the point of
// declaring that port at all is that the deciding — which sentence, which offer, which refusal
// — can be pinned down without AWS. The live failure that started this section (a wildcard
// answering for hp-test.example.net) is in here as a test, so it cannot come back quietly.
// ---------------------------------------------------------------------------

const CLOUDFRONT = "d111111abcdef8.cloudfront.net";

function facts(over: Partial<NameFacts> = {}): NameFacts {
  return {
    address: "hp-test.example.net",
    root: "example.net",
    prefix: "hp-test",
    state: "free",
    ...over,
  };
}

function pointingRecord(over: Partial<DnsRecord> = {}): DnsRecord {
  return { purpose: "point-your-domain", name: "hp-test", type: "CNAME", value: CLOUDFRONT, ...over };
}

const ZONE: HostedZoneRef = { id: "Z123", name: "example.net" };

interface FakeZoneOptions {
  zone?: HostedZoneRef | null;
  zoneError?: Error;
  verdict?: (name: string, target: string) => NameVerdict;
  classifyError?: Error;
  writeError?: Error;
}

/** A stand-in for dns.ts: it records what it was asked and answers from the test's script. */
class FakeZones implements ZoneAccess {
  readonly writes: { record: RecordWrite; replaceExisting: boolean }[] = [];
  readonly classified: { name: string; target: string }[] = [];
  readonly looked: string[] = [];

  constructor(private readonly opts: FakeZoneOptions = {}) {}

  async findZone(domain: string): Promise<HostedZoneRef | null> {
    this.looked.push(domain);
    if (this.opts.zoneError) throw this.opts.zoneError;
    return this.opts.zone === undefined ? ZONE : this.opts.zone;
  }

  async classify(_zone: HostedZoneRef, name: string, target: string): Promise<NameVerdict> {
    this.classified.push({ name, target });
    if (this.opts.classifyError) throw this.opts.classifyError;
    return this.opts.verdict ? this.opts.verdict(name, target) : { state: "free" };
  }

  async write(_zone: HostedZoneRef, record: RecordWrite, replaceExisting: boolean): Promise<string> {
    if (this.opts.writeError) throw this.opts.writeError;
    this.writes.push({ record, replaceExisting });
    return `C${this.writes.length}`;
  }
}

describe("describeDomainCheck — the sentence somebody reads before anything is created", () => {
  it("offers to do it when nothing else uses the name", () => {
    const check = describeDomainCheck(facts({ zone: ZONE }));
    expect(check.managedHere).toBe(true);
    expect(check.canWrite).toBe(true);
    expect(check.willOverwrite).toBe(false);
    expect(check.zone).toEqual(ZONE);
    expect(check.message).toMatch(/Nothing else uses hp-test\.example\.net/);
  });

  it("explains the wildcard rather than reporting a conflict — this is the live failure", () => {
    const check = describeDomainCheck(
      facts({
        zone: ZONE,
        state: "shadowed-by-wildcard",
        existing: { name: "*.example.net", type: "A", values: ["35.219.200.108"] },
      }),
    );
    // A specific record always wins, so this is safe: the promise that every OTHER address
    // keeps working is the whole reason the user can press the button without worrying.
    expect(check.canWrite).toBe(true);
    expect(check.willOverwrite).toBe(false);
    expect(check.existing?.values).toEqual(["35.219.200.108"]);
    expect(check.message).toContain("*.example.net");
    expect(check.message).toMatch(/always wins/);
    expect(check.message).toMatch(/every other address keeps working/i);
  });

  it("says where a name in use points today, and that nothing moves until the user says so", () => {
    const check = describeDomainCheck(
      facts({ zone: ZONE, state: "taken", existing: { name: "hp-test.example.net", type: "A", values: ["203.0.113.9"] } }),
    );
    expect(check.willOverwrite).toBe(true);
    expect(check.message).toContain("203.0.113.9");
    expect(check.message).toMatch(/nothing changes until you say so/i);
  });

  it("has nothing to offer when the name already points at this website", () => {
    const check = describeDomainCheck(facts({ zone: ZONE, state: "already-ours" }));
    expect(check.canWrite).toBe(false);
    expect(check.willOverwrite).toBe(false);
    expect(check.message).toMatch(/already points at this website/);
  });

  it("falls back to the copy-paste table whenever we could not look", () => {
    for (const unknown of [facts({ state: "unknown" }), facts({ zone: ZONE, state: "unknown" })]) {
      const check = describeDomainCheck(unknown);
      expect(check.managedHere).toBe(false);
      expect(check.canWrite).toBe(false);
      expect(check.message).toMatch(/records to add wherever you bought your domain/);
    }
  });

  it("still reports what the internet answered when the zone told us nothing", () => {
    const check = describeDomainCheck(facts({ state: "unknown", answers: ["35.219.200.108"] }));
    expect(check.answers).toEqual(["35.219.200.108"]);
    expect(check.existing).toBeUndefined();
  });
});

describe("explainDomainFailure — the honest version of 'we couldn't finish connecting that address'", () => {
  function failed(over: Partial<DomainStatus> = {}): DomainStatus {
    return {
      domain: "hp-test.example.net",
      phase: "failed",
      records: [pointingRecord()],
      reason: "We couldn't finish connecting that address — remove it here and try adding it again.",
      detail: "Failed to verify ownership",
      ...over,
    };
  }

  it("names what the address actually answers — the failure that started DESIGN §3.3", () => {
    const explained = explainDomainFailure(failed(), ["35.219.200.108"]);
    expect(explained.reason).toBe(
      "hp-test.example.net currently answers 35.219.200.108, which is not this website — " +
        "point that exact name at the record below, then add the address again.",
    );
    // AWS's own words survive either way: the first live failure matched none of our sentences
    // and left nobody — user or author — anything to diagnose from.
    expect(explained.detail).toBe("Failed to verify ownership");
  });

  it("never accuses correct DNS of being wrong", () => {
    const same = explainDomainFailure(failed(), [`${CLOUDFRONT}.`, "203.0.113.1"]);
    expect(same.reason).toBe(failed().reason);
  });

  it("says nothing about the answers when there is nothing to compare them against", () => {
    expect(explainDomainFailure(failed({ records: [] }), ["35.219.200.108"]).reason).toBe(failed().reason);
    expect(explainDomainFailure(failed(), []).reason).toBe(failed().reason);
    expect(explainDomainFailure(failed(), ["  "]).reason).toBe(failed().reason);
  });

  it("leaves a domain that has not failed completely alone", () => {
    const waiting = failed({ phase: "pending-dns", reason: "Add the record below" });
    expect(explainDomainFailure(waiting, ["35.219.200.108"])).toEqual(waiting);
  });
});

describe("absoluteRecordName — Route 53 wants the whole name, Amplify sends three shapes", () => {
  it("completes a bare prefix, leaves a full name alone, and reads @ as the domain itself", () => {
    expect(absoluteRecordName("www", "example.com")).toBe("www.example.com");
    expect(absoluteRecordName("_a1b2.example.com", "example.com")).toBe("_a1b2.example.com");
    expect(absoluteRecordName("@", "example.com")).toBe("example.com");
    expect(absoluteRecordName("", "example.com")).toBe("example.com");
    expect(absoluteRecordName("WWW.Example.com.", "example.com")).toBe("www.example.com");
  });
});

describe("plannedWrites — what we can add, and what only the user can", () => {
  it("keeps a record we could not read out of the automated half", () => {
    const unreadable: DnsRecord = { purpose: "point-your-domain", name: "", type: "", value: "see the AWS console" };
    const { writable, manual } = plannedWrites([pointingRecord(), unreadable], "example.net");
    expect(writable).toEqual([
      { name: "hp-test.example.net", value: CLOUDFRONT, type: "CNAME", purpose: "point-your-domain" },
    ]);
    expect(manual).toEqual([unreadable]);
  });

  it("leaves a root domain's ANAME alone — offering it would fail halfway through", () => {
    const aname: DnsRecord = { purpose: "point-your-domain", name: "@", type: "ANAME", value: CLOUDFRONT };
    const { writable, manual } = plannedWrites([aname], "example.net");
    expect(writable).toEqual([]);
    expect(manual).toEqual([aname]);
  });
});

describe("planDomainRecords", () => {
  const certRecord: DnsRecord = {
    purpose: "certificate-validation",
    name: "_a1b2.example.net",
    type: "CNAME",
    value: "_c3d4.acm-validations.aws.",
  };

  it("touches Route 53 not at all when AWS is waiting on nothing", async () => {
    const zones = new FakeZones();
    const plan = await planDomainRecords(zones, "example.net", []);
    expect(zones.looked).toEqual([]);
    expect(plan.canWrite).toBe(false);
    expect(plan.message).toBe("There's nothing left to add for example.net.");
  });

  it("judges each record on its own name", async () => {
    const zones = new FakeZones({
      verdict: (name) => (name === "_a1b2.example.net" ? { state: "already-ours" } : { state: "free" }),
    });
    const plan = await planDomainRecords(zones, "example.net", [certRecord, pointingRecord()]);

    expect(zones.classified).toEqual([
      { name: "_a1b2.example.net", target: "_c3d4.acm-validations.aws." },
      { name: "hp-test.example.net", target: CLOUDFRONT },
    ]);
    expect(plan.unchanged.map((r) => r.name)).toEqual(["_a1b2.example.net"]);
    expect(plan.writable.map((r) => r.name)).toEqual(["hp-test.example.net"]);
    expect(plan.canWrite).toBe(true);
    expect(plan.zone).toBe("example.net");
    expect(plan.message).toMatch(/The rest are already in place/);
  });

  it("flags the name it would take off something else", async () => {
    const zones = new FakeZones({
      verdict: () => ({ state: "taken", existing: { name: "hp-test.example.net", type: "A", values: ["203.0.113.9"] } }),
    });
    const plan = await planDomainRecords(zones, "example.net", [pointingRecord()]);

    expect(plan.moves).toEqual([{ name: "hp-test.example.net", from: ["203.0.113.9"], to: CLOUDFRONT }]);
    expect(plan.message).toContain("203.0.113.9");
    expect(plan.message).toMatch(/nothing changes until you say so/i);
  });

  it("offers nothing when everything AWS wants is already in place", async () => {
    const zones = new FakeZones({ verdict: () => ({ state: "already-ours" }) });
    const plan = await planDomainRecords(zones, "example.net", [pointingRecord()]);
    expect(plan.canWrite).toBe(false);
    expect(plan.writable).toEqual([]);
    expect(plan.message).toMatch(/already in place/);
  });

  it("withdraws the whole offer when one name could not be read", async () => {
    const zones = new FakeZones({ classifyError: new Error("Rate exceeded") });
    const plan = await planDomainRecords(zones, "example.net", [certRecord, pointingRecord()]);
    expect(plan.canWrite).toBe(false);
    expect(plan.writable).toEqual([]);
    expect(plan.message).toMatch(/records to add wherever you bought your domain/);
    expect(plan.detail).toMatch(/Rate exceeded/);
  });

  it("keeps a record we can't write in the user's own hands, and says what they can do", async () => {
    const odd: DnsRecord = { purpose: "point-your-domain", name: "", type: "", value: "ask AWS" };
    const zones = new FakeZones();
    const plan = await planDomainRecords(zones, "example.net", [odd]);
    expect(zones.looked).toEqual([]);
    expect(plan.canWrite).toBe(false);
    expect(plan.manual).toEqual([odd]);
    expect(plan.message).toBe(
      "We can't add that record for you — copy it to your DNS host, or use an address like www.example.net and we'll set that one up for you.",
    );
  });
});

describe("writeDomainRecords — the one call that changes what the internet reads", () => {
  it("writes the records and says which zone they went into", async () => {
    const zones = new FakeZones({ verdict: () => ({ state: "free" }) });
    const done = await writeDomainRecords(zones, "example.net", [pointingRecord()]);

    expect(zones.writes.map((w) => w.record.name)).toEqual(["hp-test.example.net"]);
    expect(done.written.map((r) => r.value)).toEqual([CLOUDFRONT]);
    expect(done.moved).toEqual([]);
    expect(done.zone).toBe("example.net");
  });

  it("REFUSES to move a name in use until the user has said yes, and writes nothing", async () => {
    const zones = new FakeZones({
      verdict: () => ({ state: "taken", existing: { name: "hp-test.example.net", type: "A", values: ["203.0.113.9"] } }),
    });

    const err = await writeDomainRecords(zones, "example.net", [pointingRecord()]).catch((e: unknown) => e);

    expect(zones.writes).toEqual([]);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toBe(
      "hp-test.example.net points at 203.0.113.9 today — say yes to moving it to this website and we'll change it.",
    );
  });

  it("passes the user's yes down to the write, where dns.ts checks again at the last moment", async () => {
    const zones = new FakeZones({ verdict: () => ({ state: "free" }) });

    await writeDomainRecords(zones, "example.net", [pointingRecord()]);
    expect(zones.writes.map((w) => w.replaceExisting)).toEqual([false]);

    await writeDomainRecords(zones, "example.net", [pointingRecord()], { confirmOverwrite: true });
    // Not a formality: dns.ts re-reads the name before it writes and refuses to move it
    // without this, so dropping it here would fail the confirmed path with our own guard's
    // sentence coming from somewhere the user has already answered.
    expect(zones.writes.map((w) => w.replaceExisting)).toEqual([false, true]);
  });

  it("hands back Route 53's receipt for each change, so the wait screen can ask", async () => {
    const zones = new FakeZones({ verdict: () => ({ state: "free" }) });
    const done = await writeDomainRecords(zones, "example.net", [
      { purpose: "certificate-validation", name: "_a1b2.example.net", type: "CNAME", value: "_c3d4.acm-validations.aws." },
      pointingRecord(),
    ]);
    expect(done.changeIds).toEqual(["C1", "C2"]);
  });

  it("moves it once the user has said yes, and reports what was given up", async () => {
    const zones = new FakeZones({
      verdict: () => ({ state: "taken", existing: { name: "hp-test.example.net", type: "A", values: ["203.0.113.9"] } }),
    });

    const done = await writeDomainRecords(zones, "example.net", [pointingRecord()], { confirmOverwrite: true });

    expect(zones.writes).toHaveLength(1);
    expect(done.moved).toEqual([{ name: "hp-test.example.net", from: ["203.0.113.9"], to: CLOUDFRONT }]);
  });

  it("is a quiet success when everything is already in place — pressing twice is not a failure", async () => {
    const zones = new FakeZones({ verdict: () => ({ state: "already-ours" }) });
    const done = await writeDomainRecords(zones, "example.net", [pointingRecord()]);
    expect(zones.writes).toEqual([]);
    expect(done.written).toEqual([]);
    expect(done.unchanged).toHaveLength(1);
  });

  it("hands the user the records to paste when the zone is not in this account", async () => {
    const zones = new FakeZones({ zone: null });
    const err = await writeDomainRecords(zones, "example.net", [pointingRecord()]).catch((e: unknown) => e);
    expect(zones.writes).toEqual([]);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toMatch(/records to add wherever you bought your domain/);
  });

  it("leaves what it managed to write in place when AWS refuses halfway — upserts, so retry is safe", async () => {
    let calls = 0;
    const zones = new FakeZones({ verdict: () => ({ state: "free" }) });
    const failing: ZoneAccess = {
      findZone: (domain) => zones.findZone(domain),
      classify: (zone, name, target) => zones.classify(zone, name, target),
      write: async (zone, record, replaceExisting) => {
        if (++calls === 2) throw new Error("Rate exceeded");
        return zones.write(zone, record, replaceExisting);
      },
    };

    await expect(
      writeDomainRecords(failing, "example.net", [
        { purpose: "certificate-validation", name: "_a1b2.example.net", type: "CNAME", value: "_c3d4.acm-validations.aws." },
        pointingRecord(),
      ]),
    ).rejects.toThrow(/Rate exceeded/);
    expect(zones.writes.map((w) => w.record.name)).toEqual(["_a1b2.example.net"]);
  });
});

describe("siteTarget — what pointing at THIS website means", () => {
  it("is the record AWS asked for, which is the only one that can make the domain verify", () => {
    const site = siteFromApp(app(), "eu-west-1");
    const target = siteTarget(site, {
      domain: "hp-test.example.net",
      phase: "pending-dns",
      records: [pointingRecord(), { purpose: "certificate-validation", name: "_a1b2", type: "CNAME", value: "_c3d4.aws" }],
    });
    expect(target).toBe(CLOUDFRONT);
  });

  it("falls back to the site's own AWS address before any record exists", () => {
    expect(siteTarget(siteFromApp(app(), "eu-west-1"))).toBe("main.d1abc.amplifyapp.com");
    expect(siteTarget(siteFromApp(app(), "eu-west-1"), { domain: "x", phase: "verifying", records: [] })).toBe(
      "main.d1abc.amplifyapp.com",
    );
  });
});

describe("wwwSettings", () => {
  // www.example.com is NOT a second domain in AWS's model — it is a second prefix inside the
  // ONE attachment covering example.com. It can therefore only be decided when that
  // attachment is created: this poppy holds no UpdateDomainAssociation, so the alternative is
  // detach and re-attach. And adding the DNS by hand instead does not work — proven live on
  // 2026-09-12, where a www request reaching the right CloudFront came back
  // 403 {"message":"Forbidden"}: TLS was fine (AWS issues a wildcard), but CloudFront answers
  // only for names it was told about.
  it("covers www as well as the root, when asked", () => {
    expect(wwwSettings("", "main", true)).toEqual([
      { prefix: "", branchName: "main" },
      { prefix: "www", branchName: "main" },
    ]);
  });

  it("covers only the root when not asked", () => {
    expect(wwwSettings("", "main", false)).toEqual([{ prefix: "", branchName: "main" }]);
  });

  it("never adds www in front of a subdomain", () => {
    // Somebody who typed shop.example.com has already said which name they mean, and
    // www.shop.example.com is a name nobody wants.
    expect(wwwSettings("shop", "main", true)).toEqual([{ prefix: "shop", branchName: "main" }]);
    // Including the one that would read as www.www.example.com.
    expect(wwwSettings("www", "main", true)).toEqual([{ prefix: "www", branchName: "main" }]);
  });

  it("points every prefix at the branch that actually serves", () => {
    // A connected site's branch is whatever its repository calls it — both entries have to
    // follow it, or www would serve a branch that does not exist.
    expect(wwwSettings("", "release", true).every((s) => s.branchName === "release")).toBe(true);
  });
});
