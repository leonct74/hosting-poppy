import { describe, expect, it } from "vitest";
import { CONSTRAINTS, MAX_SITE_MB, NAME_FIELD, SITE_TYPES, SOURCES, buildHelperPrompt } from "./helperPrompt";

// The helper prompt IS this poppy's onboarding, pasted into an AI we don't control (AGENTS.md
// §9). Its one job is to never disagree with the form: every option the form renders appears,
// in the form's own words. These tests fail the moment the catalogue and the prompt drift —
// which is the only way a generated prompt can go wrong, and the whole reason it is generated.

describe("the helper prompt", () => {
  const prompt = buildHelperPrompt();

  it("offers exactly the cards the form shows, in the form's own words", () => {
    for (const type of SITE_TYPES) {
      expect(prompt).toContain(type.label);
      expect(prompt).toContain(type.explain);
    }
  });

  it("says which card has no upload door, so the outside AI doesn't send anyone to one", () => {
    const repoOnly = SITE_TYPES.find((t) => t.fromRepoOnly);
    expect(repoOnly).toBeDefined();
    expect(prompt).toContain("GitHub only — there is no upload for this one");
    // And the answer shape makes the outside AI say so out loud, including the one exception
    // (a Next.js project set up for static export), rather than leaving the user to discover
    // the missing door on the screen after they have already chosen.
    expect(prompt).toMatch(/built from GitHub and there is no upload for it/);
    expect(prompt).toMatch(/static export/);
    // Nothing may still be advertised as unbuilt: that claim outlived the truth once already.
    expect(prompt).not.toContain("NOT AVAILABLE YET");
    expect(prompt).not.toMatch(/can't host it yet/);
  });

  it("offers both ways of handing the files over", () => {
    for (const source of SOURCES) {
      expect(prompt).toContain(source.label);
      expect(prompt).toContain(source.explain);
    }
  });

  it("names the one field the user types, with its example", () => {
    expect(prompt).toContain(NAME_FIELD.label);
    expect(prompt).toContain(NAME_FIELD.explain);
    expect(prompt).toContain(NAME_FIELD.placeholder);
  });

  it("states every constraint as a rule to plan within, not a preference", () => {
    for (const rule of CONSTRAINTS) expect(prompt).toContain(rule);
    expect(prompt).toMatch(/how the app works, not preferences/);
    expect(prompt).toContain(`${MAX_SITE_MB} MB`);
  });

  it("carries the constraints that decide whether the site works at all", () => {
    // A build the poppy can't run, and a site one folder deep, are the two failures that
    // produce a live website that is quietly broken.
    expect(prompt).toMatch(/can't run a build on your computer/);
    expect(prompt).toMatch(/index\.html has to be at the top/);
  });

  it("tells the truth about who charges what", () => {
    expect(prompt).toMatch(/MY OWN AWS account/);
    expect(prompt).toMatch(/HostingPoppy bills me nothing/);
    expect(prompt).toMatch(/remove everything it created with one click/);
  });

  it("demands a fixed answer shape, and allows a few questions first", () => {
    expect(prompt).toMatch(/at most three short questions first/);
    expect(prompt).toContain("ANSWER IN EXACTLY THIS SHAPE:");
    // Each numbered item maps onto something the user then types or presses.
    for (const item of ["1. Build first:", "2. Name to type:", "3. Which card:", "4. What to hand over:"]) {
      expect(prompt).toContain(item);
    }
  });

  it("ends mid-sentence, so the user's next words are the goal", () => {
    expect(prompt.endsWith("MY WEBSITE: ")).toBe(true);
  });
});
