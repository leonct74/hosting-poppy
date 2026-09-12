// S9 — the Resources tab. The ONE screen in this poppy where real AWS names belong.
//
// Everywhere else the words are "your website" and "its address", because the user never
// has to think about the machinery. Here the opposite rule applies: transparency requires
// naming exactly what exists in somebody's account because of us, in the words they would
// find it under in the AWS console — plus a link straight to it, so "nothing hidden" is
// something they can check rather than something we assert.
//
// Two sources, on purpose. What EXISTS comes from AWS itself (the backend lists the apps
// carrying our tags), so it cannot drift from reality. What HAPPENED comes from the local
// ledger, which is the only place a removal can still be seen after the thing is gone.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { readFailure, type Failure } from "../lib/errors";
import { formatRelativeTime } from "../lib/format";
import type { LedgerEntry, Meta, ResourceRow } from "../types";
// Shared with the site list: inside the host's frame a plain link is a silent no-op, and
// when the bridge refuses, the console address must still be there to copy — on this screen
// most of all, since its whole purpose is that the user can go and look for themselves.
import { FailureBanner } from "./FailureBanner";
import { AddressLink } from "./Home";

/** What the banner says when nothing in the failure was written for a person. */
const READ_FAILED = "We couldn't read your account just now — the technical details say what AWS reported.";

/** How much history the timeline shows. Older entries stay in the ledger; nobody reads them. */
const TIMELINE_LIMIT = 50;

/** The ledger's actions, in the words used everywhere else in the app. */
const ACTION_LABEL: Record<LedgerEntry["action"], string> = {
  created: "Website created",
  removed: "Website removed",
  deployed: "New version put online",
  "domain-attached": "Domain connected",
  "domain-removed": "Domain disconnected",
};

export interface ResourcesProps {
  /**
   * Opens a website's own dashboard.
   *
   * This tab names every website it found, so it READS as the place to manage one — and
   * until 2026-09-10 every link on it went to the AWS console instead, which is the exact
   * opposite of this poppy's promise. The founder spent a session here concluding the app
   * had no way to see a site or add a domain, while both sat one tab away.
   */
  onOpenSite?: (siteId: string) => void;
  load?: () => Promise<{ resources: ResourceRow[]; ledger: LedgerEntry[] }>;
  /** Opens the AWS console — a sandboxed frame can't open a window itself. */
  openExternal?: (url: string) => void | Promise<void>;
  /** Which account and region all of this is in, when the parent has already read it. */
  meta?: Meta;
}

/**
 * Group the rows by WEBSITE, keeping the order they arrived in.
 *
 * It used to group by AWS SERVICE, which meant every row in the account sat under one
 * heading reading "Amplify Hosting" — one website showed as three rows, three websites as
 * nine, and nothing on the screen answered "how many websites do I have?". The founder
 * asked exactly that (2026-09-10) while looking straight at the list.
 *
 * A website is the unit a person thinks in; its branch and its domain are parts OF one, not
 * peers of it. So the website's own row titles the group and its parts sit underneath. A
 * row whose website is somehow missing still gets a group of its own rather than being
 * dropped — this screen's promise is that nothing in the account is hidden.
 */
export function groupBySite(rows: ResourceRow[]): Array<{ siteId: string; title: string; rows: ResourceRow[] }> {
  const groups: Array<{ siteId: string; title: string; rows: ResourceRow[] }> = [];
  for (const row of rows) {
    const found = groups.find((g) => g.siteId === row.siteId);
    if (found) {
      found.rows.push(row);
      // The website row names the group whenever it turns up, whatever order they arrive in.
      if (row.kind === "Website") found.title = row.name;
    } else {
      groups.push({ siteId: row.siteId, title: row.kind === "Website" ? row.name : row.name, rows: [row] });
    }
  }
  return groups;
}

