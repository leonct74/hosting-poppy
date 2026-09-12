import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DomainStep, nextStepLine, splitDomain, worthChecking, type DomainWrite } from "./DomainStep";
import type { DnsWriteResult, DomainCheck, DomainStatus, Site } from "../types";

const SITE: Site = {
  id: "d1a2b3c4",
  name: "Olly Digital",
  defaultUrl: "https://main.d1a2b3c4.amplifyapp.com",
  createdAt: new Date().toISOString(),
  platform: "WEB",
};

const PENDING: DomainStatus = {
  domain: "www.example.com",
  phase: "pending-dns",
  records: [
    {
      purpose: "certificate-validation",
      name: "_a1b2.example.com",
      type: "CNAME",
      value: "_c3d4.xyz.acm-validations.aws.",
    },
    { purpose: "point-your-domain", name: "www", type: "CNAME", value: "d1a2b3c4.cloudfront.net" },
  ],
};

const LIVE: DomainStatus = {
  domain: "www.example.com",
  phase: "live",
  records: [],
  url: "https://www.example.com",
};

/**
 * AWS has given up. `reason` is the backend's own sentence for it (amplify.ts turns AWS's
 * `statusReason` into one of three), and on a failure it still hands back whatever was
 * outstanding — the record nobody added is the usual culprit.
 */
const FAILED: DomainStatus = {
  domain: "www.example.com",
  phase: "failed",
  records: [
    {
      purpose: "certificate-validation",
      name: "_a1b2.example.com",
      type: "CNAME",
      value: "_c3d4.xyz.acm-validations.aws.",
    },
  ],
  reason:
    "Your address wasn't confirmed in time, which usually means the record never reached the internet — remove it here and add it again once the record is live.",
};

/** No domain attached yet — the state a first-time user starts in. */
const none = () => vi.fn().mockResolvedValue(null);

// ── Reading the zone before touching a domain (DESIGN §3.3) ────────────────────────────────
//
// Five answers, five different screens. They are built from one base so that what each test
// is actually about — the ONE field that differs — is the only thing written out.

const ZONE_BASE: DomainCheck = {
  address: "www.example.com",
  root: "example.com",
  prefix: "www",
  zone: { id: "Z1EXAMPLE", name: "example.com" },
  state: "free",
  answers: [],
  managedHere: true,
  canWrite: true,
  willOverwrite: false,
  message: "Nothing else uses www.example.com, so we can point it at this website for you.",
};

/** Nothing claims the name: the offer, at its simplest. */
const FREE: DomainCheck = ZONE_BASE;

/** The zone is in somebody else's account — today's copy-paste path, and most of the world. */
const ELSEWHERE: DomainCheck = {
  ...ZONE_BASE,
  zone: undefined,
  state: "unknown",
  managedHere: false,
  canWrite: false,
  message:
    "We can't see the DNS for www.example.com from this AWS account, so we'll show you the records to add wherever you bought your domain.",
};

/** The live failure this whole section exists because of: a catch-all answers for everything. */
const WILDCARD: DomainCheck = {
  ...ZONE_BASE,
  state: "shadowed-by-wildcard",
  existing: { name: "*.example.com", type: "CNAME", values: ["old-app.web.app"] },
  answers: ["old-app.web.app"],
  message:
    "Your catch-all *.example.com record sends www.example.com to old-app.web.app. We'll add a record for this exact name, which always wins — every other address keeps working as it does now.",
};

/** The dangerous one: a record at that exact name, pointing at something the user is using. */
const TAKEN: DomainCheck = {
  ...ZONE_BASE,
  state: "taken",
  existing: { name: "www.example.com", type: "CNAME", values: ["shop.oldhost.net"] },
  answers: ["shop.oldhost.net"],
  willOverwrite: true,
  message:
    "Something already uses www.example.com. It points at shop.oldhost.net today. Connecting it here moves it to this website, so nothing changes until you say so.",
};

/** It already points here. There is nothing to offer, and offering anything would be noise. */
const OURS: DomainCheck = {
  ...ZONE_BASE,
  state: "already-ours",
  canWrite: false,
  existing: { name: "www.example.com", type: "CNAME", values: ["d1a2b3c4.cloudfront.net"] },
  answers: ["d1a2b3c4.cloudfront.net"],
  message: "www.example.com already points at this website — there's nothing left to change.",
};

/** The screen's own look-up, injected, with the debounce switched off. */
const zone = (check: DomainCheck) => ({
  checkAddress: vi.fn().mockResolvedValue(check),
  checkAfterMs: 0,
});

/**
 * The zone read for the tests that are about something else.
 *
 * "Managed somewhere else" is the honest default: it is exactly what this screen did before
 * any of §3.3 existed, it is what most of the world's domains look like, and it keeps a real
 * bridge call out of tests that never asked for one.
 */
