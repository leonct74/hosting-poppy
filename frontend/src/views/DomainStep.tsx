// S7 — "Your domain". The screen a beginner is most likely to fail on, so it carries the
// most care of anything in this poppy.
//
// The failure it is built against: somebody types their domain, is handed two records they
// have never seen before, pastes one of them wrongly into a registrar's form, and ends up
// with a site nobody can reach and no idea which half is broken. So:
//
//  - what the user typed is echoed back as the two parts AWS actually needs — the domain
//    they OWN and whatever sits in front of it — because that split is a heuristic that
//    can be wrong, and a wrong split fails as "AWS says this domain isn't yours", which
//    nobody can debug from the outside;
//  - every record value gets its own copy button. A DNS name pasted with one leading space
//    is stored as a DIFFERENT name and serves nothing, while looking perfectly normal;
//  - the wait is named honestly ("usually minutes, sometimes up to an hour"), re-checks
//    itself, and never blocks anything: the site is already live on its AWS address, and
//    the screen says so at every step.
//
// And since 2026-08-24 (DESIGN §3.3), the screen READS THE ZONE BEFORE IT ACTS. The first
// live domain attach failed in under a minute: `hp-test.example.net` carried a catch-all
// `*.example.net` pointing at a Firebase app, so every possible name under it already
// answered. AWS asked whether the name pointed at its own distribution, got a WRONG answer
// rather than no answer, and gave up. The user would have read "We couldn't finish
// connecting that address" — true, useless, impossible to act on. A record for the exact
// name fixed it in one click; KNOWING that was the entire problem.
//
// So before anything is created, the address is looked up, and what is found decides what
// this screen says and which buttons are honest to offer. Two rules hold the whole thing
// together: the look-up is read-only and never blocks (a zone we cannot read simply falls
// back to the copy-paste records this screen always had), and writing into somebody's live
// DNS is never silent and never one bare click.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { readFailure, type Failure } from "../lib/errors";
import type { DnsRecord, DnsWriteResult, DomainCheck, DomainStatus, Site } from "../types";
import { FailureBanner } from "./FailureBanner";
// The address link is shared with the site list and the progress screen: inside the host's
// frame a plain link is a silent no-op, and when the bridge refuses, all three screens must
// fall back the same way — showing the address to copy rather than a button that does nothing.
import { AddressLink } from "./Home";

/**
 * How often the screen re-checks a domain that is still settling, on its own.
 *
 * DNS is not fast and the user should not have to sit here pressing a button; but it is not
 * slow enough to leave the screen stale for minutes either. Half a minute is often enough
 * to catch the moment it lands, and cheap enough to run while the tab is open.
 */
const RECHECK_MS = 30_000;

/**
 * How long after the last keystroke before the address is looked up.
 *
 * The look-up is a network call fired while somebody types, so it waits for them to stop —
 * otherwise `example.com` is eight calls, and `example.co` (a real domain, and a real answer)
 * is one of them. Long enough to mean "they've stopped", short enough that the answer feels
 * like it belongs to what they just typed. Injectable so tests need no fake clock.
 */
const CHECK_AFTER_MS = 500;

/**
 * Two-label endings that behave like a top-level domain — the part before them is the name
 * somebody registered.
 *
 * MIRRORED from `backend/src/sites.ts`, the same way `types.ts` is mirrored: the two are
 * separate builds, so keep them in step. It is a HEURISTIC, not the real public-suffix list
 * (thousands of entries, changing constantly). That is precisely why this screen SHOWS the
 * user what it derived — a miss becomes something they can see and correct here, instead of
 * an unexplainable refusal from AWS later.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br",
  "co.za", "org.za", "web.za", "net.za",
  "co.in", "net.in", "org.in", "firm.in", "gen.in",
  "com.mx", "com.ar", "com.co", "com.pe", "com.uy",
  "com.sg", "com.hk", "com.tw", "com.cn", "net.cn", "org.cn",
  "co.kr", "or.kr", "ne.kr",
  "com.tr", "com.ua", "com.pl", "com.ru", "com.my", "com.ph", "com.vn", "co.th", "co.il", "co.id",
]);

export interface DomainParts {
  /** The domain the user registered — what AWS is asked to certify. */
  root: string;
  /** What sits in front of it ("www", "shop"). Empty for the bare domain. */
  prefix: string;
}

/** Split what was typed into the domain owned plus a prefix. Mirrors the backend's rule. */
export function splitDomain(input: string): DomainParts {
  const domain = input.trim().toLowerCase().replace(/\.+$/, "");
  if (!domain) return { root: "", prefix: "" };

  const labels = domain.split(".");
  if (labels.length <= 2) return { root: domain, prefix: "" };

  const rootLabels = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  // "co.uk" on its own has no registered name in front of the suffix, so there is no split
  // to make — hand the whole thing over and let AWS refuse it, rather than inventing one.
  if (labels.length <= rootLabels) return { root: domain, prefix: "" };

  return {
    root: labels.slice(-rootLabels).join("."),
    prefix: labels.slice(0, labels.length - rootLabels).join("."),
  };
}

/**
 * Whether an address is finished enough to be worth asking AWS about.
 *
 * Not politeness to the network — honesty to the user. Half of `example.com` is `example.co`,
 * which is a real domain somebody else owns, and an answer about THAT flashing up mid-word
 * would be a confident, wrong sentence about their own site. Anything that isn't yet two
 * complete labels is left alone.
 */
export function worthChecking(input: string): boolean {
  const domain = input.trim().toLowerCase().replace(/\.+$/, "");
  if (!domain || /\s|\/|:/.test(domain)) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return false;
  return (labels.at(-1) ?? "").length >= 2;
}

/** What the banner says when nothing in the failure was written for a person. */
const DOMAIN_FAILED =
  "Something went wrong while setting up your domain — the technical details say what AWS reported.";

/**
 * When we offered to do the one thing this screen exists to spare the user, and couldn't.
 *
 * It names the way out in the same breath, because there always is one: the entries are on
 * screen, and adding them by hand is what everybody whose domain lives elsewhere does anyway.
 */
