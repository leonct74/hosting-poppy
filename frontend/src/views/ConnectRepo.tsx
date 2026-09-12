// S3, the GitHub half — "Deploy from GitHub", the path the founder asked for first.
//
// This screen walks a beginner through THREE systems in a row: GitHub's app-installation
// page, GitHub's key page, and then AWS. Two of those steps happen in a browser tab we
// don't control, and neither of them can be verified from here — so the screen is built
// the way DomainStep is: one action per step, everything it guessed shown back to the user,
// and honest words about what it cannot check.
//
// Two failures shape almost every decision below.
//
//  - **The wrong kind of key is unrepairable.** GitHub has two kinds, they look alike, and
//    only the fine-grained kind (github_pat_) wires AWS up the modern way. A classic key
//    (ghp_) produces a website that WORKS while sitting on the deprecated deploy-key path,
//    and AWS offers no way to correct it in place: the website has to be deleted and made
//    again, losing its address (DESIGN §3.2). The backend catches it by reading the website
//    back after creating it — but a refusal that arrives after a wait, having already made
//    and deleted something in the user's account, is a bad way to learn this. So the shape
//    of the key is checked here, BEFORE anything exists, and a key we know to be the wrong
//    kind cannot be sent at all.
//  - **The key is a password.** It is the user's, it is meant for their AWS account, and
//    nothing else may ever see it: it is typed into a password field, sent in a request
//    body, kept out of every URL and every message, and wiped from this component the
//    moment the request resolves — success or failure.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConnectRepoInput, type GithubSetup } from "../api";
import { host } from "../host";
import { readFailure, type Failure } from "../lib/errors";
import { AWS_PRICES_NOTE } from "../lib/format";
import { GITHUB_STEPS, repoConstraints } from "../lib/helperPrompt";
import type { Site, SiteKind } from "../types";
import { FailureBanner } from "./FailureBanner";

/** GitHub's page for making a fine-grained key. Never the classic one — see the header. */
const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

/**
 * How long the key we ask GitHub to pre-fill should live.
 *
 * A month, MIRRORING `backend/src/github.ts` (`DEFAULT_TOKEN_DAYS`): short, because the key
 * is used once and a long-lived one is a credential left lying around — but not so short
 * that somebody who makes it, gets interrupted and comes back finds it dead. It is not the
 * website's lifeline either way: AWS's ongoing access comes from the app installed in step
 * 1, so nothing stops working when this expires.
 */
const KEY_DAYS = "30";

/**
 * The branch a website serves when the user hasn't said otherwise. MIRRORED from
 * `backend/src/github.ts` (`DEFAULT_BRANCH`), which fills an empty box in with the same
 * name — this screen sends it explicitly instead, so what AWS is asked for is exactly what
 * the panel above the button said it would be.
 */
const DEFAULT_BRANCH = "main";

const SETUP_FAILED =
  "We couldn't work out where to send you on GitHub — try again, and reopen HostingPoppy from AgentsPoppy if it keeps happening.";
/**
 * Only ever shown when the thrown thing carried no sentence written for a person — a bridge
 * that timed out, something nobody predicted. It deliberately does NOT say "nothing was
 * created": connecting is several AWS calls in a row, the backend undoes what it can but
 * cannot promise the undo itself got through, and reassurance we can't stand behind is how
 * somebody ends up paying for a website they were told didn't exist.
 */
const CONNECT_FAILED =
  "We couldn't connect your repository just now — try again in a moment, and check your list of websites afterwards in case one was left half-made.";

/** What the user typed in the repository box, as far as we could make sense of it. */
export type RepoReading =
  | { kind: "empty" }
  | { kind: "ok"; owner: string; repo: string; url: string }
  /** A repository somewhere else — GitLab, Bitbucket, a company server. */
  | { kind: "not-github"; host: string }
  | { kind: "unreadable" };