const quiet = () => zone(ELSEWHERE);

/** A write that put everything in. `manual` empty is what "nothing left for you to do" means. */
const WROTE: DnsWriteResult = {
  written: ["www.example.com", "_a1b2.example.com"],
  manual: [],
  changeId: "C1234",
  state: "pending",
};

const wrote = (write: DnsWriteResult = WROTE) =>
  vi.fn().mockResolvedValue({ domain: PENDING, write });

describe("splitDomain — the domain you own, and what sits in front of it", () => {
  it("reads a plain domain as owned, with nothing in front", () => {
    expect(splitDomain("example.com")).toEqual({ root: "example.com", prefix: "" });
  });

  it("pulls a prefix off the front", () => {
    expect(splitDomain("www.example.com")).toEqual({ root: "example.com", prefix: "www" });
    expect(splitDomain("a.b.example.com")).toEqual({ root: "example.com", prefix: "a.b" });
  });

  it("knows the two-word endings AWS would otherwise refuse", () => {
    expect(splitDomain("shop.example.co.uk")).toEqual({ root: "example.co.uk", prefix: "shop" });
    expect(splitDomain("example.co.uk")).toEqual({ root: "example.co.uk", prefix: "" });
    expect(splitDomain("www.example.com.au")).toEqual({ root: "example.com.au", prefix: "www" });
  });

  it("shrugs off the case and the trailing dot people type out of habit", () => {
    expect(splitDomain("WWW.Example.COM.")).toEqual({ root: "example.com", prefix: "www" });
  });

  it("invents no split when there is nothing to split", () => {
    expect(splitDomain("")).toEqual({ root: "", prefix: "" });
    expect(splitDomain("co.uk")).toEqual({ root: "co.uk", prefix: "" });
  });
});