const RECORD_FAILED =
  "We couldn't add that entry to your domain — the entries below are exactly what to add by hand instead.";

/** What each record is for, said in the words of the person who has to add it. */
const PURPOSE_LABEL: Record<DnsRecord["purpose"], string> = {
  "certificate-validation": "Proves the domain is yours",
  "point-your-domain": "Points your domain at your site",
};

/**
 * What came back from writing into the zone: where the domain stands now, and what the write
 * actually managed. `write.manual` — the records we could NOT put in — is the whole reason
 * this is not just a status: without it the screen would say "there's nothing left for you to
 * do" over records still sitting unwritten.
 */
export interface DomainWrite {
  domain: DomainStatus;
  write?: DnsWriteResult;
}

export interface DomainStepProps {
  site: Site;
  /** Read where the domain has got to. Null means none is attached yet. */
  load?: () => Promise<DomainStatus | null>;
  /** Attach the address the user typed and get back the records they owe DNS. */
  attach?: (address: string, alsoWww: boolean) => Promise<DomainStatus>;
  /**
   * Look at what the address already does, BEFORE anything is created or changed
   * (DESIGN §3.3). Read-only and safe to ask repeatedly, which is what lets the screen fire
   * it on its own rather than making the user press something.
   */
  checkAddress?: (address: string) => Promise<DomainCheck>;
  /**
   * Write what this site needs into the user's own zone, on their behalf.
   *
   * The only call on this screen that changes something the public internet reads, so it is
   * never reached except from a button the user pressed knowing what it would do —
   * `confirmOverwrite` IS that press, and the backend refuses a move without it.
   */
  writeRecord?: (options: { confirmOverwrite: boolean }) => Promise<DomainWrite>;
  /** How long to wait after typing stops before looking. Tests pass 0 and skip the clock. */
  checkAfterMs?: number;
  /** Disconnect it again. The site stays live on its AWS address. */
  detach?: () => Promise<void>;
  /** Opens a URL in the system browser — a sandboxed frame can't. */
  openExternal?: (url: string) => void | Promise<void>;
  /** Back to the site's dashboard. */
  onBack?: () => void;
}

