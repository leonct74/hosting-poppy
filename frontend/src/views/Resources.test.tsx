import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Resources, groupBySite } from "./Resources";
import type { LedgerEntry, ResourceRow } from "../types";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const ROWS: ResourceRow[] = [
  {
    service: "Amplify Hosting",
    kind: "Website",
    name: "olly-digital",
    consoleUrl: "https://eu-west-1.console.aws.amazon.com/amplify/apps/d1a2b3c4",
    siteId: "d1a2b3c4",
  },
  {
    service: "Amplify Hosting",
    kind: "Live branch",
    name: "olly-digital / main",
    consoleUrl: "https://eu-west-1.console.aws.amazon.com/amplify/apps/d1a2b3c4/branches/main",
    siteId: "d1a2b3c4",
  },
  {
    service: "Amplify Hosting",
    kind: "Custom domain",
    name: "ollydigital.com",
    consoleUrl: "https://eu-west-1.console.aws.amazon.com/amplify/apps/d1a2b3c4/domains",
    siteId: "d1a2b3c4",
  },
];

// Stored oldest-first, the way a diary is written.
const LEDGER: LedgerEntry[] = [
  { at: ago(120), action: "created", what: "olly-digital" },
  { at: ago(60), action: "deployed", what: "olly-digital", detail: "4.2 MB uploaded" },
  { at: ago(5), action: "domain-attached", what: "ollydigital.com" },
];

const loader = (resources: ResourceRow[], ledger: LedgerEntry[] = []) =>
  vi.fn().mockResolvedValue({ resources, ledger });