describe("S7 — the domain screen a beginner is most likely to fail on", () => {
  it("says the site is already live, and stays live, before asking for anything", async () => {
    render(<DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText(/stays live on that address the whole time/i)).toBeInTheDocument();
    expect(screen.getByText("main.d1a2b3c4.amplifyapp.com")).toBeInTheDocument();
  });

  it("forces the domain to lowercase as it is typed", async () => {
    // A capitalised domain broke the lookup in a sibling poppy, and a phone keyboard
    // capitalises the first letter of every field by default.
    render(<DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...quiet()} />);
    const input = await screen.findByLabelText(/the domain you want people to type/i);

    await userEvent.type(input, "WWW.Example.COM");

    expect(input).toHaveValue("www.example.com");
    expect(input).toHaveAttribute("autocapitalize", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it("shows what it read as the domain you own, and admits that is a guess", async () => {
    render(<DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...quiet()} />);
    const input = await screen.findByLabelText(/the domain you want people to type/i);

    await userEvent.type(input, "shop.example.co.uk");

    expect(screen.getByText("example.co.uk")).toBeInTheDocument();
    expect(screen.getByText("shop")).toBeInTheDocument();
    // The admission, and the consequence of getting it wrong, in the user's words.
    expect(screen.getByText(/not the domain you bought\?/i)).toBeInTheDocument();
    expect(screen.getByText(/our list of them can't be complete/i)).toBeInTheDocument();
  });

  it("offers the correction as a button, not as advice to retype it", async () => {
    render(<DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...quiet()} />);
    const input = await screen.findByLabelText(/the domain you want people to type/i);
    await userEvent.type(input, "shop.example.co.uk");

    await userEvent.click(screen.getByRole("button", { name: /use example\.co\.uk on its own/i }));

    expect(input).toHaveValue("example.co.uk");
  });

  it("catches a pasted URL before it becomes an AWS error", async () => {
    render(<DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...quiet()} />);
    const input = await screen.findByLabelText(/the domain you want people to type/i);

    await userEvent.type(input, "https://example.com");

    expect(screen.getByText(/type just the domain — example\.com — with no https/i)).toBeInTheDocument();
  });

  describe("also pointing www here", () => {
    // The founder's call (2026-09-12): the user decides, rather than it happening silently.
    // Ticked by default, because the cost is asymmetric — an unwanted www points at your own
    // site, a missing one gives your visitors an error.
    const typeRoot = async () => {
      const input = await screen.findByLabelText(/the domain you want people to type/i);
      await userEvent.type(input, "example.com");
    };

    it("offers it for a root domain, already ticked", async () => {
      render(<DomainStep site={SITE} load={none()} attach={vi.fn()} openExternal={vi.fn()} {...quiet()} />);
      await typeRoot();

      const box = screen.getByRole("checkbox", { name: /www\.example\.com/i });
      expect(box).toBeChecked();
    });

    it("sends the answer with the address, because it can never be changed afterwards", async () => {
      const attach = vi.fn(async () => LIVE);
      render(<DomainStep site={SITE} load={none()} attach={attach} openExternal={vi.fn()} {...quiet()} />);
      await typeRoot();

      await userEvent.click(screen.getByRole("button", { name: /use this domain/i }));
      expect(attach).toHaveBeenCalledWith("example.com", true);
    });

    it("respects unticking it", async () => {
      const attach = vi.fn(async () => LIVE);
      render(<DomainStep site={SITE} load={none()} attach={attach} openExternal={vi.fn()} {...quiet()} />);
      await typeRoot();

      await userEvent.click(screen.getByRole("checkbox", { name: /www\.example\.com/i }));
      await userEvent.click(screen.getByRole("button", { name: /use this domain/i }));
      expect(attach).toHaveBeenCalledWith("example.com", false);
    });

    it("says the choice is permanent, where the choice is made", async () => {
      // Changing it later means removing and re-adding the domain, and adding the record by
      // hand does not work — AWS answers only for names it was told about. Somebody who
      // unticks this without knowing that has been misled by silence.
      render(<DomainStep site={SITE} load={none()} attach={vi.fn()} openExternal={vi.fn()} {...quiet()} />);
      await typeRoot();

      expect(screen.getByText(/only be decided now/i)).toBeInTheDocument();
      expect(screen.getByText(/adding the record yourself afterwards doesn't work/i)).toBeInTheDocument();
    });

    it("is not offered for a subdomain", async () => {
      render(<DomainStep site={SITE} load={none()} attach={vi.fn()} openExternal={vi.fn()} {...quiet()} />);
      const input = await screen.findByLabelText(/the domain you want people to type/i);
      await userEvent.type(input, "shop.example.com");

      expect(screen.queryByRole("checkbox", { name: /www\./i })).toBeNull();
    });
  });

  it("spins the button while AWS is taking the domain, and can't be fired twice", async () => {
    let release!: (value: DomainStatus) => void;
    const attach = vi.fn(() => new Promise<DomainStatus>((resolve) => (release = resolve)));
    render(<DomainStep site={SITE} load={none()} attach={attach} openExternal={vi.fn()} {...quiet()} />);

    const input = await screen.findByLabelText(/the domain you want people to type/i);
    await userEvent.type(input, "www.example.com");
    await userEvent.click(screen.getByRole("button", { name: /use this domain/i }));

    const busy = screen.getByRole("button", { name: /setting it up…/i });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toBeDisabled();

    await userEvent.click(busy);
    expect(attach).toHaveBeenCalledOnce();
    // Second argument: whether www should ALSO be pointed here. False for this one, and that
    // is the point — the address typed IS a subdomain, so there is no www to add in front of
    // it, and www.www.example.com is a name nobody wants.
    expect(attach).toHaveBeenCalledWith("www.example.com", false);

    release(PENDING);
    expect(await screen.findByText(/Waiting for DNS/i)).toBeInTheDocument();
  });

  it("explains what DNS is, in one sentence, naming the real thing", async () => {
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(PENDING)} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText(/the internet's address book/i)).toBeInTheDocument();
    expect(screen.getByText(/usually on a page called/i)).toBeInTheDocument();
  });

  it("lays the records out exactly as AWS gave them, each with its own copy button", async () => {
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(PENDING)} openExternal={vi.fn()} {...quiet()} />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("_a1b2.example.com")).toBeInTheDocument();
    expect(within(table).getByText("_c3d4.xyz.acm-validations.aws.")).toBeInTheDocument();
    expect(within(table).getByText("d1a2b3c4.cloudfront.net")).toBeInTheDocument();
    expect(within(table).getByText(/proves the domain is yours/i)).toBeInTheDocument();
    expect(within(table).getByText(/points your domain at your site/i)).toBeInTheDocument();

    // One per name and one per value: both halves are typed by hand at the registrar.
    expect(within(table).getAllByRole("button", { name: /copy the name/i })).toHaveLength(2);
    expect(within(table).getAllByRole("button", { name: /copy the value/i })).toHaveLength(2);
  });

  it("shows a record AWS wouldn't split verbatim rather than reshaping it", async () => {
    // Being visibly unhelpful beats being invisibly wrong: a record we rearranged wrongly
    // breaks somebody's domain with nothing on screen to explain it.
    const odd: DomainStatus = {
      domain: "example.com",
      phase: "verifying",
      records: [{ purpose: "certificate-validation", name: "", type: "", value: "something AWS said in one line" }],
    };
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(odd)} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText("something AWS said in one line")).toBeInTheDocument();
    expect(screen.getByText(/add this exactly as it is written/i)).toBeInTheDocument();
  });

  it("answers 'Check my DNS' instead of just stopping", async () => {
    const load = vi.fn().mockResolvedValue(PENDING);
    render(<DomainStep site={SITE} load={load} openExternal={vi.fn()} {...quiet()} />);
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: /check my dns/i }));

    expect(await screen.findByText(/not there yet — nothing is wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/stays live on its AWS address meanwhile/i)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2); // the mount read, then the check
  });

  it("celebrates the moment the domain lands, with the address to click", async () => {
    const load = vi.fn().mockResolvedValueOnce(PENDING).mockResolvedValue(LIVE);
    const openExternal = vi.fn().mockResolvedValue(undefined);
    render(<DomainStep site={SITE} load={load} openExternal={openExternal} {...quiet()} />);
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: /check my dns/i }));

    expect(await screen.findByText(/www\.example\.com is live\./i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /www\.example\.com/i }));
    expect(openExternal).toHaveBeenCalledWith("https://www.example.com");
  });

  it("never disconnects a domain on one bare click", async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(LIVE)} detach={detach} openExternal={vi.fn()} {...quiet()} />);
    await screen.findByText(/www\.example\.com is live\./i);

    await userEvent.click(screen.getByRole("button", { name: /disconnect…/i }));
    expect(detach).not.toHaveBeenCalled();

    // The second step names what happens — and what survives.
    expect(screen.getByText(/its free security certificate is deleted/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /disconnect it/i }));
    expect(detach).toHaveBeenCalledOnce();

    // Back to the empty form, ready to attach a different domain.
    expect(await screen.findByLabelText(/the domain you want people to type/i)).toBeInTheDocument();
  });

  it("keeps raw AWS text out of the sentence and behind the disclosure", async () => {
    const attach = vi.fn().mockRejectedValue(
      new Error('backend 400: {"message":"That domain isn\'t one you own — check it for typos.","detail":"BadRequestException: domain not owned"}'),
    );
    render(<DomainStep site={SITE} load={none()} attach={attach} openExternal={vi.fn()} {...quiet()} />);

    await userEvent.type(await screen.findByLabelText(/the domain you want people to type/i), "example.com");
    await userEvent.click(screen.getByRole("button", { name: /use this domain/i }));

    const banner = await screen.findByText(/that domain isn't one you own/i);
    expect(banner).not.toHaveTextContent(/BadRequestException/);
    expect(screen.getByText(/BadRequestException: domain not owned/).closest("details")).not.toBeNull();

    // And the button is usable again — never left spinning after a rejection.
    expect(screen.getByRole("button", { name: /use this domain/i })).toBeEnabled();
  });
});

