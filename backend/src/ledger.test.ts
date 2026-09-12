import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataPath, initStorage } from "./storage";
import { LEDGER_FILE, MAX_LEDGER_ENTRIES, isLedgerEntry, readLedger, record, recordAll } from "./ledger";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hp-ledger-"));
  initStorage(home);
});

describe("ledger", () => {
  it("starts empty and keeps what it is told, oldest first", () => {
    expect(readLedger()).toEqual([]);

    record({ action: "created", what: "Website “my-portfolio”" });
    record({ action: "deployed", what: "Website “my-portfolio”", detail: "job 4" });

    const entries = readLedger();
    expect(entries.map((e) => e.action)).toEqual(["created", "deployed"]);
    expect(entries[1]!.detail).toBe("job 4");
    expect(Number.isNaN(Date.parse(entries[0]!.at))).toBe(false);
  });

  it("keeps a timestamp the caller supplies — AWS knows when things happened better than we do", () => {
    record({ action: "domain-attached", what: "example.com", at: "2026-08-01T09:30:00.000Z" });
    expect(readLedger()[0]!.at).toBe("2026-08-01T09:30:00.000Z");
  });

  it("writes several entries in one go", () => {
    recordAll([
      { action: "removed", what: "Website “old-site”" },
      { action: "domain-removed", what: "old.example.com" },
    ]);
    expect(readLedger()).toHaveLength(2);
    expect(() => recordAll([])).not.toThrow();
    expect(readLedger()).toHaveLength(2);
  });

  it("reads a corrupt or foreign file as no history at all", () => {
    writeFileSync(join(home, LEDGER_FILE), "{{{ not json");
    expect(readLedger()).toEqual([]);

    writeFileSync(join(home, LEDGER_FILE), JSON.stringify({ notAnArray: true }));
    expect(readLedger()).toEqual([]);
  });

  it("drops entries it cannot vouch for and shows the rest", () => {
    writeFileSync(
      join(home, LEDGER_FILE),
      JSON.stringify([
        { at: "2026-08-01T00:00:00.000Z", action: "created", what: "Website “keep-me”" },
        "a bare string",
        null,
        { at: "2026-08-01T00:00:00.000Z", action: "exfiltrated", what: "Website “nope”" },
        { action: "created", what: "no timestamp" },
        { at: "2026-08-02T00:00:00.000Z", action: "removed", what: "Website “keep-me-too”", detail: 7 },
      ]),
    );
    expect(readLedger().map((e) => e.what)).toEqual(["Website “keep-me”"]);
  });

  it("recognises exactly the actions the Resources tab can render", () => {
    const base = { at: "2026-08-01T00:00:00.000Z", what: "Website “x”" };
    for (const action of ["created", "removed", "deployed", "domain-attached", "domain-removed"]) {
      expect(isLedgerEntry({ ...base, action })).toBe(true);
    }
    expect(isLedgerEntry({ ...base, action: "created", detail: "why" })).toBe(true);
    expect(isLedgerEntry({ ...base, action: "billed" })).toBe(false);
    expect(isLedgerEntry(undefined)).toBe(false);
  });

  it("caps the file so it cannot grow for ever, keeping the newest", () => {
    const overflow = MAX_LEDGER_ENTRIES + 20;
    recordAll(
      Array.from({ length: overflow }, (_, i) => ({ action: "deployed" as const, what: `deploy ${i}` })),
    );

    const entries = readLedger();
    expect(entries).toHaveLength(MAX_LEDGER_ENTRIES);
    expect(entries[0]!.what).toBe("deploy 20");
    expect(entries[MAX_LEDGER_ENTRIES - 1]!.what).toBe(`deploy ${overflow - 1}`);
  });

  it("swallows a write it cannot make — a deploy must not fail over a line of history", () => {
    const file = join(mkdtempSync(join(tmpdir(), "hp-ledger-bad-")), "a-file");
    writeFileSync(file, "x");
    initStorage(join(file, "not-a-folder")); // a data folder that can never exist
    expect(dataPath(LEDGER_FILE)).toBe(join(file, "not-a-folder", LEDGER_FILE));

    expect(() => record({ action: "created", what: "Website “doomed”" })).not.toThrow();
    expect(readLedger()).toEqual([]);
  });
});