/**
 * GitHub's own rules for the two names, MIRRORED from `backend/src/github.ts` (separate
 * builds — keep them in step, the same arrangement `types.ts` describes for the wire).
 *
 * They have to agree, and not approximately: this screen tells the user what it read, and
 * the backend decides whether to accept it. A frontend that is more generous doesn't help
 * anybody — it just moves the refusal to after the button, where the sentence explaining it
 * has to travel back through AWS.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Read the address of a repository out of whatever the user pasted.
 *
 * People paste what their browser or their terminal gave them: the page address, the clone
 * URL, the SSH remote, or just `owner/repo` from memory. All of them are the same
 * repository, and refusing three of the four would be a puzzle, not a validation.
 *
 * The reading is SHOWN on screen rather than trusted silently — same reason DomainStep
 * shows the domain it derived: when the guess is wrong, the user is the only one who can
 * see it, and the alternative is AWS refusing something for reasons they cannot inspect.
 *
 * One deliberate difference from the backend's parser: a link to somewhere INSIDE a
 * repository (`…/tree/main`) is read here as the repository, because on github.com the
 * first two parts of the path always are the repository, and this screen can show what it
 * took and let the user check it. The backend, which has no screen, refuses the same paste
 * rather than guess — and never has to, because what leaves here is always the tidied
 * `https://github.com/owner/repo`.
 */