describe("a domain AWS has given up on", () => {
  const failed = () => vi.fn().mockResolvedValue(FAILED);

  it("says what went wrong, and never that nothing is wrong", async () => {
    render(<DomainStep site={SITE} load={failed()} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText(/wasn't confirmed in time/i)).toBeInTheDocument();
    expect(screen.getByText("Needs a look")).toBeInTheDocument();

    // The defect this replaced: a failed domain wearing the waiting card's words, telling
    // the user nothing was wrong and that the app was still checking. Both were false.
    expect(screen.queryByText(/nothing is wrong/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/we'll keep checking/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for DNS/i)).not.toBeInTheDocument();
  });

  it("does not claim to be re-checking, because nothing is", async () => {
    render(<DomainStep site={SITE} load={failed()} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText(/Nothing is being checked any more/i)).toBeInTheDocument();
    expect(screen.queryByText(/Re-checks itself every half minute/i)).not.toBeInTheDocument();
    // A "Check my DNS" button here would poll AWS forever to learn the same thing.
    expect(screen.queryByRole("button", { name: /check my dns/i })).not.toBeInTheDocument();
  });

  it("names the likely cause and shows the record to compare it against", async () => {
    render(<DomainStep site={SITE} load={failed()} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText(/What usually causes this/i)).toBeInTheDocument();
    expect(screen.getByText(/added with a small difference: a stray space/i)).toBeInTheDocument();
    expect(screen.getByText(/Compare it with what you added/i)).toBeInTheDocument();

    const table = screen.getByRole("table");
    expect(within(table).getByText("_c3d4.xyz.acm-validations.aws.")).toBeInTheDocument();
  });

  it("says so plainly when AWS kept no record to compare against", async () => {
    const bare: DomainStatus = { ...FAILED, records: [] };
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(bare)} openExternal={vi.fn()} {...quiet()} />);

    expect(await screen.findByText(/nothing to compare against/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers exactly one way forward, and never on one bare click", async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    render(<DomainStep site={SITE} load={failed()} detach={detach} openExternal={vi.fn()} {...quiet()} />);
    await screen.findByText("Needs a look");

    // One action, not two competing ones: the generic disconnect panel stays away so a
    // single click can't open two confirmations at once.
    expect(screen.queryByText(/Disconnect this domain/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /remove it and try again/i }));
    expect(detach).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^remove it$/i }));
    expect(detach).toHaveBeenCalledOnce();

    // Back to the empty form, ready to add the same domain again once the record is fixed.
    expect(await screen.findByLabelText(/the domain you want people to type/i)).toBeInTheDocument();
  });

  it("keeps the technical view behind a disclosure", async () => {
    render(<DomainStep site={SITE} load={failed()} openExternal={vi.fn()} {...quiet()} />);
    await screen.findByText("Needs a look");

    const technical = screen.getByText(/aws domain status: failed/i);
    expect(technical.closest("details")).not.toBeNull();
    expect(technical).toHaveTextContent("address: www.example.com");
  });
});