export function Resources({
  load = () => api.resources(),
  openExternal,
  onOpenSite,
  meta,
}: ResourcesProps) {
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  // Held in a ref rather than used as an effect dependency: `load` defaults to an arrow
  // built during render, so as a dependency it would be a new function every render — the
  // read below would re-fire, set state, re-render, and never stop.
  const loadRef = useRef(load);
  loadRef.current = load;

  const read = useCallback(async () => {
    const data = await loadRef.current();
    setResources(data.resources);
    setLedger(data.ledger);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadRef.current();
        if (cancelled) return;
        setResources(data.resources);
        setLedger(data.ledger);
      } catch (e) {
        if (!cancelled) setError(readFailure(e, READ_FAILED));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await read();
    } catch (e) {
      setError(readFailure(e, READ_FAILED));
    } finally {
      setRefreshing(false);
    }
  };

  const groups = groupBySite(resources);
  // Oldest-first on disk, because that is how a diary is written; newest-first on screen,
  // because that is how one is read.
  const timeline = [...ledger].reverse().slice(0, TIMELINE_LIMIT);

  return (
    <div className="stack">
      <div className="card">
        <div className="spread" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Everything HostingPoppy created in your account — nothing hidden.</h2>
          <button
            className="btn btn-sm"
            disabled={refreshing || loading}
            aria-busy={refreshing || undefined}
            onClick={() => void refresh()}
          >
            {refreshing && <span className="spinner" aria-hidden="true" />}
            <span>{refreshing ? "Checking…" : "Refresh"}</span>
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          This is read from AWS itself, not from a list we keep — so it is what your account really holds.
          To change anything — the address, a domain of your own, removing it — open the website itself.
          The AWS links are here so you can check our work, not because you need them.
        </p>
        {meta && (
          <p className="muted small" style={{ margin: "10px 0 0" }}>
            AWS account <span className="chip">{meta.accountId}</span> · region{" "}
            <span className="chip">{meta.region}</span>
          </p>
        )}
      </div>

      {error && (
        <div className="card">
          <FailureBanner error={error} />
        </div>
      )}

      {loading && (
        <div className="card row">
          <span className="spinner" /> <span className="muted">Reading your account…</span>
        </div>
      )}

      {!loading && resources.length === 0 && (
        <div className="card">
          {/* The most reassuring sentence a cost-anxious person can read, and here it is
              simply true — nothing exists, so nothing is being billed. */}
          <p style={{ margin: 0 }}>
            <strong>Nothing yet.</strong> HostingPoppy hasn't created anything in your AWS account, so there
            is nothing to bill and nothing to remove.
          </p>
        </div>
      )}

      {/* The count, in words, because the question people actually have here is "how many
          websites do I have?" and until 2026-09-10 this screen never answered it. */}
      {!loading && groups.length > 0 && (
        <p className="muted" style={{ margin: "0 0 2px" }}>
          {groups.length === 1 ? "1 website" : `${groups.length} websites`} in this account, and everything
          each one uses.
        </p>
      )}

      {groups.map((group) => (
        <div className="card" key={group.siteId || group.title}>
          <div className="section-title">{group.title}</div>
          <div className="stack">
            {group.rows.map((row) => (
              <div className="spread" key={`${row.service}-${row.kind}-${row.name}-${row.siteId}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="mono break">{row.name}</div>
                  <div className="muted small">{row.kind}</div>
                </div>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  {/* The way back into the app, on the row for the website itself. A branch or a
                      domain belongs to that same website, so only the website row offers it —
                      three identical buttons would just be noise. */}
                  {onOpenSite && row.kind === "Website" && row.siteId && (
                    <button className="btn btn-sm" onClick={() => onOpenSite(row.siteId)}>
                      Manage this website
                    </button>
                  )}
                  {/* GitHub first when there is one: for a connected branch that is the
                      thing a person wants to look at, and it is what Amplify's own console
                      links to. The AWS link stays beside it — checking our work is what it
                      is for. */}
                  {row.sourceUrl && (
                    <AddressLink url={row.sourceUrl} openExternal={openExternal}>
                      Open on GitHub ↗
                    </AddressLink>
                  )}
                  <AddressLink url={row.consoleUrl} openExternal={openExternal}>
                    Open in AWS ↗
                  </AddressLink>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <div className="section-title">What changed, and when</div>
        {timeline.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nothing has happened yet. Every website created, every version put online and every removal shows
            up here.
          </p>
        ) : (
          <ul className="steps">
            {timeline.map((entry, i) => (
              <li className="step done" key={`${entry.at}-${entry.action}-${entry.what}-${i}`}>
                <span className="step-mark" aria-hidden="true" />
                <div className="step-body">
                  <div className="spread">
                    <span className="step-label break">
                      {ACTION_LABEL[entry.action]} · <span className="mono">{entry.what}</span>
                    </span>
                    <span className="muted small">{formatRelativeTime(entry.at)}</span>
                  </div>
                  {entry.detail && <div className="step-note break">{entry.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {ledger.length > TIMELINE_LIMIT && (
          <p className="muted small" style={{ margin: "10px 0 0" }}>
            Showing the most recent {TIMELINE_LIMIT} changes.
          </p>
        )}
      </div>
    </div>
  );
}
