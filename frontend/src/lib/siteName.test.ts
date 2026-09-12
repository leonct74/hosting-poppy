import { describe, expect, it } from "vitest";
// The backend's own function — the side that really names the website. Importing it is what
// makes the mirror in siteName.ts a mirror rather than a second opinion; sites.ts is pure
// (it touches no AWS and no Node API), which is why a frontend test can hold it to account.
import { amplifyAppName } from "../../../backend/src/sites";
import { renamedSiteName, storedSiteName } from "./siteName";

describe("the name AWS will store", () => {
  it("matches the backend, name for name", () => {
    const names = [
      "My Portfolio",
      "site_2 (final)",
      "Café ☕",
      "--My Site--",
      "Ольга",
      "shop.example",
      "a".repeat(300),
      "",
      "!!!",
      "   ",
    ];
    for (const name of names) {
      expect(storedSiteName(name), `disagreed about "${name}"`).toBe(amplifyAppName(name));
    }
  });

  it("never derives an empty name, whatever it is given", () => {
    expect(storedSiteName("!!!")).toBe("website");
    expect(storedSiteName("")).toBe("website");
  });
});

describe("warning the user before the name is set in stone", () => {
  it("shows the stored name whenever it differs from what was typed", () => {
    // Spaces become hyphens, which the site list will show from then on — so this fires for
    // most real names, and that is the point: nothing about it is a surprise afterwards.
    expect(renamedSiteName("My Portfolio")).toBe("My-Portfolio");
    expect(renamedSiteName("Café ☕")).toBe("Cafe");
    expect(renamedSiteName("shop.example")).toBe("shop-example");
  });

  it("stays quiet when the user's own words survive", () => {
    expect(renamedSiteName("Portfolio")).toBeNull();
    expect(renamedSiteName("my-portfolio")).toBeNull();
    // Trailing spaces are not a rename anybody needs to be told about.
    expect(renamedSiteName("  Portfolio  ")).toBeNull();
  });

  it("stays quiet where the backend will refuse the name in its own words", () => {
    // "website" is not what would happen — the create call never gets made — so promising
    // it would be wrong twice.
    expect(renamedSiteName("!!!")).toBeNull();
    expect(renamedSiteName("")).toBeNull();
    expect(renamedSiteName("   ")).toBeNull();
  });
});
