import { describe, expect, it } from "vitest";
import { APP_ID, TAG_ACCOUNT, TAG_APP, TAG_CONNECTION, TAG_MANAGED, isOurs, resourceTags } from "./tags";

/**
 * `isOurs` is a safety interlock, not a formatting helper. `amplify:ListApps` is granted at
 * `*` scope — it has to be, since AWS gives listing no resource to scope to — so the sweep
 * that powers "Remove everything" sees EVERY hosting app in the account, including ones the
 * user built by hand. This predicate is the only thing standing between that list and
 * DeleteApp. Every case below is a website somebody could lose.
 */
describe("isOurs — the guard on everything we delete", () => {
  const ctx = { accountId: "123456789012", connectionId: "conn-1" };

  it("recognises an app we created", () => {
    expect(isOurs(resourceTags(ctx))).toBe(true);
  });

  it("refuses an app with no tags at all — the hand-made website case", () => {
    expect(isOurs(undefined)).toBe(false);
    expect(isOurs({})).toBe(false);
  });

  it("refuses another poppy's app, even though it carries AgentsPoppy's own tags", () => {
    expect(isOurs({ ...resourceTags(ctx), [TAG_APP]: "com.trafficpoppy.desktop" })).toBe(false);
  });

  it("refuses an app tagged by something else entirely", () => {
    expect(isOurs({ Name: "my-portfolio", Environment: "production" })).toBe(false);
  });

  it("does not accept a near-miss app id", () => {
    for (const near of [`${APP_ID} `, ` ${APP_ID}`, APP_ID.toUpperCase(), "com.hostingpoppy", "com.hostingpoppy.desktop.dev"]) {
      expect(isOurs({ [TAG_APP]: near })).toBe(false);
    }
  });

  it("identifies by the app tag alone, so an app outlives the connection that made it", () => {
    // Connections are superseded whenever the permission set changes, but the websites they
    // created must stay removable. Pinning ownership to the connection id would strand a
    // user's footprint the first time they re-approved the poppy.
    const older = { ...resourceTags(ctx), [TAG_CONNECTION]: "a-connection-from-last-year" };
    expect(isOurs(older)).toBe(true);
  });

  it("is not fooled by our marker tag without the app tag", () => {
    // `agentspoppy:managed` is a console convenience, not proof: anyone can write it.
    expect(isOurs({ [TAG_MANAGED]: "hostingpoppy" })).toBe(false);
  });
});

describe("resourceTags", () => {
  it("carries every key the host's sweep and our own credentials need", () => {
    const tags = resourceTags({ accountId: "123456789012", connectionId: "conn-9" });
    expect(tags).toEqual({
      [TAG_ACCOUNT]: "123456789012",
      [TAG_APP]: APP_ID,
      [TAG_CONNECTION]: "conn-9",
      [TAG_MANAGED]: "hostingpoppy",
    });
  });

  it("is a plain map, which is the shape Amplify's tags parameter takes", () => {
    // Most AWS APIs want [{ Key, Value }]. Amplify wants an object, and passing the array
    // form is accepted silently as an object with numeric keys — the resource is then born
    // untagged, invisible to teardown, and unreachable by our own scoped credentials.
    const tags = resourceTags({ accountId: "1", connectionId: "2" });
    expect(Array.isArray(tags)).toBe(false);
    expect(Object.values(tags).every((v) => typeof v === "string")).toBe(true);
  });
});