export function readRepo(input: string): RepoReading {
  const typed = input.trim();
  if (!typed) return { kind: "empty" };

  // github.com in every shape it is copied in: the page address, the clone URL, the SSH
  // remote. Anything after owner/repo (/tree/main, /pull/3) is ignored below.
  const github = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(typed);
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i.exec(typed);

  let path: string;
  if (github?.[1]) path = github[1];
  else if (ssh?.[1]) path = ssh[1];
  else {
    // A dot in the first segment means the user pasted a host, not an owner — GitHub owner
    // names can't contain one. Naming the host they DID paste is the difference between
    // "we can't host that" and a rejection they can't explain.
    const elsewhere = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:git@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)[:/]/i.exec(typed);
    if (elsewhere?.[1]) return { kind: "not-github", host: elsewhere[1].toLowerCase().replace(/^www\./, "") };
    path = typed;
  }

  const parts = path.split(/[?#]/)[0]?.split("/").filter(Boolean) ?? [];
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo)) return { kind: "unreadable" };
  // Both pass the character test and neither is a repository.
  if (repo === "." || repo === "..") return { kind: "unreadable" };

  return { kind: "ok", owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Which of GitHub's two kinds of key this is — the one thing that can't be undone later. */
export type KeyKind = "empty" | "fine-grained" | "classic" | "unknown";

/**
 * Judge a key by its prefix, which is the only thing about it we may ever look at.
 *
 * `unknown` is deliberately allowed through: GitHub can change its prefixes, and refusing a
 * key we simply don't recognise would break this screen the day that happens. What we do
 * know we know for certain — `ghp_` and its relatives are the classic kind, and so is the
 * 40-character hexadecimal token GitHub issued before 2021.
 */
export function readKeyKind(value: string): KeyKind {
  const key = value.trim();
  if (!key) return "empty";
  if (key.startsWith("github_pat_")) return "fine-grained";
  if (/^gh[pousr]_/.test(key) || /^[0-9a-f]{40}$/i.test(key)) return "classic";
  return "unknown";
}

/**
 * GitHub's cap on a key's name, and the label we put in front of the repository's own name.
 *
 * Both are counted here rather than assumed: a name one character over is refused by GitHub
 * with "Name is too long (maximum is 40 characters)" AFTER the user has left this app, on a
 * page they did not write, in the middle of the one step that cannot be undone later. The
 * founder hit exactly that with a 27-character repository name (2026-09-10).
 */
const KEY_NAME_MAX = 40;
const KEY_NAME_PREFIX = "HostingPoppy - ";

/**
 * A key name that names the website AND fits.
 *
 * The repository's name is what makes the key recognisable in a GitHub list months later, so
 * it is the part worth keeping — the prefix is trimmed off the end of the repository name
 * rather than the name being dropped. A trailing separator left by the cut is removed, so a
 * truncated name reads as a shortened word rather than a mistake.
 */
export function tokenName(repo: { repo: string } | null): string {
  if (!repo) return "HostingPoppy";
  const room = KEY_NAME_MAX - KEY_NAME_PREFIX.length;
  const short =
    repo.repo.length <= room ? repo.repo : repo.repo.slice(0, room).replace(/[-_.\s]+$/, "");
  // A repository whose name is nothing but separators would truncate to nothing; the label
  // alone still identifies the key, which is better than sending GitHub an empty name.
  return short ? `${KEY_NAME_PREFIX}${short}` : "HostingPoppy";
}

/**
 * GitHub's key page, pre-filled through the template parameters it added in August 2025, so
 * the user presses Generate and copies rather than choosing seven settings correctly.
 *
 * `target_name` only pre-selects the owner visually; for an organisation's repository the
 * user still picks the organisation themselves, and their organisation may require an owner
 * to approve the key (DESIGN §3.2). The screen says so rather than letting them wonder why
 * a correctly-made key is refused.
 */
export function tokenPageUrl(repo: { owner: string; repo: string } | null): string {
  const params = new URLSearchParams();
  // Named after the website it is for, so it is recognisable in GitHub's key list later —
  // within GitHub's length limit, which it is this side's job to respect (see tokenName).
  params.set("name", tokenName(repo));
  if (repo) params.set("target_name", repo.owner);
  params.set("expires_in", KEY_DAYS);
  params.set("contents", "read");
  params.set("metadata", "read");
  params.set("administration", "read");
  params.set("repository_hooks", "write");
  return `${TOKEN_PAGE}?${params.toString()}`;
}

export interface ConnectRepoProps {
  /** What the website will be called — typed on the screen above this one. */
  name: string;
  /**
   * What the user said they were putting online, chosen on the screen above. It changes what
   * this screen promises — a site that puts its pages together as people visit takes longer to
   * build and keeps costing while people use it — and it is sent with the request, because AWS
   * decides how to set the website up from it and can never be talked out of that afterwards.
   *
   * Defaults to a finished site: that is what every website made before this existed is, and a
   * caller that forgets should get the harmless answer rather than a server nobody asked for.
   */
  kind?: SiteKind;
  /** AWS is building: hand over to the progress screen. */
  onConnected: (started: { site: Site; jobId: string }) => void;
  /** Where to send the user for step 1. Injected so tests never touch the bridge. */
  setup?: () => Promise<GithubSetup>;
  /** Make the website, wire the repository, start the first build. */
  connect?: (input: ConnectRepoInput) => Promise<{ site: Site; jobId: string }>;
  /** Opens a page in the real browser — inside the host's frame nothing else can. */
  openExternal?: (url: string) => void | Promise<void>;
}

export function ConnectRepo({
  name,
  kind = "static",
  onConnected,
  setup = api.githubSetup,
  connect = api.connectRepo,
  openExternal = host.openExternal,
}: ConnectRepoProps) {
  const [where, setWhere] = useState<GithubSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupError, setSetupError] = useState<Failure | null>(null);

  const [key, setKey] = useState("");
  const [repoText, setRepoText] = useState("");
  const [branch, setBranch] = useState(DEFAULT_BRANCH);

  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  /**
   * The key was wiped after a failed attempt. Tracked so the empty box is explained rather
   * than looking like the paste didn't take — which would send somebody back to GitHub to
   * make a second key they don't need.
   */
  const [keyWiped, setKeyWiped] = useState(false);

  // Held in a ref, not a dependency: `setup` defaults to a value off `api` and a parent may
  // pass its own, so as a dependency it could re-fire this read forever.
  const setupRef = useRef(setup);
  setupRef.current = setup;

  const load = useCallback(async () => {
    setLoading(true);
    setSetupError(null);
    try {
      setWhere(await setupRef.current());
    } catch (e) {
      setSetupError(readFailure(e, SETUP_FAILED));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const [installStep, repoStep, keyStep] = GITHUB_STEPS;
  /**
   * The one fact that changes what this screen promises. Never said in AWS's words on screen:
   * the user chose "an app that renders its pages on a server", so that is what they read back.
   */
  const serverRendered = kind === "nextjs";
  const repo = readRepo(repoText);
  const keyKind = readKeyKind(key);
  // An emptied box is not a mistake to scold somebody for: the placeholder says main, the
  // panel above the button says main, and main is what gets sent.
  const branchName = branch.trim() || DEFAULT_BRANCH;
  const ready = repo.kind === "ok" && name.trim() !== "" && keyKind !== "empty" && keyKind !== "classic";

  /**
   * The one sentence saying what is still missing. A disabled button with nothing beside it
   * is the same puzzle as a dead one — the user can see it won't go, and not why.
   * (Only reached from the confirm panel, which needs a readable repository to appear at
   * all, so the repository itself is never the missing piece here.)
   */
  const missing =
    name.trim() === ""
      ? "Give your website a name first — the box is at the top of this screen."
      : keyKind === "empty"
        ? "Paste your key into step 3 first."
        : keyKind === "classic"
          ? "That key is GitHub's older kind — make a fine-grained one in step 3 first."
          : null;

  async function connectNow() {
    if (connecting || repo.kind !== "ok") return;
    setConnecting(true);
    setError(null);
    setKeyWiped(false);
    try {
      const started = await connect({
        name: name.trim(),
        kind,
        repository: repo.url,
        branch: branchName,
        accessToken: key.trim(),
      });
      // Done its one job. Cleared before the hand-off, so the key is gone from this
      // component even in the moment before the parent swaps the screen out.
      setKey("");
      onConnected(started);
    } catch (e) {
      setError(readFailure(e, CONNECT_FAILED));
      // Cleared on the way out too. A secret's life should be as short as it can be, and
      // this one has now crossed a boundary we don't control; the sentence below tells the
      // user why the box is empty so the retry isn't a mystery.
      setKey("");
      setKeyWiped(true);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="stack">
      {/* Step 1 — the permission AWS needs, given on GitHub's own page. */}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>1. {installStep?.label}</h3>
        <p className="small muted" style={{ margin: 0 }}>
          {installStep?.brief}
        </p>

        {loading && (
          <div className="row">
            <span className="spinner" /> <span className="muted small">Working out where to send you…</span>
          </div>
        )}

        {setupError && (
          <>
            <FailureBanner error={setupError} />
            <div>
              <button className="btn" onClick={() => void load()} disabled={loading}>
                Try again
              </button>
            </div>
          </>
        )}

        {where && (
          <>
            <ExternalButton
              url={where.appInstallUrl}
              label="Open GitHub"
              busyLabel="Opening GitHub…"
              openExternal={openExternal}
              primary
            />
            <p className="hint" style={{ margin: 0 }}>
              Pick the repository you're putting online, then come back here.
              {where.region ? ` This is AWS's app for ${where.region}.` : ""}
            </p>
          </>
        )}
      </div>

      {/* Step 2 — which repository, and which branch. Asked BEFORE the key, because
          the key is made FOR a repository: GitHub's page can't be told which one through
          the link, so the hint under the key button has to name it — and it can only do
          that once the address is here. */}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>2. {repoStep?.label}</h3>

        <label className="field" style={{ margin: 0 }}>
          <span>Your repository</span>
          <input
            className="input mono"
            value={repoText}
            onChange={(e) => setRepoText(e.target.value)}
            placeholder="https://github.com/you/your-site"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            aria-label="Your repository's address on GitHub"
            disabled={connecting}
          />
        </label>

        {/* What we made of it, before anything is created — the DomainStep rule: a guess is
            shown as one, where the person who can correct it will see it. */}
        {repo.kind === "ok" && (
          <div className="banner info">
            We read that as{" "}
            <strong className="mono break">
              {repo.owner}/{repo.repo}
            </strong>{" "}
            — the repository AWS will read.
          </div>
        )}
        {repo.kind === "not-github" && (
          <div className="banner warn">
            That looks like a repository on <strong className="break">{repo.host}</strong>. HostingPoppy can
            only deploy from GitHub today — if your code is somewhere else, upload the built site instead.
          </div>
        )}
        {repo.kind === "unreadable" && (
          <div className="banner warn">
            We couldn't find an owner and a repository in that. Paste the address of the repository's page
            on GitHub — it looks like <span className="mono">https://github.com/you/your-site</span>.
          </div>
        )}

        <label className="field" style={{ margin: 0 }}>
          <span>Branch that goes live</span>
          <input
            className="input mono"
            value={branch}
            // Never lowercased, unlike a domain: branch names are case-sensitive, and
            // "Main" and "main" are two different branches to git.
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label="The branch that goes live"
            disabled={connecting}
          />
          <span className="hint">
            Usually <span className="mono">main</span>. Every push to this branch — and only this one —
            updates your website.
          </span>
        </label>
      </div>

      {/* Step 3 — the key. The one step where a mistake cannot be undone afterwards. */}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>3. {keyStep?.label}</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Used once, to set up the automatic deploy. It goes straight to your own AWS account —
          HostingPoppy never stores it.
        </p>

        <ExternalButton
          url={tokenPageUrl(repo.kind === "ok" ? repo : null)}
          label="Open the key page"
          busyLabel="Opening GitHub…"
          openExternal={openExternal}
          // Held shut until the repository is known: the key is made FOR one repository, and
          // opened early GitHub's page asks the user to choose among all of theirs — the
          // disorientation this ordering exists to prevent.
          disabled={repo.kind !== "ok"}
        />
        {repo.kind !== "ok" ? (
          <p className="hint" style={{ margin: 0 }}>
            Paste your repository's address in step 2 first — the key is made for that one repository,
            and until we know which, GitHub would ask you to choose among all of yours.
          </p>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            The page opens with everything filled in except the one choice GitHub won't let a link make:
            under <strong>Repository access</strong>, choose <strong>Only select repositories</strong> and
            pick{" "}
            <span className="mono break">
              {repo.owner}/{repo.repo}
            </span>
            . Then press <strong>Generate token</strong>, copy what GitHub shows you once, and paste it
            below. It expires by itself in a month — your website keeps working after that.
          </p>
        )}
        {repo.kind === "ok" && (
          /* Both of GitHub's rules about the name, said BEFORE the user leaves for a page we
             don't control. Each one refuses on GitHub's side, mid-step, and the founder hit
             both in a row (2026-09-10) with nothing on this screen to explain either. */
          <p className="hint" style={{ margin: 0 }}>
            The name there is just a label — yours to change. GitHub won't take one it has used
            before, so if it says the name is already taken, you've made a key for this website
            before: add anything to the end, or delete the old one first.
          </p>
        )}

        <label className="field" style={{ margin: 0 }}>
          <span>Paste your key</span>
          <input
            className="input mono"
            // A password field, and treated as one everywhere else too: never in a URL,
            // never in a message, never kept a moment longer than the request it is for.
            type="password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setKeyWiped(false);
            }}
            placeholder="github_pat_…"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label="Paste your GitHub key"
            disabled={connecting}
          />
        </label>

        {/* Said BEFORE the wait, because afterwards it costs a website. */}
        {keyKind === "classic" && (
          <div className="banner err" role="alert">
            <strong>That's GitHub's older kind of key.</strong> AWS accepts it and then sets your website up
            the old way — which can't be corrected afterwards, only deleted and built again, losing the
            website's address. Use the button above and make a <strong>fine-grained</strong> key: it starts
            with <span className="mono">github_pat_</span>.
          </div>
        )}
        {/* Only once there is enough typed to judge. A fine-grained key announces itself in
            its first eleven characters, so a warning before that would be scolding somebody
            for the act of typing — while `ghp_` is unmistakable at four, and gets the red
            banner above straight away. */}
        {keyKind === "unknown" && key.trim().length >= 12 && (
          <div className="banner warn">
            That doesn't look like the key GitHub makes on the page above — check you copied the whole
            thing. A fine-grained key starts with <span className="mono">github_pat_</span>.
          </div>
        )}
        {keyKind === "fine-grained" && (
          <div className="banner ok">That's the right kind of key.</div>
        )}
        {keyWiped && (
          <div className="banner info">
            Your key was cleared from this screen when the attempt finished — we never hold on to it. Paste
            it again to retry (it's still on your clipboard if you copied it a moment ago), or make a new
            one with the button above.
          </div>
        )}

        <details className="details">
          <summary>The repository belongs to an organisation</summary>
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            On GitHub's key page, choose the organisation as the owner rather than yourself — the page can
            only suggest one. Some organisations also require an owner to approve a new key before it
            works, so if AWS says it can't read the repository, that approval is usually what's missing.
          </p>
        </details>
      </div>

      <details className="details card card-2">
        <summary>What HostingPoppy needs from your repository</summary>
        <ul className="small muted" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
          {repoConstraints(serverRendered).map((rule) => (
            <li key={rule} style={{ marginBottom: 6 }}>
              {rule}
            </li>
          ))}
        </ul>
      </details>

      {/* The whole picture before anything is created (UX.md ground rule 2 + S5). */}
      {repo.kind === "ok" && (
        <div className="card">
          <h3>Ready when you are</h3>
          <ul className="small muted" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
            <li>
              We'll make a space for <strong>{name.trim() || "your website"}</strong> in your own AWS
              account and hand it your key.
            </li>
            <li>
              AWS will read{" "}
              <strong className="mono break">
                {repo.owner}/{repo.repo}
              </strong>
              , build the <span className="chip">{branchName}</span> branch, and{" "}
              {serverRendered
                ? "keep it running at a secure address of its own, putting each page together as somebody asks for it"
                : "put the result online at a secure address of its own"}
              .
            </li>
            <li>
              <strong>Every push to that branch goes live from then on</strong> — automatically, a few
              minutes later, without you coming back here.
            </li>
            <li>Your own domain is a separate step afterwards — the site is live and clickable before that.</li>
          </ul>

          {/* Money before commitment (UX.md ground rule 2) — and the two paths genuinely cost
              different things, so the sentence is not shared. A site that renders its own
              pages builds for longer AND keeps costing gently while people use it; quoting the
              finished-site figure at it would be an understatement the user only discovers on
              a bill. The honesty about the free allowance is the same either way, because the
              allowance is AWS's to change and never ours to promise. */}
          {serverRendered ? (
            <div className="card card-2" style={{ marginBottom: 12 }}>
              <p style={{ margin: 0 }}>
                Costs <strong>about a penny for each minute AWS spends building</strong>, plus a little
                for the pages your app puts together
              </p>
              <p className="hint" style={{ marginTop: 4 }}>
                An app like this takes longer to build than a folder of finished files — two to five
                minutes is normal — so a push costs a few pence rather than one. It also costs a little
                while people are using it, because AWS charges for the time it spends making pages:
                pennies for a quiet site, and it grows with your visitors. AWS gives every account a
                free build allowance, but we can't promise free: the allowance is AWS's, and AWS
                changes it. Storage and what visitors download are billed as usual. {AWS_PRICES_NOTE}
              </p>
            </div>
          ) : (
            <div className="card card-2" style={{ marginBottom: 12 }}>
              <p style={{ margin: 0 }}>
                Costs <strong>about a penny for each minute AWS spends building</strong>
              </p>
              <p className="hint" style={{ marginTop: 4 }}>
                A small site takes one to three minutes, so a few pushes a week is pennies a month — often
                nothing at all, because AWS gives every account a free build allowance. We can't promise
                free: the allowance is AWS's, and AWS changes it. Storage and what visitors download are
                billed as usual. {AWS_PRICES_NOTE}
              </p>
            </div>
          )}

          {/* Said before the button, because it is the one choice this screen makes that
              can't be changed afterwards: a website is connected to a repository or fed by
              hand, and Amplify has no path from one to the other. */}
          <div className="banner info" style={{ marginBottom: 12 }}>
            {serverRendered ? (
              <>
                This website will be built from GitHub for as long as it exists — an app that puts its
                own pages together has to be built, so there was never a hand-fed version of it, and AWS
                can't swap a website over later anyway.
              </>
            ) : (
              <>
                This choice is permanent for this website: connected to GitHub, or uploaded by hand —
                never both, and it can't be swapped over later. If you want the other way, make a second
                website.
              </>
            )}
          </div>

          {/* Whatever the backend said, and nothing added underneath it. Its own sentences
              are specific in a way nothing here could be — one of them is "your repository
              IS connected, its first build just didn't start", which any generic warning
              about leftovers would contradict on the very next line. */}
          {error && <FailureBanner error={error} style={{ marginBottom: 12 }} />}

          {connecting && (
            <p className="small muted" style={{ marginBottom: 12 }}>
              Making your website and asking AWS to build it — this takes a few seconds.
            </p>
          )}

          <button
            className="btn btn-primary btn-lg"
            onClick={() => void connectNow()}
            disabled={!ready || connecting}
            aria-busy={connecting || undefined}
          >
            {connecting && <span className="spinner" aria-hidden="true" />}
            {connecting ? "Connecting…" : "Connect and put my site online"}
          </button>
          {missing && !connecting && <p className="hint">{missing}</p>}
          <p className="small muted-2" style={{ marginTop: 10 }}>
            You can remove all of this with one click, any time.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A button that opens a page in the user's real browser.
 *
 * It exists because `window.open` and a plain link are silent no-ops inside the host's
 * frame, and because the bridge can refuse: when it does, the address is shown to copy
 * rather than leaving a button that visibly does nothing (AGENTS.md §9). The whole screen
 * depends on the user reaching two github.com pages, so a dead button here is a dead
 * screen.
 */
function ExternalButton({
  url,
  label,
  busyLabel,
  openExternal,
  primary,
  disabled,
}: {
  url: string;
  label: string;
  busyLabel: string;
  openExternal: (url: string) => void | Promise<void>;
  primary?: boolean;
  /** Held shut, with the reason rendered by the caller beside it — never silently. */
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await openExternal(url);
      setOpened(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className={`btn${primary ? " btn-primary" : ""}`}
        onClick={() => void open()}
        disabled={busy || disabled}
        aria-busy={busy || undefined}
      >
        {busy && <span className="spinner" aria-hidden="true" />}
        <span>{busy ? busyLabel : label}</span>
      </button>
      {opened && !failed && (
        <p className="hint" style={{ marginBottom: 0 }}>
          Opened in your browser. Nothing here changes until you come back.
        </p>
      )}
      {failed && (
        <p className="hint break" style={{ marginBottom: 0 }}>
          We couldn't hand that to your browser — open this address yourself:{" "}
          <span className="chip" style={{ userSelect: "all" }}>
            {url}
          </span>
        </p>
      )}
    </div>
  );
}
