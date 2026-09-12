import { describe, expect, it } from "vitest";
import {
  describeBytes,
  describeMonthlyUsd,
  estimateMonthlyCost,
  formatBytes,
  formatRelativeTime,
} from "./format";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe("sizes", () => {
  it("counts small things exactly", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(512)).toBe("512 bytes");
  });

  it("steps up a unit at a time", () => {
    expect(formatBytes(48 * KB)).toBe("48 KB");
    expect(formatBytes(4 * MB)).toBe("4 MB");
    expect(formatBytes(4.25 * MB)).toBe("4.3 MB");
    expect(formatBytes(48 * MB)).toBe("48 MB");
    expect(formatBytes(1.5 * GB)).toBe("1.5 GB");
  });

  it("says so rather than printing a broken number", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown");
    expect(formatBytes(-1)).toBe("unknown");
  });

  it("only says 'about' when there is something to approximate", () => {
    expect(describeBytes(4 * MB)).toBe("about 4 MB");
    expect(describeBytes(512)).toBe("512 bytes");
  });
});

describe("how long ago", () => {
  const now = new Date("2026-08-23T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("uses the words a person would", () => {
    expect(formatRelativeTime(ago(5_000), now)).toBe("just now");
    expect(formatRelativeTime(ago(70_000), now)).toBe("a minute ago");
    expect(formatRelativeTime(ago(20 * 60_000), now)).toBe("20 minutes ago");
    expect(formatRelativeTime(ago(2 * 3_600_000), now)).toBe("2 hours ago");
    expect(formatRelativeTime(ago(30 * 3_600_000), now)).toBe("yesterday");
    expect(formatRelativeTime(ago(5 * 86_400_000), now)).toBe("5 days ago");
  });

  it("becomes a date once 'N days ago' stops meaning anything", () => {
    expect(formatRelativeTime("2026-03-12T09:00:00Z", now)).toBe("on 12 Mar 2026");
  });

  it("never reads as a bug when the clock is a little ahead", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 30_000).toISOString(), now)).toBe("just now");
  });

  it("stays calm about a missing or unreadable timestamp", () => {
    expect(formatRelativeTime(undefined, now)).toBe("unknown");
    expect(formatRelativeTime("not a date", now)).toBe("unknown");
  });
});

describe("what AWS will charge for a static site", () => {
  it("adds storage and served traffic, and nothing else — an uploaded site is never built in AWS", () => {
    const e = estimateMonthlyCost({ storedBytes: 10 * GB, servedBytesPerMonth: 100 * GB });
    expect(e.storageUsd).toBeCloseTo(0.23, 5);
    expect(e.trafficUsd).toBeCloseTo(15, 5);
    expect(e.usd).toBeCloseTo(15.23, 5);
  });

  it("tells a small site the truth instead of a number", () => {
    const e = estimateMonthlyCost({ storedBytes: 20 * MB, servedBytesPerMonth: 500 * MB });
    expect(e.text).toBe("pennies — well under $1 a month");
  });

  it("celebrates the nothing-deployed-yet state", () => {
    expect(estimateMonthlyCost({ storedBytes: 0, servedBytesPerMonth: 0 }).text).toBe(
      "nothing — you aren't being billed for this yet",
    );
  });
});

describe("rounding money honestly", () => {
  it("gets coarser as the number gets bigger, so it never implies precision", () => {
    expect(describeMonthlyUsd(0.4)).toBe("pennies — well under $1 a month");
    expect(describeMonthlyUsd(0.8)).toBe("about $1 a month");
    expect(describeMonthlyUsd(3.87)).toBe("about $4 a month");
    expect(describeMonthlyUsd(23)).toBe("about $25 a month");
    expect(describeMonthlyUsd(147)).toBe("about $150 a month");
  });

  it("says unknown rather than printing nonsense", () => {
    expect(describeMonthlyUsd(Number.NaN)).toBe("unknown");
  });
});
