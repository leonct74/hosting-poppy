import { describe, expect, it } from "vitest";
import { readFailure } from "./errors";

// Every string here is a real shape that reaches the frontend, not an invention: the host
// bridge wraps our backend's JSON reply in `backend <status>: `, our own code throws plain
// sentences, and a gateway between the two can answer with HTML that never saw our backend.

const FALLBACK = "We couldn't do that just now — try again in a moment.";

describe("the backend's reply, as the bridge hands it over", () => {
  it("shows the sentence the backend wrote and hides the AWS text", () => {
    const failure = readFailure(
      new Error('backend 500: {"message":"AWS is handling a lot of requests right now — wait a moment and try again.","detail":"ThrottlingException: Rate exceeded"}'),
      FALLBACK,
    );

    expect(failure.message).toBe("AWS is handling a lot of requests right now — wait a moment and try again.");
    expect(failure.detail).toBe("ThrottlingException: Rate exceeded");
  });

  it("leaves nothing of the envelope in the sentence", () => {
    // The whole defect, in one assertion: what the user reads must not contain the status,
    // the braces, or the field names (UX.md ground rule 5).
    const failure = readFailure(
      new Error('backend 400: {"message":"That name is a little long — keep it under 100 characters."}'),
      FALLBACK,
    );

    expect(failure.message).toBe("That name is a little long — keep it under 100 characters.");
    expect(failure.message).not.toMatch(/backend 400|[{}]|"message"/);
    expect(failure.detail).toBeUndefined();
  });

  it("reads the same reply when it arrives bare, without the bridge's prefix", () => {
    const failure = readFailure('{"message":"That website is busy right now.","detail":"ConflictException"}', FALLBACK);

    expect(failure.message).toBe("That website is busy right now.");
    expect(failure.detail).toBe("ConflictException");
  });

  it("uses the caller's sentence when a reply carries only the technical half", () => {
    const failure = readFailure(new Error('backend 500: {"detail":"InternalFailureException"}'), FALLBACK);

    expect(failure.message).toBe(FALLBACK);
    expect(failure.detail).toBe("InternalFailureException");
  });
});

describe("everything that isn't a reply", () => {
  it("passes a sentence somebody wrote straight through", () => {
    // A bridge timeout, or one of this frontend's own messages. Already written for a person.
    const failure = readFailure(new Error("AgentsPoppy didn't respond in time (invokeBackend)."), FALLBACK);

    expect(failure.message).toBe("AgentsPoppy didn't respond in time (invokeBackend).");
    expect(failure.detail).toBeUndefined();
  });

  it("takes a thrown string as that sentence too", () => {
    expect(readFailure("Nothing came through from that pick.", FALLBACK)).toEqual({
      message: "Nothing came through from that pick.",
    });
  });

  it("puts an unreadable body behind the disclosure rather than in the banner", () => {
    // A gateway or proxy answering instead of our backend: there is no sentence in there for
    // anybody, so the caller's one is all the user gets — and the HTML stays out of sight.
    const failure = readFailure(new Error("backend 502: <html>Bad Gateway</html>"), FALLBACK);

    expect(failure.message).toBe(FALLBACK);
    expect(failure.detail).toBe("<html>Bad Gateway</html>");
  });

  it("falls back when there is nothing to read at all", () => {
    expect(readFailure(new Error(""), FALLBACK)).toEqual({ message: FALLBACK });
    expect(readFailure(null, FALLBACK)).toEqual({ message: FALLBACK });
    expect(readFailure(undefined, FALLBACK)).toEqual({ message: FALLBACK });
  });

  it("doesn't mistake other JSON for a reply", () => {
    // `JSON.parse` succeeds on plenty of things that are not our `{ message, detail }` —
    // including `null`, which would throw on a property read if it weren't guarded.
    expect(readFailure("null", FALLBACK)).toEqual({ message: "null" });
    expect(readFailure("42", FALLBACK)).toEqual({ message: "42" });
    expect(readFailure('{"sites":[]}', FALLBACK)).toEqual({ message: '{"sites":[]}' });
  });
});