describe("the Resources tab — the one screen where real AWS names belong", () => {
  it("leads with the promise it exists to keep", async () => {
    render(<Resources load={loader(ROWS, LEDGER)} openExternal={vi.fn()} />);
    expect(
      await screen.findByText(/Everything HostingPoppy created in your account — nothing hidden\./),
    ).toBeInTheDocument();
  });

  it("names every resource by its real AWS name, grouped under its website", async () => {
    // No ledger here on purpose: the timeline repeats the same names, and this test is
    // about what EXISTS (read from AWS) rather than about what happened.
    render(<Resources load={loader(ROWS)} openExternal={vi.fn()} />);

    // The heading is the WEBSITE, not the AWS service. Grouping by service put every row in
    // the account under one word, "Amplify Hosting", so a person could not count their own
    // websites — which is the question they came here with.
    expect(await screen.findByText("1 website in this account, and everything each one uses.")).toBeInTheDocument();
    expect(screen.queryByText("Amplify Hosting")).toBeNull();
    // Twice: once as the group's heading, once as the website's own row.
    expect(screen.getAllByText("olly-digital")).toHaveLength(2);
    expect(screen.getByText("olly-digital / main")).toBeInTheDocument();
    expect(screen.getByText("ollydigital.com")).toBeInTheDocument();
    // The kind, so a row is readable to somebody who has never seen the Amplify console.
    expect(screen.getByText("Website")).toBeInTheDocument();
    expect(screen.getByText("Live branch")).toBeInTheDocument();
    expect(screen.getByText("Custom domain")).toBeInTheDocument();
  });

  it("opens a row in the AWS console through the host — a sandboxed frame can't", async () => {
    // window.open is a silent no-op inside the host's webview, so a link that skips the
    // bridge is a dead link (AGENTS.md §9).
    const openExternal = vi.fn().mockResolvedValue(undefined);
    render(<Resources load={loader(ROWS)} openExternal={openExternal} />);

    const links = await screen.findAllByRole("button", { name: /open in AWS/i });
    expect(links).toHaveLength(ROWS.length); // every resource is reachable, not just the site
    await userEvent.click(links[0]!);

    expect(openExternal).toHaveBeenCalledWith(ROWS[0]!.consoleUrl);
  });

  it("shows the console address to copy when the host refuses to open it", async () => {
    // This screen's whole purpose is that the user can go and look for themselves, so a
    // link that quietly fails takes the promise with it.
    const openExternal = vi.fn().mockRejectedValue(new Error("no window"));
    render(<Resources load={loader([ROWS[0]!])} openExternal={openExternal} />);

    await userEvent.click(await screen.findByRole("button", { name: /open in AWS/i }));

    expect(await screen.findByText(ROWS[0]!.consoleUrl)).toBeInTheDocument();
  });

  it("says plainly when nothing exists — and that nothing is being billed", async () => {
    render(<Resources load={loader([], [])} openExternal={vi.fn()} />);

    expect(await screen.findByText(/hasn't created anything in your AWS account/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to bill and nothing to remove/i)).toBeInTheDocument();
  });

  it("shows the timeline newest-first, in the words used everywhere else", async () => {
    render(<Resources load={loader(ROWS, LEDGER)} openExternal={vi.fn()} />);

    const entries = await screen.findAllByRole("listitem");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent(/Domain connected · ollydigital\.com/);
    expect(entries[1]).toHaveTextContent(/New version put online · olly-digital/);
    expect(entries[2]).toHaveTextContent(/Website created · olly-digital/);
    // The extra note the ledger carried, and a time a person can picture.
    expect(entries[1]).toHaveTextContent(/4\.2 MB uploaded/);
    expect(entries[0]).toHaveTextContent(/minutes ago/);
  });

  it("keeps a removal visible after the thing itself is gone", async () => {
    // The whole reason there are two sources: AWS can only tell us what still exists.
    const ledger: LedgerEntry[] = [{ at: ago(3), action: "removed", what: "old-marketing-site" }];
    render(<Resources load={loader([], ledger)} openExternal={vi.fn()} />);

    expect(await screen.findByText(/hasn't created anything/i)).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(/Website removed · old-marketing-site/);
  });

  it("shows which account and region all of this is in, when it knows", async () => {
    render(
      <Resources
        load={loader(ROWS)}
        openExternal={vi.fn()}
        meta={{
          accountId: "123456789012",
          region: "eu-west-1",
          version: "0.1.0",
          regionSupported: true,
          supportedRegions: ["eu-west-1"],
        }}
      />,
    );

    expect(await screen.findByText("123456789012")).toBeInTheDocument();
    expect(screen.getByText("eu-west-1")).toBeInTheDocument();
  });

  it("re-reads the account on Refresh, and the button says it's working", async () => {
    let release!: (value: { resources: ResourceRow[]; ledger: LedgerEntry[] }) => void;
    const load = vi
      .fn()
      .mockResolvedValueOnce({ resources: [], ledger: [] })
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    render(<Resources load={load} openExternal={vi.fn()} />);
    await screen.findByText(/hasn't created anything/i);

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    const busy = screen.getByRole("button", { name: /checking…/i });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toBeDisabled();

    release({ resources: ROWS, ledger: [] });
    // Its own row and the group heading it now titles.
    expect(await screen.findAllByText("olly-digital")).toHaveLength(2);
  });

  it("explains a failed read in one calm sentence, with the raw AWS text behind a disclosure", async () => {
    const load = vi.fn().mockRejectedValue(
      new Error('backend 500: {"message":"We couldn\'t reach AWS just now — check your connection and try again.","detail":"AccessDeniedException: not authorized"}'),
    );
    render(<Resources load={load} openExternal={vi.fn()} />);

    const banner = await screen.findByText(/we couldn't reach AWS just now/i);
    expect(banner).not.toHaveTextContent(/AccessDeniedException/);
    expect(screen.getByText(/AccessDeniedException: not authorized/).closest("details")).not.toBeNull();

    // And it stops loading rather than spinning for ever.
    await waitFor(() => expect(screen.queryByText(/reading your account…/i)).not.toBeInTheDocument());
  });
});

describe("groupBySite", () => {
  it("gives each website one group, titled with the website's own name", () => {
    const groups = groupBySite(ROWS);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("olly-digital");
    expect(groups[0]!.rows.map((r) => r.kind)).toEqual(["Website", "Live branch", "Custom domain"]);
  });

  it("counts websites, not resources — the question this screen failed to answer", () => {
    // Three rows for one website used to read as three things in the account.
    const second: ResourceRow[] = ROWS.map((r) => ({ ...r, siteId: "d9z8y7x6", name: `${r.name}-two` }));
    expect(groupBySite([...ROWS, ...second])).toHaveLength(2);
  });

  it("titles the group from the website row whatever order the rows arrive in", () => {
    const reversed = [...ROWS].reverse();
    expect(groupBySite(reversed)[0]!.title).toBe("olly-digital");
  });

  it("never drops a row whose website is missing — nothing here may be hidden", () => {
    const orphan: ResourceRow = { ...ROWS[2]!, siteId: "gone" };
    const groups = groupBySite([orphan]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toEqual([orphan]);
  });

  it("has nothing to group when nothing exists", () => {
    expect(groupBySite([])).toEqual([]);
  });
});

describe("getting back into the app from this tab", () => {
  // This tab names every website it found, so it READS as the place to manage one. Until
  // 2026-09-10 every link on it went to the AWS console, and the founder spent a session
  // concluding the poppy could not show a site's address or attach a domain — while both
  // sat one tab away, behind a button this screen never offered.
  it("offers the website's own dashboard, not only the AWS console", async () => {
    const onOpenSite = vi.fn();
    render(<Resources load={loader(ROWS, LEDGER)} onOpenSite={onOpenSite} />);

    await userEvent.click(await screen.findByRole("button", { name: /manage this website/i }));

    expect(onOpenSite).toHaveBeenCalledWith("d1a2b3c4");
  });

  it("offers it once — on the website, not on everything that belongs to it", async () => {
    // Three rows share one siteId; three identical buttons would be noise, and two of them
    // would name a branch or a domain while opening the website.
    render(<Resources load={loader(ROWS, LEDGER)} onOpenSite={vi.fn()} />);

    expect(await screen.findAllByRole("button", { name: /manage this website/i })).toHaveLength(1);
  });

  it("keeps the AWS links, because checking our work is what they are for", async () => {
    render(<Resources load={loader(ROWS, LEDGER)} onOpenSite={vi.fn()} />);

    expect(await screen.findAllByRole("button", { name: /open in aws/i })).toHaveLength(3);
  });
});
