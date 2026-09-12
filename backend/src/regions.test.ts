import { describe, expect, it } from "vitest";
import { HOSTING_REGIONS, consoleUrlFor, regionNotSupportedMessage, regionSupported } from "./regions";

describe("HOSTING_REGIONS", () => {
  it("holds only well-formed, unique region ids, in order", () => {
    for (const region of HOSTING_REGIONS) expect(region).toMatch(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
    expect(new Set(HOSTING_REGIONS).size).toBe(HOSTING_REGIONS.length);
    expect([...HOSTING_REGIONS]).toEqual([...HOSTING_REGIONS].sort());
  });
});

describe("regionSupported", () => {
  it("recognises the regions we know host websites", () => {
    expect(regionSupported("eu-west-1")).toBe(true);
    expect(regionSupported("us-east-1")).toBe(true);
    expect(regionSupported("ap-southeast-2")).toBe(true);
  });

  it("says no to a region we have not confirmed, rather than guessing", () => {
    expect(regionSupported("eu-south-2")).toBe(false);
    expect(regionSupported("af-south-1")).toBe(false);
  });

  it("says no — never throws — for a missing or nonsense region", () => {
    expect(regionSupported(undefined)).toBe(false);
    expect(regionSupported(null)).toBe(false);
    expect(regionSupported("")).toBe(false);
    expect(regionSupported("somewhere else")).toBe(false);
    // AWS region ids are lowercase; anything else did not come from a connection.
    expect(regionSupported("EU-WEST-1")).toBe(false);
  });
});

describe("regionNotSupportedMessage", () => {
  it("names the region the user is actually on, and the one thing to do next", () => {
    const said = regionNotSupportedMessage("eu-south-2");
    expect(said).toContain("eu-south-2");
    expect(said).toMatch(/reconnect HostingPoppy/i);
    expect(said.endsWith(".")).toBe(true);
    expect(said).not.toContain("\n");
  });

  it("stays a sentence when we don't know where we are", () => {
    expect(regionNotSupportedMessage()).toMatch(/this region/i);
    expect(regionNotSupportedMessage("not a region")).toMatch(/this region/i);
  });

  it("only ever suggests regions that are actually on the supported list", () => {
    // Guards against the two lists drifting apart — a suggestion we cannot honour would
    // send the user to reconnect somewhere that still refuses them.
    const suggested = regionNotSupportedMessage("eu-south-2").match(/[a-z]{2}-[a-z]+-\d/g) ?? [];
    expect(suggested.length).toBeGreaterThan(1);
    for (const region of suggested.filter((r) => r !== "eu-south-2")) {
      expect(HOSTING_REGIONS).toContain(region);
    }
  });
});

describe("consoleUrlFor — the Resources tab's deep links", () => {
  it("links to the website itself", () => {
    expect(consoleUrlFor("eu-west-1", "d1a2b3c4d5")).toBe(
      "https://eu-west-1.console.aws.amazon.com/amplify/apps/d1a2b3c4d5",
    );
  });

  it("links to the live version's history", () => {
    expect(consoleUrlFor("us-east-1", "d1a2b3c4d5", { branch: "main" })).toBe(
      "https://us-east-1.console.aws.amazon.com/amplify/apps/d1a2b3c4d5/branches/main",
    );
  });

  it("links a custom domain to the settings page that owns it", () => {
    expect(consoleUrlFor("eu-west-1", "d1a2b3c4d5", { domain: "example.com" })).toBe(
      "https://eu-west-1.console.aws.amazon.com/amplify/apps/d1a2b3c4d5/settings/domains",
    );
  });

  it("prefers the domain page when asked for both", () => {
    expect(consoleUrlFor("eu-west-1", "d1", { branch: "main", domain: "example.com" })).toMatch(/settings\/domains$/);
  });

  it("escapes anything that would break the URL", () => {
    expect(consoleUrlFor("eu-west-1", "d1", { branch: "feature/one two" })).toBe(
      "https://eu-west-1.console.aws.amazon.com/amplify/apps/d1/branches/feature%2Fone%20two",
    );
    expect(consoleUrlFor("eu-west-1", "a b")).toContain("/apps/a%20b");
  });

  it("degrades to the region-less console rather than throwing on a nonsense region", () => {
    expect(consoleUrlFor("", "d1")).toBe("https://console.aws.amazon.com/amplify/apps/d1");
    expect(consoleUrlFor("not a region", "d1")).toBe("https://console.aws.amazon.com/amplify/apps/d1");
  });
});
