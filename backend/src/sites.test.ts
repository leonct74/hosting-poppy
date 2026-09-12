import { describe, expect, it } from "vitest";
import {
  LIVE_BRANCH,
  amplifyAppName,
  defaultUrlFor,
  normalizeDomain,
  normalizeSiteName,
  parseDnsRecord,
  splitDomain,
  validateDomain,
  validateSiteName,
} from "./sites";

describe("normalizeSiteName", () => {
  it("collapses the whitespace a pasted name carries, without changing the words", () => {
    expect(normalizeSiteName("  My   Portfolio\n Site  ")).toBe("My Portfolio Site");
  });

  it("leaves an ordinary name alone", () => {
    expect(normalizeSiteName("My Portfolio")).toBe("My Portfolio");
  });
});

describe("validateSiteName", () => {
  it("accepts an ordinary name", () => {
    expect(validateSiteName("My Portfolio")).toBeNull();
    expect(validateSiteName("  Olly Digital ")).toBeNull();
    expect(validateSiteName("site-2")).toBeNull();
  });

  it("asks for a name when there isn't one", () => {
    expect(validateSiteName("")).toMatch(/name/i);
    expect(validateSiteName("   ")).toMatch(/name/i);
  });

  it("refuses a name longer than the list can show", () => {
    expect(validateSiteName("x".repeat(60))).toBeNull();
    expect(validateSiteName("x".repeat(61))).toMatch(/long/i);
  });

  it("refuses control characters, which only ever arrive by paste", () => {
    expect(validateSiteName("bell\u0007site")).toMatch(/characters/i);
    expect(validateSiteName("zero\u0000width")).toMatch(/characters/i);
  });

  it("refuses a name with no letter or number, which would sanitise away to nothing", () => {
    expect(validateSiteName("!!!")).toMatch(/letter or number/i);
    expect(validateSiteName("---")).toMatch(/letter or number/i);
  });

  it("answers in sentences, never in error codes", () => {
    for (const bad of ["", "x".repeat(80), "!!!"]) {
      const said = validateSiteName(bad)!;
      expect(said.endsWith(".")).toBe(true);
      expect(said).not.toMatch(/error|invalid|exception/i);
    }
  });
});

describe("amplifyAppName", () => {
  it("reduces a human name to what AWS accepts", () => {
    expect(amplifyAppName("My Portfolio")).toBe("My-Portfolio");
    expect(amplifyAppName("site_2 (final)")).toBe("site-2-final");
  });

  it("keeps accented letters as letters rather than dropping them", () => {
    expect(amplifyAppName("Café ☕")).toBe("Cafe");
  });

  it("never returns an empty name — an empty CreateApp fails at the AWS boundary", () => {
    expect(amplifyAppName("")).toBe("website");
    expect(amplifyAppName("!!!")).toBe("website");
    expect(amplifyAppName("   ")).toBe("website");
  });

  it("trims the hyphens the sanitiser leaves at either end", () => {
    expect(amplifyAppName("--My Site--")).toBe("My-Site");
  });

  it("stays inside Amplify's length ceiling, without a trailing hyphen from the cut", () => {
    const name = amplifyAppName(`${"a".repeat(254)} b`);
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith("-")).toBe(false);
    expect(amplifyAppName("x".repeat(400)).length).toBe(255);
  });
});

describe("defaultUrlFor", () => {
  it("builds the address AWS serves the live version at", () => {
    expect(defaultUrlFor(LIVE_BRANCH, "d1a2b3c4d5.amplifyapp.com")).toBe("https://main.d1a2b3c4d5.amplifyapp.com");
  });

  it("lowercases and strips stray dots so the host is always valid", () => {
    expect(defaultUrlFor("Main", ".D1A2.amplifyapp.com.")).toBe("https://main.d1a2.amplifyapp.com");
  });

  it("returns nothing when AWS hasn't given us a domain yet, so the UI can omit the link", () => {
    expect(defaultUrlFor(LIVE_BRANCH, undefined)).toBe("");
    expect(defaultUrlFor(LIVE_BRANCH, "  ")).toBe("");
    expect(defaultUrlFor("", "d1a2.amplifyapp.com")).toBe("");
  });
});

