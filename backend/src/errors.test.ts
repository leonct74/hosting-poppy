import { describe, expect, it } from "vitest";
import {
  HttpError,
  deployFailedMessage,
  describeError,
  domainNotVerifiedMessage,
  friendlyError,
  isNotFound,
  isThrottling,
  rawDetail,
} from "./errors";

/** An error shaped the way the AWS SDK v3 throws them. */
function awsError(name: string, message: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(message), { name, $metadata: httpStatusCode ? { httpStatusCode } : {} });
}

describe("HttpError — a sentence already written for the user", () => {
  it("is a real Error carrying the status the route should answer with", () => {
    const e = new HttpError(400, "Type the domain you want to use, like example.com.");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(400);
    expect(e.name).toBe("HttpError");
  });

  it("passes straight through the mapper, untouched", () => {
    const said = "Give your website a name, so you can tell it apart from your others.";
    expect(friendlyError(new HttpError(400, said))).toBe(said);
  });

  it("offers no technical details — there is no hidden depth behind our own sentence", () => {
    expect(rawDetail(new HttpError(400, "Nope."))).toBeUndefined();
    expect(describeError(new HttpError(409, "Nope."))).toEqual({ status: 409, message: "Nope." });
  });
});

describe("friendlyError — the AgentsPoppy connection", () => {
  it("names the switch when the connection is paused", () => {
    const e = new Error("AgentsPoppy won't grant AWS access right now: connection is paused");
    expect(friendlyError(e)).toMatch(/paused in AgentsPoppy/i);
  });

  it("tells the user to reopen the poppy when the broker can't be reached", () => {
    expect(friendlyError(awsError("CredentialsProviderError", "Could not load credentials from any providers"))).toMatch(
      /reopen HostingPoppy from AgentsPoppy/i,
    );
    // boot.ts's own wording, restated in the dictionary's voice so the poppy has one voice.
    expect(friendlyError(new Error("HostingPoppy is waiting for AWS access from AgentsPoppy. (fetch failed)"))).toMatch(
      /reopen HostingPoppy from AgentsPoppy/i,
    );
  });

  it("explains a refused action without mentioning policies or scopes", () => {
    const said = friendlyError(awsError("UnauthorizedException", "User is not authorized to perform amplify:DeleteApp"));
    expect(said).toMatch(/wouldn't allow that/i);
    expect(said).not.toMatch(/amplify:|policy|scope/i);
    expect(friendlyError(awsError("SomeOtherException", "denied", 403))).toMatch(/wouldn't allow that/i);
  });
});

describe("friendlyError — what AWS is refusing", () => {
  it("explains a region that cannot host websites, and what to do about it", () => {
    const said = friendlyError(awsError("BadRequestException", "This region is not supported for this operation"));
    expect(said).toMatch(/can't host websites/i);
    expect(said).toMatch(/reconnect/i);
  });

  it("explains the account limit without quoting a number AWS could change", () => {
    const said = friendlyError(
      awsError("LimitExceededException", "Resource limit exceeded for app arn:aws:amplify:eu-west-1:111122223333:apps/d1"),
    );
    expect(said).toMatch(/limit for websites/i);
    expect(said).not.toMatch(/arn:aws|\d+/);
  });

  it("treats a missing website as already removed, not as a fault", () => {
    const said = friendlyError(awsError("NotFoundException", "No app found for appId d1a2b3"));
    expect(said).toMatch(/already been removed|already removed/i);
    expect(said).not.toMatch(/fail|error/i);
  });

  it("asks for patience when AWS is throttling us", () => {
    expect(friendlyError(awsError("ThrottlingException", "Rate exceeded"))).toMatch(/wait a moment/i);
    expect(friendlyError(awsError("TooManyRequestsException", "slow down", 429))).toMatch(/wait a moment/i);
  });

  it("separates a broken internet connection from a broken AWS account", () => {
    const said = friendlyError(Object.assign(new TypeError("fetch failed"), { name: "TypeError" }));
    expect(said).toMatch(/internet connection/i);
  });

  it("says plainly when the fault is AWS's own", () => {
    expect(friendlyError(awsError("InternalFailureException", "boom", 500))).toMatch(/problem on its side/i);
    expect(friendlyError(awsError("DependentServiceFailureException", "downstream"))).toMatch(/problem on its side/i);
    expect(friendlyError(awsError("WeirdException", "unavailable", 503))).toMatch(/problem on its side/i);
  });

  it("points at the technical details when AWS objects to the request itself", () => {
    expect(friendlyError(awsError("BadRequestException", "Invalid customRules"))).toMatch(/technical details/i);
  });

  it("explains a domain AWS has not confirmed yet as a wait, not a failure", () => {
    const said = friendlyError(awsError("BadRequestException", "Domain is PENDING_VERIFICATION"));
    expect(said).toMatch(/isn't confirmed yet/i);
    expect(said).toMatch(/stays live/i);
  });
});

describe("friendlyError — anything else", () => {
  it("falls back to one calm sentence that points at the details", () => {
    expect(friendlyError(new Error("kaboom"))).toMatch(/Something went wrong/i);
  });

  it("survives values that are not errors at all", () => {
    expect(friendlyError(undefined)).toMatch(/Something went wrong/i);
    expect(friendlyError(null)).toMatch(/Something went wrong/i);
    expect(friendlyError("a bare string")).toMatch(/Something went wrong/i);
    expect(friendlyError({ nothing: true })).toMatch(/Something went wrong/i);
  });

  it("never leaks raw AWS text into the sentence the user reads", () => {
    const leaky = awsError(
      "LimitExceededException",
      "Resource limit exceeded: arn:aws:amplify:eu-west-1:111122223333:apps/d1a2b3c4 (request 1a2b3c)",
    );
    const said = friendlyError(leaky);
    expect(said).not.toContain("arn:aws");
    expect(said).not.toContain("1a2b3c");
    // …but it is still available, one disclosure away.
    expect(rawDetail(leaky)).toContain("arn:aws");
  });
});

describe("every sentence the user can see", () => {
  const samples: unknown[] = [
    new Error("AgentsPoppy won't grant AWS access right now: connection is paused"),
    awsError("CredentialsProviderError", "no creds"),
    awsError("UnauthorizedException", "not authorized"),
    awsError("BadRequestException", "region is not supported"),
    awsError("LimitExceededException", "limit exceeded"),
    awsError("NotFoundException", "no app"),
    awsError("ThrottlingException", "Rate exceeded"),
    new TypeError("fetch failed"),
    awsError("BadRequestException", "domain PENDING_VERIFICATION"),
    awsError("InternalFailureException", "boom", 500),
    awsError("BadRequestException", "bad input"),
    new Error("kaboom"),
  ];

  it("is plain English, ends in a full stop, and fits on a card", () => {
    for (const e of samples) {
      const said = friendlyError(e);
      expect(said).not.toContain("\n");
      expect(said.endsWith(".")).toBe(true);
      expect(said.length).toBeLessThanOrEqual(220);
    }
  });

  it("uses none of the AWS words banned from a primary screen (UX.md)", () => {
    for (const e of [...samples, deployFailedMessage(), domainNotVerifiedMessage("example.com")]) {
      const said = typeof e === "string" ? e : friendlyError(e);
      expect(said).not.toMatch(/exception|amplify|cloudfront|bucket|distribution|\bstack\b|\bbranch\b|\bjob\b/i);
    }
  });
});

describe("the messages for states AWS reports rather than throws", () => {
  it("tells the user what to check when a deploy failed", () => {
    expect(deployFailedMessage()).toMatch(/index\.html/);
    expect(deployFailedMessage()).toMatch(/try again/i);
  });

  it("names the domain, the wait, and the reassurance", () => {
    const said = domainNotVerifiedMessage("example.com");
    expect(said.startsWith("example.com isn't confirmed yet")).toBe(true);
    expect(said).toMatch(/up to an hour/i);
    expect(said).toMatch(/stays live/i);
    expect(domainNotVerifiedMessage()).toMatch(/^Your domain isn't confirmed yet/);
  });
});

describe("isNotFound — on a delete this means success", () => {
  it("recognises both of Amplify's not-found errors", () => {
    expect(isNotFound(awsError("NotFoundException", "no app"))).toBe(true);
    expect(isNotFound(awsError("ResourceNotFoundException", "gone"))).toBe(true);
    expect(isNotFound(awsError("SomeException", "The app does not exist", 404))).toBe(true);
  });

  it("is not fooled by other failures", () => {
    expect(isNotFound(awsError("BadRequestException", "nope", 400))).toBe(false);
    expect(isNotFound(new Error("could not find the internet"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe("isThrottling — the caller should back off, not report", () => {
  it("recognises the shapes AWS throttles with", () => {
    expect(isThrottling(awsError("ThrottlingException", "Rate exceeded"))).toBe(true);
    expect(isThrottling(awsError("TooManyRequestsException", "slow down"))).toBe(true);
    expect(isThrottling(awsError("SomeException", "please retry", 429))).toBe(true);
  });

  it("is not fooled by other failures", () => {
    expect(isThrottling(awsError("NotFoundException", "no app"))).toBe(false);
    expect(isThrottling(null)).toBe(false);
  });
});

describe("rawDetail — the technical-details disclosure", () => {
  it("keeps the AWS error name alongside its message", () => {
    expect(rawDetail(awsError("LimitExceededException", "too many apps"))).toBe("LimitExceededException: too many apps");
  });

  it("omits a name that says nothing", () => {
    expect(rawDetail(new Error("plain trouble"))).toBe("plain trouble");
  });

  it("offers nothing when there is nothing to show, so the UI can drop the disclosure", () => {
    expect(rawDetail(new Error(""))).toBeUndefined();
    expect(rawDetail(undefined)).toBeUndefined();
  });

  it("caps a runaway message rather than pasting a wall of text into the UI", () => {
    const detail = rawDetail(awsError("BadRequestException", "x".repeat(5000)))!;
    expect(detail.length).toBeLessThanOrEqual(601);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("describeError — what a route hands back", () => {
  it("carries the human sentence and the raw text separately", () => {
    const reply = describeError(awsError("LimitExceededException", "too many apps"));
    expect(reply.message).toMatch(/limit for websites/i);
    expect(reply.detail).toBe("LimitExceededException: too many apps");
    expect(reply.status).toBe(500);
  });

  it("keeps an HttpError's own status", () => {
    expect(describeError(new HttpError(400, "Type a domain.")).status).toBe(400);
  });

  it("answers 429 for throttling and 403 for a refusal, so a client can retry sensibly", () => {
    expect(describeError(awsError("ThrottlingException", "Rate exceeded")).status).toBe(429);
    expect(describeError(awsError("SomeException", "denied", 403)).status).toBe(403);
  });

  it("never answers 404 — the bridge reads that as 'no such route'", () => {
    expect(describeError(awsError("NotFoundException", "no app", 404)).status).toBe(500);
  });
});

describe("a real AWS permission error (the first live run's regression)", () => {
  // Verbatim from the first live deploy against a real account. The assumed-role ARN contains
  // "AgentsPoppyBroker" and the connection id, so a rule matching the bare word "agentspoppy"
  // classified it as "the connection is unreachable" and told the user to reconnect — advice
  // that cannot fix a missing permission. Kept verbatim so the fixture can never drift from
  // what AWS actually sends.
  const REAL = Object.assign(new Error(
    "User: arn:aws:sts::123456789012:assumed-role/AgentsPoppyBroker/agentspoppy-00000000-0000-0000-0000-000000000000 " +
      "is not authorized to perform: amplify:TagResource on resource: arn:aws:amplify:eu-west-1:123456789012:apps/* " +
      "because no session policy allows the amplify:TagResource action",
  ), { name: "AccessDeniedException" });

  it("is reported as a permission problem, not as an unreachable connection", () => {
    const said = friendlyError(REAL);
    expect(said).toMatch(/wouldn't allow/i);
    expect(said).not.toMatch(/can't reach/i);
  });

  it("still recognises our own no-credentials sentence", () => {
    expect(friendlyError(new Error("HostingPoppy is waiting for AWS access from AgentsPoppy."))).toMatch(/can't reach/i);
  });
});