describe("worthChecking — when an address is finished enough to look up", () => {
  it("waits for two whole labels", () => {
    expect(worthChecking("example.com")).toBe(true);
    expect(worthChecking("www.example.com")).toBe(true);
    expect(worthChecking("example")).toBe(false);
    expect(worthChecking("example.")).toBe(false);
    expect(worthChecking("")).toBe(false);
  });

  it("waits out a half-typed ending, because the half is a real domain too", () => {
    // `example.c` on the way to `example.com` would otherwise get a confident answer about
    // somebody else's name and show it under the user's own.
    expect(worthChecking("example.c")).toBe(false);
    expect(worthChecking("example..com")).toBe(false);
  });

  it("never looks up something that isn't an address", () => {
    expect(worthChecking("https://example.com")).toBe(false);
    expect(worthChecking("example.com/pricing")).toBe(false);
    expect(worthChecking("two words.com")).toBe(false);
  });
});

describe("nextStepLine — what we promise before anything is created", () => {
  it("offers to do it only when we actually can", () => {
    expect(nextStepLine(FREE)).toMatch(/we add what's needed to your domain for you/i);
    expect(nextStepLine(WILDCARD)).toMatch(/we add what's needed to your domain for you/i);
  });

  it("never promises the easy version of the dangerous one", () => {
    expect(nextStepLine(TAKEN)).toMatch(/exactly what uses that address today/i);
    expect(nextStepLine(TAKEN)).not.toMatch(/we add what's needed/i);
  });

  it("doesn't send somebody to a registrar for a domain we're already holding", () => {
    // OURS is managed here, so "add these wherever you bought the domain" would send them
    // looking for a form they never needed — the entries are in the account already open.
    expect(nextStepLine(OURS)).toMatch(/entry AWS still needs/i);
    expect(nextStepLine(OURS)).not.toMatch(/wherever you bought/i);
  });

  it("falls back to the copy-paste promise when we know nothing", () => {
    // Including before the look-up has answered: what this screen always did is the safe
    // thing to say, because it is true for every domain in the world.
    expect(nextStepLine(ELSEWHERE)).toMatch(/wherever you bought the domain/i);
    expect(nextStepLine(null)).toMatch(/wherever you bought the domain/i);
  });
});

/**
 * DESIGN §3.3 — the section written from a live failure. `hp-test.example.net` refused to
 * connect in under a minute because a catch-all `*.example.net` answered for every name under
 * it, so AWS asked whether the address pointed at its distribution, got a WRONG answer rather
 * than no answer, and gave up. The user would have read "We couldn't finish connecting that
 * address": true, useless, unactionable.
 *
 * These cover all five things a name can turn out to be, because each one is a different
 * screen — and the one that can take a live site down is the one with a gate in front of it.
 */
describe("reading the zone before touching a domain", () => {
  const pending = () => vi.fn().mockResolvedValue(PENDING);
  const typeAddress = async (value = "www.example.com") => {
    await userEvent.type(await screen.findByLabelText(/the domain you want people to type/i), value);
  };

  it("says it is looking, and never makes the user wait for it", async () => {
    let release!: (check: DomainCheck) => void;
    const checkAddress = vi.fn(() => new Promise<DomainCheck>((resolve) => (release = resolve)));
    render(
      <DomainStep
        site={SITE}
        load={none()}
        checkAddress={checkAddress}
        checkAfterMs={0}
        openExternal={vi.fn()}
      />,
    );
    await typeAddress();

    expect(await screen.findByText(/looking at what/i)).toBeInTheDocument();
    // The look-up is a courtesy, not a gate: the way forward stays open throughout.
    expect(screen.getByRole("button", { name: /use this domain/i })).toBeEnabled();

    release(FREE);
    expect(await screen.findByText(/nothing else uses www\.example\.com/i)).toBeInTheDocument();
    expect(checkAddress).toHaveBeenCalledWith("www.example.com");
  });

  it("nothing there — offers to add it, and says which choice is the recommended one", async () => {
    const writeRecord = wrote();
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={writeRecord}
        openExternal={vi.fn()}
        {...zone(FREE)}
      />,
    );

    const add = await screen.findByRole("button", { name: /add the record for me/i });
    expect(screen.getByRole("button", { name: /add it myself/i })).toBeInTheDocument();
    expect(screen.getByText(/recommended/i)).toBeInTheDocument();
    // The copy-paste table steps aside while the offer stands: a table of things to type,
    // under an offer to type them for you, is two contradictory instructions.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await userEvent.click(add);

    expect(writeRecord).toHaveBeenCalledOnce();
    expect(await screen.findByText(/done — it.s in your domain.s settings/i)).toBeInTheDocument();
    // And what we did is shown, rather than the instructions we no longer mean.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/this is what we added for you/i)).toBeInTheDocument();
    expect(screen.queryByText(/the internet's address book/i)).not.toBeInTheDocument();
  });

  it("reads the zone again after writing, rather than trusting its own write", async () => {
    const checkAddress = vi.fn().mockResolvedValue(FREE);
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={wrote()}
        checkAddress={checkAddress}
        checkAfterMs={0}
        openExternal={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /add the record for me/i }));

    await screen.findByText(/done — it.s in your domain.s settings/i);
    expect(checkAddress).toHaveBeenCalledTimes(2);
  });

  it("a wildcard answers for it — reassures, and never calls it a problem", async () => {
    render(<DomainStep site={SITE} load={pending()} openExternal={vi.fn()} {...zone(WILDCARD)} />);

    expect(await screen.findByText(/everything under example\.com goes to one place today/i)).toBeInTheDocument();
    expect(screen.getByText("*.example.com")).toBeInTheDocument();
    expect(screen.getByText("old-app.web.app")).toBeInTheDocument();
    // The whole point: a specific name wins, and NOTHING of theirs breaks.
    expect(
      screen.getByText(/every other address carries on working exactly as it does now/i),
    ).toBeInTheDocument();

    // Reassurance, not a warning — this case costs the user nothing, and colouring it amber
    // would teach them to fear the screen that is trying to calm them down.
    const panel = screen.getByText(/everything under example\.com goes to one place today/i).closest("div");
    expect(panel).toHaveClass("info");
    expect(panel).not.toHaveClass("warn");

    expect(screen.getByRole("button", { name: /add the record for me/i })).toBeInTheDocument();
  });

  it("already points somewhere else — names it, and will not write on one click", async () => {
    const writeRecord = wrote();
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={writeRecord}
        openExternal={vi.fn()}
        {...zone(TAKEN)}
      />,
    );

    expect(await screen.findByText(/something already uses www\.example\.com/i)).toBeInTheDocument();
    // Where it goes TODAY, by name — the fact that makes this a decision instead of a click.
    expect(screen.getByText("shop.oldhost.net")).toBeInTheDocument();
    expect(screen.getByText(/stops being reachable at that address/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /move www\.example\.com to this website/i }));
    expect(writeRecord).not.toHaveBeenCalled();

    // The second step names both ends of the move before anything happens.
    expect(await screen.findByText(/people typing it land here instead/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave it as it is/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^move it here$/i }));
    expect(writeRecord).toHaveBeenCalledOnce();
  });

  it("carries the user's yes to the backend, and never sends it unasked", async () => {
    // The backend REFUSES to move a name in use without `confirmOverwrite` — that refusal is
    // the last line of defence, and this flag may only ever be true because a person pressed
    // the second button. A free name must not send it at all.
    const writeRecord = wrote();
    const { unmount } = render(
      <DomainStep site={SITE} load={pending()} writeRecord={writeRecord} openExternal={vi.fn()} {...zone(FREE)} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /add the record for me/i }));
    expect(writeRecord).toHaveBeenCalledWith({ confirmOverwrite: false });
    unmount();

    const moving = wrote();
    render(
      <DomainStep site={SITE} load={pending()} writeRecord={moving} openExternal={vi.fn()} {...zone(TAKEN)} />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /move www\.example\.com to this website/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^move it here$/i }));

    expect(moving).toHaveBeenCalledWith({ confirmOverwrite: true });
  });

  it("says half a job is half a job, and leaves the rest on screen", async () => {
    // The backend reports what it could NOT write. Claiming "nothing left for you to do" over
    // an unwritten record would leave somebody waiting for a domain that can never come up.
    const leftover = PENDING.records[0]!;
    const writeRecord = wrote({
      written: ["www.example.com"],
      manual: [leftover],
      state: "pending",
    });
    render(
      <DomainStep site={SITE} load={pending()} writeRecord={writeRecord} openExternal={vi.fn()} {...zone(FREE)} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /add the record for me/i }));

    expect(await screen.findByText(/1 entry still need/i)).toBeInTheDocument();
    expect(screen.getByText(/we added what we could\. these are the ones we couldn't/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing left for you to type/i)).not.toBeInTheDocument();

    // Only the outstanding one — sending them back to re-type a record already in place is
    // how somebody breaks the half that was working.
    const table = screen.getByRole("table");
    expect(within(table).getByText(leftover.value)).toBeInTheDocument();
    expect(within(table).queryByText("d1a2b3c4.cloudfront.net")).not.toBeInTheDocument();
  });

  it("lets go of a move the user changes their mind about", async () => {
    const writeRecord = wrote();
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={writeRecord}
        openExternal={vi.fn()}
        {...zone(TAKEN)}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /move www\.example\.com to this website/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /leave it as it is/i }));

    expect(writeRecord).not.toHaveBeenCalled();
    expect(screen.queryByText(/people typing it land here instead/i)).not.toBeInTheDocument();
    expect(screen.getByText("shop.oldhost.net")).toBeInTheDocument();
  });

  it("no shortcut past the confirmation, wherever the press comes from", async () => {
    // The "changed your mind?" button appears after choosing to do it by hand. It writes
    // through the same door as the offer, so a name in use still meets its gate.
    const writeRecord = wrote();
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={writeRecord}
        openExternal={vi.fn()}
        {...zone(TAKEN)}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /add it myself/i }));
    await userEvent.click(screen.getByRole("button", { name: /add the record for me/i }));

    expect(writeRecord).not.toHaveBeenCalled();
    expect(await screen.findByText(/people typing it land here instead/i)).toBeInTheDocument();
  });

  it("already points here — says so, and offers nothing", async () => {
    render(<DomainStep site={SITE} load={pending()} openExternal={vi.fn()} {...zone(OURS)} />);

    expect(await screen.findByText(/already points at this website/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing for you to do about it/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add the record for me/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /move .* to this website/i })).not.toBeInTheDocument();
  });

  it("managed somewhere else — the records to paste, and where to paste them", async () => {
    render(<DomainStep site={SITE} load={pending()} openExternal={vi.fn()} {...zone(ELSEWHERE)} />);

    expect(await screen.findByText(/looked after somewhere else/i)).toBeInTheDocument();
    expect(screen.getByText(/add the entries below there, not in AWS/i)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    // Offering to do it for them would be a button that cannot work.
    expect(screen.queryByRole("button", { name: /add the record for me/i })).not.toBeInTheDocument();
  });

  it("promises the right next step before anything is created", async () => {
    // The sentence under the button is the one thing a beginner plans around, so it may not
    // say "go and paste two records" to somebody whose domain we can edit ourselves.
    const { unmount } = render(
      <DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...zone(FREE)} />,
    );
    await typeAddress();

    expect(await screen.findByText(/we add what's needed to your domain for you/i)).toBeInTheDocument();
    unmount();

    render(<DomainStep site={SITE} load={none()} openExternal={vi.fn()} {...zone(ELSEWHERE)} />);
    await typeAddress();

    expect(
      await screen.findByText(/two short entries to add wherever you bought the domain/i),
    ).toBeInTheDocument();
  });

  it("offers nothing while AWS still owes us the entries", async () => {
    // An offer to add nothing is a button that lies — and the entries take a minute to appear.
    const empty: DomainStatus = { ...PENDING, records: [] };
    render(
      <DomainStep site={SITE} load={vi.fn().mockResolvedValue(empty)} openExternal={vi.fn()} {...zone(FREE)} />,
    );

    expect(await screen.findByText(/hasn't given us the entries to add yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add the record for me/i })).not.toBeInTheDocument();
  });

  it("steps aside for somebody who would rather do it themselves — and leaves the door open", async () => {
    render(<DomainStep site={SITE} load={pending()} openExternal={vi.fn()} {...zone(FREE)} />);

    await userEvent.click(await screen.findByRole("button", { name: /add it myself/i }));

    expect(screen.queryByText(/we can add this for you/i)).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/the internet's address book/i)).toBeInTheDocument();
    // Somebody who opens their registrar, doesn't recognise the form and comes back should
    // find the offer still standing.
    expect(screen.getByRole("button", { name: /add the record for me/i })).toBeInTheDocument();
  });

  it("spins the offer while it writes, and can't be fired twice", async () => {
    let release!: (done: DomainWrite) => void;
    const writeRecord = vi.fn(() => new Promise<DomainWrite>((resolve) => (release = resolve)));
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={writeRecord}
        openExternal={vi.fn()}
        {...zone(FREE)}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /add the record for me/i }));

    const busy = screen.getByRole("button", { name: /adding it…/i });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toBeDisabled();

    await userEvent.click(busy);
    expect(writeRecord).toHaveBeenCalledOnce();

    release({ domain: PENDING, write: WROTE });
    expect(await screen.findByText(/done — it.s in your domain.s settings/i)).toBeInTheDocument();
  });

  it("hands the job back when the write is refused, entries and all", async () => {
    const writeRecord = vi.fn().mockRejectedValue(
      new Error(
        'backend 403: {"message":"AWS wouldn\'t let us change your domain\'s settings — add the entry by hand instead.","detail":"AccessDenied: not authorized"}',
      ),
    );
    render(
      <DomainStep
        site={SITE}
        load={pending()}
        writeRecord={writeRecord}
        openExternal={vi.fn()}
        {...zone(FREE)}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /add the record for me/i }));

    const banner = await screen.findByText(/wouldn't let us change your domain's settings/i);
    expect(banner).not.toHaveTextContent(/AccessDenied/);
    expect(screen.getByText(/AccessDenied: not authorized/).closest("details")).not.toBeNull();
    // The sentence says the entries are below, so they have to BE below.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add the record for me/i })).toBeEnabled();
  });

  it("a look-up we couldn't do stops nothing, and can be asked again", async () => {
    const checkAddress = vi.fn().mockRejectedValue(new Error("bridge said no"));
    render(
      <DomainStep
        site={SITE}
        load={none()}
        checkAddress={checkAddress}
        checkAfterMs={0}
        openExternal={vi.fn()}
      />,
    );
    await typeAddress();

    expect(await screen.findByText(/does today\. That stops nothing/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use this domain/i })).toBeEnabled();

    checkAddress.mockResolvedValue(FREE);
    await userEvent.click(screen.getByRole("button", { name: /look again/i }));

    expect(await screen.findByText(/nothing else uses www\.example\.com/i)).toBeInTheDocument();
  });

  it("says nothing at all about a half-typed address", async () => {
    const checkAddress = vi.fn().mockResolvedValue(FREE);
    render(
      <DomainStep
        site={SITE}
        load={none()}
        checkAddress={checkAddress}
        checkAfterMs={0}
        openExternal={vi.fn()}
      />,
    );
    await typeAddress("exam");

    expect(screen.queryByText(/looking at what/i)).not.toBeInTheDocument();
    expect(checkAddress).not.toHaveBeenCalled();
  });

  it("never looks at a domain AWS has already given up on", async () => {
    // That card has exactly one way forward, and a second offer beside it would be a
    // competing answer to a dead end.
    const checkAddress = vi.fn().mockResolvedValue(FREE);
    render(
      <DomainStep
        site={SITE}
        load={vi.fn().mockResolvedValue(FAILED)}
        checkAddress={checkAddress}
        checkAfterMs={0}
        openExternal={vi.fn()}
      />,
    );
    await screen.findByText("Needs a look");

    expect(checkAddress).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /add the record for me/i })).not.toBeInTheDocument();
  });
});