export function DomainStep({
  site,
  load = () => api.getDomain(site.id).then((r) => r.domain),
  attach = (address) => api.attachDomain(site.id, address).then((r) => r.domain),
  // The site id sharpens the answer: without it, a name already pointing at THIS website
  // comes back as `taken`, and the screen would ask the user to confirm moving their own
  // site onto itself.
  checkAddress = (address) => api.checkDomain(address, site.id).then((r) => r.check),
  writeRecord = (options) => api.writeDomainRecord(site.id, options),
  checkAfterMs = CHECK_AFTER_MS,
  detach = () => api.removeDomain(site.id).then(() => undefined),
  openExternal,
  onBack,
}: DomainStepProps) {
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState("");
  /**
   * Whether www.<domain> should reach this site too. ON by default: nearly everyone wants it,
   * and the cost of it being wrong is asymmetric — an unwanted www is a name pointing at your
   * own site, a missing one is visitors getting an error.
   *
   * The decision can only be made HERE. www is a second prefix inside the one attachment AWS
   * creates, and this poppy holds no permission to edit an attachment afterwards, so changing
   * your mind means removing the domain and adding it again. Adding the DNS by hand instead
   * does not work: proven on a live site, the request reaches AWS and is refused with
   * "Forbidden", because CloudFront answers only for names it was told about.
   */
  const [alsoWww, setAlsoWww] = useState(true);
  /** Which button is in flight, so exactly that one spins and none can double-fire. */
  const [busy, setBusy] = useState<"attach" | "check" | "detach" | "write" | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  /** What the address already does. Null until the look-up has answered for this address. */
  const [check, setCheck] = useState<DomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  /**
   * The look-up itself failed. Kept apart from `error`, and never shown as one: not knowing
   * what a name does is not a failure of anything the user asked for, and painting it red
   * would tell somebody their domain is broken when all that happened is we couldn't look.
   */
  const [lookupFailed, setLookupFailed] = useState(false);
  /** Bumped to ask again — after "Look again", and after a write, because the zone changed. */
  const [lookups, setLookups] = useState(0);
  /** The user chose to add the entries themselves, so the offer steps out of the way. */
  const [byHand, setByHand] = useState(false);
  /** The second step of moving a name that is already in use. Never skipped. */
  const [confirmMove, setConfirmMove] = useState(false);
  /**
   * What our write actually did. Non-null once it has run, and read rather than assumed: the
   * backend reports records it could NOT write, and those still have to be added by hand.
   */
  const [wrote, setWrote] = useState<DnsWriteResult | null>(null);
  /**
   * A manual check came back and the domain still isn't live. Tracked so "Check my DNS"
   * ANSWERS rather than just stopping — a button that looks identical before and after it
   * ran reads as broken, and the honest answer here ("not yet, nothing is wrong") is the
   * one thing that stops somebody re-adding records they already added correctly.
   */
  const [stillWaiting, setStillWaiting] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);

  // Held in a ref rather than used as an effect dependency. `load` defaults to an arrow
  // built during render, and a parent may well pass one too — as a dependency that means a
  // brand-new function every render, so the read below would re-fire, set state, re-render,
  // and never stop.
  const loadRef = useRef(load);
  loadRef.current = load;
  // Same reasoning for the look-up, and the consequence is worse: a re-firing effect there
  // would ask AWS about the same address for ever, as fast as React could re-render.
  const checkRef = useRef(checkAddress);
  checkRef.current = checkAddress;

  // The truth is AWS, never this component's memory (AGENTS.md §5): every mount re-reads
  // where the domain actually got to, so leaving mid-wait and coming back is not a reset.
  const reload = useCallback(async () => {
    const next = await loadRef.current();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadRef.current();
        if (!cancelled) setStatus(next);
      } catch (e) {
        if (!cancelled) setError(readFailure(e, DOMAIN_FAILED));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [site.id]);

  const phase = status?.phase;
  // A failed domain is deliberately absent: AWS has stopped, so asking again forever would
  // only cost the user calls to learn the same thing. That is exactly why the failed card
  // below must never borrow the waiting card's "we'll keep checking" words.
  const settling = phase === "verifying" || phase === "pending-dns";

  // Re-check on our own while it settles, so somebody who added the records and walked away
  // comes back to the answer instead of to a stale screen. A failed background check is
  // swallowed: the next one usually works, and an error that reappears every half minute is
  // noise nobody can act on.
  useEffect(() => {
    if (!settling) return;
    const timer = window.setInterval(() => {
      void reload().catch(() => {});
    }, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [settling, reload]);

  const parts = splitDomain(address);
  const typedLooksLikeUrl = /:\/\//.test(address) || address.includes("/");
  const typed = address.trim().toLowerCase().replace(/\.+$/, "");

  /**
   * Which address the zone read is ABOUT: the one being typed while nothing is attached, and
   * the attached one afterwards — so leaving the screen mid-wait and coming back rebuilds the
   * offer from AWS rather than from this component's memory.
   *
   * Empty means don't look, and each reason is deliberate: a live domain has nothing left to
   * offer, and a domain AWS has given up on has one way forward that the failed card owns —
   * offering to write a record there would be a second, competing answer to a dead end.
   */
  const checkTarget = status
    ? settling
      ? status.domain
      : ""
    : worthChecking(typed) && !typedLooksLikeUrl
      ? typed
      : "";

  // Every answer, and every choice made about it, belongs to ONE address — so changing the
  // address forgets all of them. Kept apart from the look-up below, which also runs when the
  // user asks again and after a write: those must not wipe what just happened on this address
  // (an earlier version cleared `wrote` on its own re-read, so "Done" flashed and vanished).
  useEffect(() => {
    setCheck(null);
    setLookupFailed(false);
    setByHand(false);
    setConfirmMove(false);
    setWrote(null);
  }, [checkTarget]);

  useEffect(() => {
    if (!checkTarget) {
      setChecking(false);
      return;
    }

    // Set before the wait, not inside it: the screen has to say it is looking from the moment
    // there is something to look at, or the pause reads as the screen having nothing to say.
    // Clearing the last failure here is what makes "Look again" able to succeed.
    setChecking(true);
    setLookupFailed(false);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await checkRef.current(checkTarget);
          if (!cancelled) setCheck(next);
        } catch {
          // Never blocks. A zone we cannot read — in another account, refused, or DNS simply
          // unreachable — means the copy-paste records, which is what this screen did before
          // any of this existed and is still correct for most of the world's domains.
          if (!cancelled) setLookupFailed(true);
        } finally {
          if (!cancelled) setChecking(false);
        }
      })();
    }, checkAfterMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkTarget, checkAfterMs, lookups]);

  const attachDomain = async () => {
    if (busy) return;
    setBusy("attach");
    setError(null);
    setStillWaiting(false);
    try {
      setStatus(await attach(address.trim(), alsoWww && parts.prefix === ""));
    } catch (e) {
      setError(readFailure(e, DOMAIN_FAILED));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Put the entries into the user's own zone for them.
   *
   * Only ever reached from a button pressed after the screen has said, in plain words, what
   * is there now and what this will do to it — and for a name already in use, only from the
   * second of two buttons (DESIGN §3.3: changing live DNS is never silent, never one click).
   */
  const addRecord = async (confirmOverwrite: boolean) => {
    if (busy) return;
    setBusy("write");
    setError(null);
    try {
      const done = await writeRecord({ confirmOverwrite });
      setStatus(done.domain);
      // An older backend, or one that answered without the detail, still counts as written —
      // but with nothing claimed about what went in, so the screen keeps the entries on show.
      setWrote(done.write ?? { written: [], manual: [], state: "unknown" });
      setConfirmMove(false);
      setStillWaiting(false);
      // Read the zone again rather than assume our own write landed the way we meant it to.
      // The answer is what the user sees next, and it should come from AWS, not from us.
      setLookups((n) => n + 1);
    } catch (e) {
      setError(readFailure(e, RECORD_FAILED));
      // Hand the screen back to the path that always works. The sentence promises the entries
      // are below — so they have to BE below, not hidden behind an offer that just failed.
      setByHand(true);
      setConfirmMove(false);
    } finally {
      setBusy(null);
    }
  };

  /**
   * The one entry point to writing. A name nothing uses is written on the press; a name
   * somebody is already using opens the confirmation instead, wherever the press came from —
   * so no later button can ever become a shortcut past it.
   */
  const startWrite = () => {
    if (busy) return;
    if (check?.willOverwrite) setConfirmMove(true);
    else void addRecord(false);
  };

  const checkDns = async () => {
    if (busy) return;
    setBusy("check");
    setError(null);
    try {
      const next = await reload();
      setStillWaiting(next?.phase !== "live");
    } catch (e) {
      setError(readFailure(e, DOMAIN_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy("detach");
    setError(null);
    try {
      await detach();
      setStatus(null);
      setConfirmDetach(false);
      setStillWaiting(false);
      setAddress("");
    } catch (e) {
      setError(readFailure(e, DOMAIN_FAILED));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Whether "add the record for me" is an honest thing to put on screen.
   *
   * `canWrite` is the backend's judgement — it found the zone in this AWS account and knows
   * what the name is. The rest is this screen's: there must be something to write (AWS takes
   * a minute to hand the entries over, and an offer to add nothing is a button that lies),
   * and once it is written the offer has no job left.
   */
  const canOffer = !!check?.canWrite && !!status && status.records.length > 0 && !wrote;
  /** The same thing, narrowed — and withdrawn while the user is doing it by hand. */
  const offer = canOffer && !byHand ? check : null;

  /** Records our write could not put in. Still the user's to add, so still on screen. */
  const leftovers = wrote?.manual ?? [];
  /**
   * Which entries the table shows. After a partial write it is only the ones still
   * outstanding: a full table under "we added these for you" would send somebody to their
   * registrar to re-type records that are already in place.
   */
  const shown = wrote && leftovers.length > 0 ? leftovers : (status?.records ?? []);

  return (
    <div className="stack">
      <div className="card">
        <div className="spread" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Your domain</h2>
          {onBack && (
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              ← Back to {site.name}
            </button>
          )}
        </div>

        {/* Ground rule 3, repeated wherever a wait could look like a hold-up: the win has
            already happened, and none of this can take it away. */}
        <div className="banner info">
          Your site is already live{site.defaultUrl ? " at " : ""}
          {/* CLICKABLE, not printed. This screen is where the wizard lands the moment a site goes
              live, so it is the first place the address appears after the progress screen — and
              until 2026-09-10 it appeared here as dead text, which read as the link having been
              taken away (founder's field report: "the link to the website disappears"). */}
          {site.defaultUrl && <AddressLink url={site.defaultUrl} openExternal={openExternal} />} — and it
          stays live on that address the whole time you set this up. Nothing here can take it offline.
        </div>
      </div>

      {loading && (
        <div className="card row">
          <span className="spinner" /> <span className="muted">Checking where your domain has got to…</span>
        </div>
      )}

      {!loading && !status && (
        <div className="card stack">
          <div>
            <h3 style={{ margin: "0 0 4px" }}>Which address should people type?</h3>
            <p className="muted" style={{ margin: 0 }}>
              A domain you already own. If you haven't bought one yet, buy it anywhere you like first — then
              come back here.
            </p>
          </div>

          <label className="field" style={{ margin: 0 }}>
            <span>Your domain</span>
            <input
              className="input mono"
              value={address}
              // Forced lowercase, never merely styled: a capitalised domain has broken the
              // lookup in a sibling poppy, and a phone keyboard capitalises the first letter
              // of every field by default.
              onChange={(e) => setAddress(e.target.value.toLowerCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && address.trim() && !busy) void attachDomain();
              }}
              placeholder="yourdomain.com"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-label="The domain you want people to type"
              disabled={busy !== null}
            />
            {typedLooksLikeUrl && (
              <span className="hint">Type just the domain — example.com — with no https:// and nothing after it.</span>
            )}
          </label>

          {/* What we understood, before anything is created. The split is a guess, so it is
              shown as one, with the fix right beside it. */}
          {parts.root && !typedLooksLikeUrl && (
            <div className="banner info stack" style={{ gap: 8 }}>
              <div>
                We read that as <strong className="mono break">{parts.root}</strong> — the domain you own —
                {parts.prefix ? (
                  <>
                    {" "}
                    with <strong className="mono">{parts.prefix}</strong> in front.
                  </>
                ) : (
                  <> with nothing in front.</>
                )}
              </div>
              {/* Only for a ROOT domain: somebody who typed a subdomain has already said which
                  name they mean, and www.shop.example.com is a name nobody wants. */}
              {parts.prefix === "" && (
                <label
                  // Not the shared .row class: that wraps, which put the box on a line of its
                  // own above its own label. nowrap + a flexible second column keeps the tick
                  // beside the sentence it governs.
                  style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "nowrap", margin: 0 }}
                >
                  <input
                    type="checkbox"
                    checked={alsoWww}
                    onChange={(e) => setAlsoWww(e.target.checked)}
                    disabled={busy !== null}
                    style={{ marginTop: 4, flex: "0 0 auto" }}
                  />
                  <span style={{ minWidth: 0 }}>
                    Also point <strong className="mono break">www.{parts.root}</strong> here — most visitors
                    type it
                    <span className="hint" style={{ display: "block", marginTop: 2 }}>
                      This can only be decided now. To change it later you would have to remove this domain
                      and add it again; adding the record yourself afterwards doesn't work, because AWS only
                      answers for addresses it was told about.
                    </span>
                  </span>
                </label>
              )}
              <details className="details">
                <summary>Not the domain you bought?</summary>
                <div className="stack" style={{ marginTop: 8 }}>
                  <p className="muted small" style={{ margin: 0 }}>
                    Some endings are two words — <span className="mono">.co.uk</span>,{" "}
                    <span className="mono">.com.au</span> — and our list of them can't be complete, so once in
                    a while we read the wrong part of what you typed as the domain you registered. If the
                    name above isn't the one you bought, AWS will refuse it, because it can only give a
                    certificate to somebody who owns the domain.
                  </p>
                  <p className="muted small" style={{ margin: 0 }}>
                    The fix: type the domain you registered on its own, with nothing in front. If that's
                    still read wrongly, it's a gap in our list — tell us from the Feedback tab and we'll add
                    it.
                  </p>
                  {parts.prefix && (
                    <div>
                      <button className="btn btn-sm" onClick={() => setAddress(parts.root)}>
                        Use {parts.root} on its own
                      </button>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}

          {/* What that address already does, before a single thing is created. Nothing here
              is a gate: the button below is live throughout, whatever this says or fails to
              say (DESIGN §3.3). */}
          <ZoneReading
            address={checkTarget}
            checking={checking}
            failed={lookupFailed}
            check={check}
            stage="asking"
            onLookAgain={() => setLookups((n) => n + 1)}
          />

          {error && <FailureBanner error={error} />}

          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!address.trim() || busy !== null}
              aria-busy={busy === "attach" || undefined}
              onClick={() => void attachDomain()}
            >
              {busy === "attach" && <span className="spinner" aria-hidden="true" />}
              <span>{busy === "attach" ? "Setting it up…" : "Use this domain"}</span>
            </button>
          </div>
          {/* The sentence a beginner plans around, so it has to be the true one: telling
              somebody whose domain we look after to go and paste records at a registrar sends
              them hunting for a form they never needed to find. */}
          <p className="muted small" style={{ margin: 0 }}>
            {nextStepLine(check)}
          </p>
        </div>
      )}

      {status && (
        <>
          {status.phase === "live" ? (
            <div className="card stack">
              {/* The moment it lands. It took the user a wait and a form at their registrar
                  — say so plainly and give them the thing to click. */}
              <div className="banner ok">
                🎉 <strong>{status.domain} is live.</strong> Your site is served on your own name, over a
                secure connection.
              </div>
              {status.url && (
                <div>
                  <AddressLink url={status.url} openExternal={openExternal} size="big" />
                </div>
              )}
              <p className="muted small" style={{ margin: 0 }}>
                The security certificate renews itself. There is nothing left to do here.
              </p>
            </div>
          ) : status.phase === "failed" ? (
            /*
             * AWS has given up on this address. It gets its own card because the words it
             * needs are the opposite of the waiting card's: a wait is "nothing is wrong, we
             * are still checking", and this is "nothing is happening any more, and it needs
             * you". Sharing one card is how a dead domain came to be told it was fine.
             */
            <div className="card stack">
              <div className="spread">
                <h3 style={{ margin: 0 }} className="break">
                  {status.domain}
                </h3>
                <span className="badge bad">
                  <span className="dot" />
                  Needs a look
                </span>
              </div>

              {/* The backend has already turned AWS's own account of the failure into one
                  human sentence that names the next move (backend/src/amplify.ts) — and it
                  can tell "the record never arrived" from "that address is used by another
                  website", which the user cannot. So it is shown, not buried. */}
              <p style={{ margin: 0 }}>
                {status.reason ?? `AWS stopped trying to connect ${status.domain}, so it never went live.`}
              </p>

              {/* Said out loud because the screen used to imply the opposite: this state does
                  not re-check itself, and letting somebody wait for a check that will never
                  come is the cruellest thing this screen could do. */}
              <p className="muted small" style={{ margin: 0 }}>
                Nothing is being checked any more — AWS has stopped, and it won&rsquo;t start again on its
                own. Your site is still live on its AWS address, exactly as it has been all along.
              </p>

              <div className="banner info stack" style={{ gap: 6 }}>
                <strong>What usually causes this</strong>
                <span>
                  The entry that proves the domain is yours never reached the internet — either it was never
                  added where you bought {status.domain}, or it was added with a small difference: a stray
                  space, the domain typed into a name your provider already adds it to, or a value that got
                  cut short.
                </span>
              </div>

              {status.records.length > 0 ? (
                <>
                  <p className="muted small" style={{ margin: 0 }}>
                    This is what AWS was waiting for. Compare it with what you added, character for
                    character — then remove the domain here and add it again.
                  </p>
                  <RecordTable records={status.records} />
                </>
              ) : (
                <p className="muted small" style={{ margin: 0 }}>
                  AWS hasn&rsquo;t kept the entry it was waiting for, so there is nothing to compare against.
                  Removing this domain and adding it again gives you a fresh one.
                </p>
              )}

              {error && <FailureBanner error={error} />}

              {!confirmDetach ? (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row">
                    <button
                      className="btn btn-primary"
                      disabled={busy !== null}
                      onClick={() => setConfirmDetach(true)}
                    >
                      Remove it and try again
                    </button>
                  </div>
                  <p className="muted small" style={{ margin: 0 }}>
                    Add or correct the entry at your domain provider first if you can — then remove this and
                    add the domain again. You&rsquo;ll get a fresh set of entries to check against.
                  </p>
                </div>
              ) : (
                <div className="stack">
                  <p style={{ margin: 0 }}>
                    Remove <strong className="break">{status.domain}</strong> and start over? The domain stays
                    yours and your site stays live on its AWS address. You can add it again straight away.
                  </p>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn" disabled={busy !== null} onClick={() => setConfirmDetach(false)}>
                      Keep it
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={busy !== null}
                      aria-busy={busy === "detach" || undefined}
                      onClick={() => void disconnect()}
                    >
                      {busy === "detach" && <span className="spinner" aria-hidden="true" />}
                      <span>{busy === "detach" ? "Removing…" : "Remove it"}</span>
                    </button>
                  </div>
                </div>
              )}

              {/*
               * The technical view, for a support message or the Feedback tab. AWS's raw
               * failure text is deliberately never carried across the wire — the backend
               * turns it into the sentence above and `DomainStatus` has no field for it
               * (types.ts) — so this is the exact state of the thing, not a rawer error.
               */}
              <details className="details">
                <summary>Technical details</summary>
                <pre>
                  {[
                    `address: ${status.domain}`,
                    "aws domain status: failed (AWS has stopped retrying)",
                    `entries still outstanding: ${status.records.length}`,
                  ].join("\n")}
                </pre>
              </details>
            </div>
          ) : (
            <div className="card stack">
              <div className="spread">
                <h3 style={{ margin: 0 }} className="break">
                  {status.domain}
                </h3>
                <span className="badge warn">
                  <span className="dot" />
                  Waiting for DNS
                </span>
              </div>
              {/* Three different things this card can be for, and only one of them is true at
                  a time. Sharing one sentence is how a screen ends up telling somebody to go
                  and add a record we had just added for them. */}
              {wrote ? (
                leftovers.length > 0 ? (
                  // Half a job, said as half a job. The green banner belongs to the case where
                  // the user really has nothing left to do.
                  <div className="banner warn">
                    We added what we could to your domain&rsquo;s settings — {leftovers.length}{" "}
                    {leftovers.length === 1 ? "entry" : "entries"} still need you.
                  </div>
                ) : (
                  <div className="banner ok">
                    Done — it&rsquo;s in your domain&rsquo;s settings. Now the internet has to notice, which
                    is usually minutes and can be up to an hour.
                  </div>
                )
              ) : (
                <p style={{ margin: 0 }}>
                  {offer
                    ? offer.willOverwrite
                      ? // Never breezy about a move. The panel below names what is at stake;
                        // this line must not have already promised it away.
                        `${status.domain} has to point at this website before it can go live — and something else is using it today.`
                      : `${status.domain} needs an entry in your domain's settings before it can go live — and we can add that for you.`
                    : (status.reason ??
                      (check?.managedHere
                        ? "Add the entries below to your domain's settings, then give it a little time. Usually minutes, sometimes up to an hour."
                        : "Add the entries below wherever you bought this domain, then give it a little time. Usually minutes, sometimes up to an hour."))}
                </p>
              )}

              {offer ? (
                <RecordOffer
                  check={offer}
                  confirming={confirmMove}
                  writing={busy === "write"}
                  disabled={busy !== null}
                  onStart={startWrite}
                  onCancel={() => setConfirmMove(false)}
                  onWrite={() => void addRecord(true)}
                  onByHand={() => {
                    setByHand(true);
                    setConfirmMove(false);
                  }}
                />
              ) : (
                <ZoneReading
                  address={checkTarget}
                  checking={checking}
                  failed={lookupFailed}
                  check={check}
                  stage="records"
                  onLookAgain={() => setLookups((n) => n + 1)}
                />
              )}

              {/* Above the entries, not below them: when a write we offered to do fails, the
                  sentence explaining it has to sit where the offer was, right beside the
                  entries it is handing back to the user. */}
              {error && <FailureBanner error={error} />}

              {!offer && (
                <>
                  {wrote ? (
                    /* Transparency, not instructions: this is what we put in their zone, and
                       the difference matters — a copy-paste table with no explanation after a
                       write reads as "now go and do it again somewhere else".

                       Unless something really is left: the backend reports what it could NOT
                       write, and claiming "nothing left to do" over an unwritten record would
                       leave somebody waiting for a domain that can never come up. */
                    <p className="muted small" style={{ margin: 0 }}>
                      {leftovers.length > 0
                        ? "We added what we could. These are the ones we couldn't — add them wherever you bought this domain, and it'll go live once they're there."
                        : "This is what we added for you. There's nothing left for you to type anywhere."}
                    </p>
                  ) : (
                    /* Name the real thing and explain it in one line — never hide it behind a
                       friendlier invention (AGENTS.md plain-language rule). */
                    <p className="muted small" style={{ margin: 0 }}>
                      <strong>DNS</strong> is the internet's address book. Whoever sold you {status.domain}{" "}
                      keeps your entries in it — usually on a page called <em>DNS</em>, <em>Nameservers</em>{" "}
                      or <em>Advanced settings</em>. Add these there.
                    </p>
                  )}

                  {shown.length > 0 ? (
                    <RecordTable records={shown} />
                  ) : (
                    <p className="muted small" style={{ margin: 0 }}>
                      AWS hasn't given us the entries to add yet — they appear here within a minute or two.
                    </p>
                  )}

                  {/* The way back from "I'll add it myself" — because somebody who opens their
                      registrar, sees a form they don't recognise and comes back here should
                      find the offer still standing rather than a screen that took them at
                      their word once and closed the door. Routed through `startWrite`, so a
                      name already in use still meets its confirmation on the way. */}
                  {byHand && canOffer && (
                    <div className="row">
                      <span className="muted small">Changed your mind?</span>
                      <button
                        className="btn btn-sm"
                        disabled={busy !== null}
                        aria-busy={busy === "write" || undefined}
                        onClick={() => {
                          setByHand(false);
                          startWrite();
                        }}
                      >
                        {busy === "write" && <span className="spinner" aria-hidden="true" />}
                        <span>{busy === "write" ? "Adding it…" : "Add the record for me"}</span>
                      </button>
                    </div>
                  )}
                </>
              )}

              <div className="row">
                <button
                  className="btn btn-primary"
                  disabled={busy !== null}
                  aria-busy={busy === "check" || undefined}
                  onClick={() => void checkDns()}
                >
                  {busy === "check" && <span className="spinner" aria-hidden="true" />}
                  <span>{busy === "check" ? "Checking…" : "Check my DNS"}</span>
                </button>
                <span className="muted small">Re-checks itself every half minute too.</span>
              </div>

              {stillWaiting && !busy && (
                <div className="banner info">
                  Not there yet — nothing is wrong. DNS entries take a while to spread around the world, and
                  we'll keep checking. Your site stays live on its AWS address meanwhile.
                </div>
              )}
            </div>
          )}

          {/* Disconnecting deletes a live certificate, so it takes two steps and names what
              happens — never one bare click (AGENTS.md §4). The blast radius is small enough
              that typing the name would be ceremony for its own sake.

              Not offered for a failed domain: the card above already owns that move, in the
              words that state fits ("remove it and try again"), and two panels sharing one
              `confirmDetach` would both spring open on one click. */}
          {status.phase !== "failed" && (
            <div className="card card-2">
              <h3 className="section-title">Disconnect this domain</h3>
              {!confirmDetach ? (
                <div className="spread">
                  <p className="muted" style={{ margin: 0, maxWidth: "46ch" }}>
                    Stops {status.domain} pointing at this site. The domain stays yours, and the site stays
                    live on its AWS address.
                  </p>
                  <button
                    className="btn btn-danger"
                    disabled={busy !== null}
                    onClick={() => setConfirmDetach(true)}
                  >
                    Disconnect…
                  </button>
                </div>
              ) : (
                <div className="stack">
                  <p style={{ margin: 0 }}>
                    Disconnect <strong className="break">{status.domain}</strong>? Visitors typing it stop
                    landing here, and its free security certificate is deleted. You can connect it again
                    later, and you'll get new entries to add when you do.
                  </p>
                  {error && <FailureBanner error={error} />}
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn" disabled={busy !== null} onClick={() => setConfirmDetach(false)}>
                      Keep it
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={busy !== null}
                      aria-busy={busy === "detach" || undefined}
                      onClick={() => void disconnect()}
                    >
                      {busy === "detach" && <span className="spinner" aria-hidden="true" />}
                      <span>{busy === "detach" ? "Disconnecting…" : "Disconnect it"}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Where a name goes today, in one string. "" when nothing was found to point at. */
function pointsAt(check: DomainCheck): string {
  return check.existing?.values.find(Boolean) || check.answers.find(Boolean) || "";
}

/**
 * The lead sentence, when the backend's own is missing.
 *
 * The backend writes it (`amplify.ts::checkMessage`) because only it saw the values, and this
 * screen shows what it was given. But an empty string would leave somebody staring at a blank
 * banner at the exact moment they most need a sentence, so there is always one here to fall
 * back on. Deliberately plainer than the backend's — it knows less.
 */
function fallbackMessage(check: DomainCheck): string {
  if (!check.managedHere) return `We can't see the settings for ${check.root} from this AWS account.`;
  switch (check.state) {
    case "already-ours":
      return `${check.address} already points at this website.`;
    case "taken":
      return `Something already uses ${check.address}.`;
    case "shadowed-by-wildcard":
      return `Everything under ${check.root} currently goes to one place.`;
    default:
      return `Nothing else uses ${check.address}.`;
  }
}

/**
 * The line under the lead sentence: what that means for the person reading it.
 *
 * It changes with WHERE the user is standing, because the same fact has two different next
 * actions — before anything is attached the answer is "here's what's coming", and beside the
 * entries it is "here's what to do with these". "" when the lead sentence has said it all.
 */
function asideFor(check: DomainCheck, stage: "asking" | "records"): string {
  if (!check.managedHere) {
    // The prompt this whole screen was rebuilt from: say plainly that the domain lives
    // somewhere else, so nobody goes hunting in AWS for a setting that isn't there.
    return stage === "asking"
      ? `${check.root} is looked after somewhere else — usually wherever you bought it — so that's where the entries go. The next step shows you exactly what to type.`
      : `${check.root} is looked after somewhere else — wherever you bought it — so add the entries below there, not in AWS.`;
  }
  switch (check.state) {
    case "already-ours":
      return stage === "asking"
        ? "There's no address entry to change — connecting it here just finishes the job."
        : "The address entry is already right, so there's nothing for you to do about it.";
    case "taken":
      return "Nothing moves until you say so, in as many words.";
    case "shadowed-by-wildcard":
      return `An entry for this exact name changes only ${check.address} — every other address under ${check.root} carries on exactly as it does now.`;
    case "free":
      return stage === "asking" ? "In a moment you can have us add that entry for you, or add it by hand." : "";
    default:
      return "";
  }
}

/**
 * What happens after "Use this domain", promised before it is pressed.
 *
 * Four different truths, and the screen has to pick the one that fits — a promise of "two
 * short entries to add wherever you bought the domain" is exactly wrong for the user whose
 * DNS is right here in the account we are holding, and it is the sentence they will go and
 * act on. Pure and exported so it is tested as the little decision it is.
 */
export function nextStepLine(check: DomainCheck | null): string {
  if (check?.willOverwrite) {
    // Never promise the easy version of the dangerous case.
    return "Next you'll see exactly what uses that address today — and nothing changes until you say so.";
  }
  if (check?.canWrite) {
    return "Next you'll choose: we add what's needed to your domain for you, or you add it by hand. Nothing changes for visitors until then.";
  }
  if (check?.managedHere) {
    // Already pointing here, so there is no address entry to write — but AWS still wants its
    // proof-of-ownership entry, and that one lives in the settings we can already see.
    return "Next you'll get the entry AWS still needs before it can secure your address. Nothing changes for visitors until it's in.";
  }
  return "Next you'll get two short entries to add wherever you bought the domain. Nothing changes for visitors until you do.";
}

export interface ZoneReadingProps {
  /** The address being read. "" when there is nothing worth reading, and nothing is shown. */
  address: string;
  checking: boolean;
  failed: boolean;
  check: DomainCheck | null;
  stage: "asking" | "records";
  onLookAgain: () => void;
}

/**
 * What the address already does, said before anything is created (DESIGN §3.3).
 *
 * Informational only — it carries no way to change anything, so it can appear the moment the
 * user has typed a whole domain without ever being a gate. That is the point: the live
 * failure this replaced was a screen that acted first and explained nothing, and the fix is
 * to explain first and let the user act.
 */
function ZoneReading({ address, checking, failed, check, stage, onLookAgain }: ZoneReadingProps) {
  if (!address) return null;

  if (checking) {
    // role="status" so a screen reader is told when the answer arrives, rather than being
    // left on a sentence that silently changed underneath it.
    return (
      <div className="banner info row" style={{ gap: 8 }} role="status">
        <span className="spinner" aria-hidden="true" />
        <span>
          Looking at what <span className="mono break">{address}</span> does today…
        </span>
      </div>
    );
  }

  if (!check) {
    // A refresh that failed over an answer we already have is swallowed on purpose (same
    // reasoning as the background status poll): the old reading is about the same address and
    // is better than throwing it away over one unreachable moment.
    if (!failed) return null;
    // Not an error banner, and not a dead end. Whatever we couldn't see, the copy-paste path
    // still works — it is what everybody whose domain lives elsewhere uses.
    return (
      <div className="banner info stack" style={{ gap: 6 }}>
        <span>
          We couldn&rsquo;t look up what <span className="mono break">{address}</span> does today. That stops
          nothing — you&rsquo;ll get the entries to add wherever your domain lives.
        </span>
        <div>
          <button className="btn btn-sm" onClick={onLookAgain}>
            Look again
          </button>
        </div>
      </div>
    );
  }

  const aside = asideFor(check, stage);
  // Amber for the one case that can move a name somebody is using; everything else is
  // information, and colouring it as a warning would teach the user to fear a screen whose
  // whole job is to reassure them.
  return (
    <div className={`banner ${check.state === "taken" ? "warn" : "info"} stack`} style={{ gap: 6 }}>
      <span>{check.message || fallbackMessage(check)}</span>
      {aside && <span className="small">{aside}</span>}
    </div>
  );
}

export interface RecordOfferProps {
  check: DomainCheck;
  /** The second step of moving a name in use is open. */
  confirming: boolean;
  /** The write is in flight — the button that started it carries the spinner. */
  writing: boolean;
  /** Anything at all is in flight, so nothing here may fire twice. */
  disabled: boolean;
  /** Pressed the offer: writes, or opens the confirmation when a name is in use. */
  onStart: () => void;
  onCancel: () => void;
  /** Confirmed the move. The only path that writes over a name somebody is using. */
  onWrite: () => void;
  onByHand: () => void;
}

/**
 * "We can do this bit for you" — the payoff of reading the zone first.
 *
 * Three sentences, one per way a name can be spoken for, written out rather than assembled:
 *  - nothing there → an offer, and the recommendation to take it;
 *  - a wildcard answers → REASSURANCE. Nothing of theirs breaks, and the sentence says which
 *    part is untouched. This is the case that produced the live failure, and a user who has
 *    just been told "a catch-all record answers for this" will assume the worst unless told
 *    otherwise in the same breath;
 *  - a record already points somewhere → the dangerous one. It names where the name goes
 *    today, says what will happen to it, and takes two deliberate presses (AGENTS.md §4).
 */
function RecordOffer({
  check,
  confirming,
  writing,
  disabled,
  onStart,
  onCancel,
  onWrite,
  onByHand,
}: RecordOfferProps) {
  const target = pointsAt(check);
  const moving = check.willOverwrite;
  const wildcard = check.existing?.name || `*.${check.root}`;

  return (
    <div className={`banner ${moving ? "warn" : "info"} stack`} style={{ gap: 8 }}>
      {moving ? (
        <>
          <strong>Something already uses {check.address}</strong>
          <span>
            {target && (
              <>
                It goes to <span className="mono break">{target}</span> today.{" "}
              </>
            )}
            Connecting this website moves {check.address} here, and whatever it reaches now stops being
            reachable at that address. Every other address under {check.root} is untouched.
          </span>
        </>
      ) : check.state === "shadowed-by-wildcard" ? (
        <>
          <strong>Everything under {check.root} goes to one place today</strong>
          <span>
            A catch-all entry (<span className="mono break">{wildcard}</span>) answers for every address
            under {check.root}
            {target && (
              <>
                , which is why {check.address} reaches <span className="mono break">{target}</span>
              </>
            )}
            . An entry for this exact name always wins, so only {check.address} comes here — every other
            address carries on working exactly as it does now.
          </span>
        </>
      ) : (
        <>
          <strong>We can add this for you</strong>
          <span>
            Nothing else uses {check.address}, and {check.root} is looked after in this AWS account — so we
            can put what this site needs straight in. No copying, no forms at another company.
          </span>
        </>
      )}

      {confirming ? (
        /* The deliberate second press. It names the address, where it goes today and what
           happens to that — because "are you sure?" over a nameless action is a click, not a
           decision (DESIGN §3.3: this is the case that can take somebody's live site down). */
        <div className="stack" style={{ gap: 8 }}>
          <span>
            Move <strong className="mono break">{check.address}</strong>
            {target && (
              <>
                {" "}
                from <span className="mono break">{target}</span>
              </>
            )}{" "}
            to this website? People typing it land here instead as soon as the change spreads, and anything
            still expecting the old address stops working.
          </span>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" disabled={disabled} onClick={onCancel}>
              Leave it as it is
            </button>
            <button
              className="btn btn-danger"
              disabled={disabled}
              aria-busy={writing || undefined}
              onClick={onWrite}
            >
              {writing && <span className="spinner" aria-hidden="true" />}
              <span>{writing ? "Moving it…" : "Move it here"}</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            <button
              className={`btn ${moving ? "btn-danger" : "btn-primary"}`}
              disabled={disabled}
              aria-busy={writing || undefined}
              onClick={onStart}
            >
              {writing && <span className="spinner" aria-hidden="true" />}
              <span>
                {writing
                  ? "Adding it…"
                  : moving
                    ? `Move ${check.address} to this website…`
                    : "Add the record for me"}
              </span>
            </button>
            {/* Always beside it, in every case: nobody is ever trapped in the offer. */}
            <button className="btn btn-ghost" disabled={disabled} onClick={onByHand}>
              I&rsquo;ll add it myself
            </button>
          </div>
          {!moving && (
            <span className="hint">Recommended — this is the step that&rsquo;s easiest to get wrong by hand.</span>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The records, exactly as AWS gave them.
 *
 * Scrolls sideways inside its own box rather than wrapping: these are typed by hand into
 * somebody else's form, and a value broken across two lines is a value somebody mistypes.
 */
function RecordTable({ records }: { records: DnsRecord[] }) {
  return (
    <div className="dns-wrap">
      <table className="dns">
        <thead>
          <tr>
            <th>What it's for</th>
            <th>Name</th>
            <th>Type</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record, i) => {
            // AWS sometimes hands a record back as one unsplittable line. The backend does
            // not guess at it, and neither do we: show it verbatim and say so, because a
            // record we reshaped wrongly breaks a domain silently.
            const unparsed = !record.name && !record.type;
            return (
              <tr key={`${record.purpose}-${record.name}-${i}`}>
                <td className="purpose">{PURPOSE_LABEL[record.purpose]}</td>
                {unparsed ? (
                  <td className="value" colSpan={3}>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <span className="break">{record.value}</span>
                      <CopyValue text={record.value} label="record" />
                    </div>
                    <div className="hint">Add this exactly as it is written.</div>
                  </td>
                ) : (
                  <>
                    <td className="value">
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <span>{record.name}</span>
                        <CopyValue text={record.name} label="name" />
                      </div>
                    </td>
                    <td className="mono">{record.type}</td>
                    <td className="value">
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <span>{record.value}</span>
                        <CopyValue text={record.value} label="value" />
                      </div>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Copy one value, with the legacy fallback that matters here: the host renders this frontend
 * in a webview that may not grant `clipboard-write`, and a copy button that quietly fails is
 * a dead button (AGENTS.md §9). When both paths fail it says so, so the user knows to select
 * the text by hand instead of pasting nothing.
 */
function CopyValue({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    // Never copy the surrounding whitespace. A DNS name pasted with one leading space is
    // stored as a DIFFERENT name, serves nothing, and looks completely normal in every UI.
    const value = text.trim();
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    if (!ok) {
      try {
        const field = document.createElement("textarea");
        field.value = value;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        ok = document.execCommand("copy");
        field.remove();
      } catch {
        ok = false;
      }
    }
    setState(ok ? "copied" : "failed");
    window.setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      className="btn btn-ghost btn-sm"
      style={{ padding: "2px 8px" }}
      title={`Copy the ${label}`}
      aria-label={`Copy the ${label}`}
      onClick={() => void copy()}
    >
      {state === "copied" ? "✓ copied" : state === "failed" ? "select it by hand" : "copy"}
    </button>
  );
}

/** The address without its https://, for the places it is read rather than clicked. */
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}