describe("normalizeDomain", () => {
  it("trims, lowercases, and drops the trailing dot DNS people type out of habit", () => {
    expect(normalizeDomain("  Example.COM. ")).toBe("example.com");
    expect(normalizeDomain("example.com...")).toBe("example.com");
  });
});

describe("validateDomain", () => {
  it("accepts real domains, however they were typed", () => {
    expect(validateDomain("example.com")).toBeNull();
    expect(validateDomain("  Example.COM. ")).toBeNull();
    expect(validateDomain("www.example.com")).toBeNull();
    expect(validateDomain("shop.example.co.uk")).toBeNull();
    expect(validateDomain("my-site.dev")).toBeNull();
    expect(validateDomain("a.b.c.example.com")).toBeNull();
  });

  it("asks for a domain when the box is empty", () => {
    expect(validateDomain("")).toMatch(/domain/i);
    expect(validateDomain("   ")).toMatch(/domain/i);
  });

  it("refuses a protocol instead of silently deleting it", () => {
    expect(validateDomain("https://example.com")).toMatch(/https:\/\//);
    expect(validateDomain("HTTP://Example.com")).toMatch(/https:\/\//);
    expect(validateDomain("//example.com")).toMatch(/https:\/\//);
  });

  it("refuses a path", () => {
    expect(validateDomain("example.com/blog")).toMatch(/nothing after it/i);
    expect(validateDomain("example.com/")).toMatch(/nothing after it/i);
  });

  it("refuses spaces and email addresses, naming what to type instead", () => {
    expect(validateDomain("my site.com")).toMatch(/spaces/i);
    expect(validateDomain("me@example.com")).toMatch(/email/i);
  });

  it("refuses something that cannot be a domain at all", () => {
    expect(validateDomain("localhost")).toMatch(/dot/i);
    expect(validateDomain(`${"a".repeat(250)}.com`)).toMatch(/longer than/i);
    expect(validateDomain("-bad.com")).toMatch(/doesn't look like a domain/i);
    expect(validateDomain("bad-.com")).toMatch(/doesn't look like a domain/i);
    expect(validateDomain("exa_mple.com")).toMatch(/doesn't look like a domain/i);
    expect(validateDomain("example.c")).toMatch(/doesn't look like a domain/i);
    expect(validateDomain("example..com")).toMatch(/doesn't look like a domain/i);
  });

  it("always answers with a sentence showing the shape it wants", () => {
    for (const bad of ["", "https://example.com", "example.com/blog", "my site.com", "localhost", "-bad.com"]) {
      const said = validateDomain(bad)!;
      expect(said.endsWith(".")).toBe(true);
      expect(said).toMatch(/example\.com|domain/);
    }
  });
});

describe("splitDomain — the domain the user OWNS, plus what sits in front of it", () => {
  it("treats a plain domain as the root, with no prefix", () => {
    expect(splitDomain("example.com")).toEqual({ root: "example.com", prefix: "" });
  });

  it("pulls www off the front", () => {
    expect(splitDomain("www.example.com")).toEqual({ root: "example.com", prefix: "www" });
  });

  it("handles a two-label ending like co.uk", () => {
    expect(splitDomain("shop.example.co.uk")).toEqual({ root: "example.co.uk", prefix: "shop" });
    expect(splitDomain("example.co.uk")).toEqual({ root: "example.co.uk", prefix: "" });
    expect(splitDomain("www.example.com.au")).toEqual({ root: "example.com.au", prefix: "www" });
    expect(splitDomain("blog.example.co.za")).toEqual({ root: "example.co.za", prefix: "blog" });
  });

  it("keeps a multi-level prefix whole", () => {
    expect(splitDomain("a.b.example.com")).toEqual({ root: "example.com", prefix: "a.b" });
    expect(splitDomain("a.b.example.co.uk")).toEqual({ root: "example.co.uk", prefix: "a.b" });
  });

  it("normalises case and a trailing dot first", () => {
    expect(splitDomain("WWW.Example.COM.")).toEqual({ root: "example.com", prefix: "www" });
  });

  it("does not invent a split it cannot make", () => {
    expect(splitDomain("")).toEqual({ root: "", prefix: "" });
    expect(splitDomain("   ")).toEqual({ root: "", prefix: "" });
    expect(splitDomain("localhost")).toEqual({ root: "localhost", prefix: "" });
    // A bare suffix has no registered name in front of it; hand it back whole and let AWS
    // refuse it, rather than guessing that "co" is somebody's domain.
    expect(splitDomain("co.uk")).toEqual({ root: "co.uk", prefix: "" });
  });

  it("gets an unlisted two-label ending wrong — the known limit of the built-in list", () => {
    // com.gt is a real two-label suffix we do not carry, so the split lands one label short.
    // This is exactly why the UI shows the user what we derived and lets them correct it:
    // an unowned root fails loudly at AWS, it never quietly hosts the wrong thing.
    expect(splitDomain("blog.example.com.gt")).toEqual({ root: "com.gt", prefix: "blog.example" });
  });
});

describe("parseDnsRecord — one whitespace-separated string from AWS, shown to a human", () => {
  it("reads a certificate-validation record, keeping the value byte-for-byte", () => {
    expect(parseDnsRecord("_a1b2.example.com CNAME _c3d4.xyz.acm-validations.aws.", "certificate-validation")).toEqual({
      purpose: "certificate-validation",
      name: "_a1b2.example.com",
      type: "CNAME",
      // the trailing dot stays: a value we "tidied" is a value that silently breaks the domain
      value: "_c3d4.xyz.acm-validations.aws.",
    });
  });

  it("reads a subdomain record", () => {
    expect(parseDnsRecord("www CNAME d111111abcdef8.cloudfront.net", "point-your-domain")).toEqual({
      purpose: "point-your-domain",
      name: "www",
      type: "CNAME",
      value: "d111111abcdef8.cloudfront.net",
    });
  });

  it("keeps whatever type AWS sent — a root domain cannot be a CNAME, so it answers ANAME or ALIAS", () => {
    expect(parseDnsRecord("example.com ANAME d111111abcdef8.cloudfront.net", "point-your-domain").type).toBe("ANAME");
    expect(parseDnsRecord("example.com ALIAS d111111abcdef8.cloudfront.net", "point-your-domain").type).toBe("ALIAS");
  });

  it("strips a trailing dot from the name, because registrar host fields reject one", () => {
    expect(parseDnsRecord("www.example.com. CNAME d1.cloudfront.net", "point-your-domain").name).toBe("www.example.com");
  });

  it("survives tabs, newlines and runs of spaces", () => {
    expect(parseDnsRecord("  www\tCNAME   d1.cloudfront.net \n", "point-your-domain")).toEqual({
      purpose: "point-your-domain",
      name: "www",
      type: "CNAME",
      value: "d1.cloudfront.net",
    });
  });

  it("keeps a value that legitimately contains spaces whole", () => {
    expect(parseDnsRecord('_x.example.com TXT "v=spf1 -all"', "certificate-validation").value).toBe('"v=spf1 -all"');
  });

  it("keeps the raw string as the value when the shape is unexpected, rather than guessing", () => {
    expect(parseDnsRecord("www CNAME", "point-your-domain")).toEqual({
      purpose: "point-your-domain",
      name: "",
      type: "",
      value: "www CNAME",
    });
    expect(parseDnsRecord("CNAME d1.cloudfront.net", "point-your-domain")).toEqual({
      purpose: "point-your-domain",
      name: "",
      type: "",
      value: "CNAME d1.cloudfront.net",
    });
    expect(parseDnsRecord("something-unexpected", "point-your-domain")).toEqual({
      purpose: "point-your-domain",
      name: "",
      type: "",
      value: "something-unexpected",
    });
    // The middle token has to look like a record type, or we are just splitting prose.
    expect(parseDnsRecord("www -> d1.cloudfront.net", "point-your-domain")).toEqual({
      purpose: "point-your-domain",
      name: "",
      type: "",
      value: "www -> d1.cloudfront.net",
    });
  });

  it("handles an empty answer without throwing", () => {
    expect(parseDnsRecord("", "certificate-validation")).toEqual({
      purpose: "certificate-validation",
      name: "",
      type: "",
      value: "",
    });
    expect(parseDnsRecord("   ", "certificate-validation").value).toBe("");
  });

  it("carries the purpose through untouched", () => {
    expect(parseDnsRecord("www CNAME x.net", "certificate-validation").purpose).toBe("certificate-validation");
    expect(parseDnsRecord("www CNAME x.net", "point-your-domain").purpose).toBe("point-your-domain");
  });
});