describe("copying a record value", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the value with no surrounding whitespace", async () => {
    // A DNS name pasted with one leading space is stored as a DIFFERENT name, serves
    // nothing, and looks completely normal in every UI. Trimming is not tidiness.
    const padded: DomainStatus = {
      domain: "example.com",
      phase: "pending-dns",
      records: [{ purpose: "point-your-domain", name: " www ", type: "CNAME", value: " d1a2b3c4.cloudfront.net " }],
    };
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(padded)} openExternal={vi.fn()} {...quiet()} />);

    await userEvent.click(await screen.findByRole("button", { name: /copy the value/i }));

    expect(writeText).toHaveBeenCalledWith("d1a2b3c4.cloudfront.net");
    expect(await screen.findByText(/✓ copied/)).toBeInTheDocument();
  });

  it("says so when the webview refuses the clipboard, rather than failing silently", async () => {
    // Inside the host's frame `clipboard-write` may not be delegated. A copy button that
    // quietly does nothing is a dead button (AGENTS.md §9).
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<DomainStep site={SITE} load={vi.fn().mockResolvedValue(PENDING)} openExternal={vi.fn()} {...quiet()} />);

    const buttons = await screen.findAllByRole("button", { name: /copy the value/i });
    await userEvent.click(buttons[0]!);

    expect(await screen.findByText(/select it by hand/i)).toBeInTheDocument();
  });
});
