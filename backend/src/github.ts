// Connecting a GitHub repository — everything about it that is a DECISION rather than an
// AWS call. Nothing here touches the network, AWS, or the filesystem.
//
// The mechanism this file serves is settled in DESIGN §3.2 and is not re-derived here. In
// short: the user installs the Amplify GitHub App (a github.com page), creates a token (a
// github.com page we open pre-filled), and we hand that token to `CreateApp` in THEIR AWS
// account. The one trap worth repeating, because it decides how the rest of this file is
// shaped:
//
//   ⚠️ The token must be FINE-GRAINED (`github_pat_…`). A classic `ghp_…` token silently
//   produces `repositoryCloneMethod=SSH` — the deprecated deploy-key wiring — instead of
//   `TOKEN`. Nothing warns you, the app appears to work, and it CANNOT be repaired in
//   place: `UpdateApp` with a bad token downgrades an app that was already right, so the
//   only fix is delete-and-recreate, which loses the site's address and forces the custom
//   domain to be validated again.
//
// So the prefix check below is a WARNING shown before the user spends their time, never a
// refusal: GitHub can add prefixes, and the authoritative detector is the read-back in
// amplify.ts (`repositoryCloneMethod === "TOKEN"`), which is the only thing AWS will tell us.
//
// The two github.com addresses below are also needed on screen, before the backend is
// involved at all, and the frontend is a separate build — so it keeps its own copy of them,
// the same arrangement types.ts describes for the wire contract. KEEP THEM IN STEP: the
// parameters in `fineGrainedTokenUrl` are the mechanism, not decoration, and a copy that
// drifts sends the user to make a key with the wrong permissions.
//
// THE TOKEN IS THE USER'S. It travels from their screen to their own AWS account and
// nowhere else. It is never logged, never written down, never put in an error message and
// never sent back to the frontend — `redactToken` below exists so that even an error we did
// not write cannot leak it.

/** A repository we are prepared to hand to AWS. */
export interface ParsedRepo {
  /** The GitHub account or organisation that owns it. */
  owner: string;
  /** The repository's own name, without a `.git` suffix. */
  repo: string;
  /** The canonical `https://github.com/owner/repo` address — what Amplify is given. */
  url: string;
}

/**
 * GitHub's own rules for an account name: letters, digits and hyphens, never at either end,
 * up to 39 characters. Anything else is a typo or a different service.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** A repository name: letters, digits, hyphen, underscore and dot, up to 100 characters. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** The only host we can connect today. */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Turn whatever the user pasted into an owner and a repository.
 *
 * People paste four things, and all four are accepted because rejecting any of them reads as
 * "you typed it wrong" when they did not:
 *   https://github.com/owner/repo         — the address bar
 *   https://github.com/owner/repo.git     — the "clone with HTTPS" button
 *   git@github.com:owner/repo.git         — the "clone with SSH" button
 *   owner/repo                            — how developers say it out loud
 * A trailing slash, a trailing `.git`, and a `www.` are all tolerated.
 *
 * Returns null for anything else — including a repository on another service, which
 * `validateRepoUrl` turns into its own sentence, because "only GitHub today" and "that isn't
 * a repository address" send the user to two different places.
 */
export function parseRepoUrl(input: string): ParsedRepo | null {
  const text = (input ?? "").trim();
  if (!text) return null;

  const path = repoPath(text);
  if (path === null) return null;

  const segments = path.split("/").filter(Boolean);
  // Exactly two, deliberately. Accepting a deeper link (`…/tree/main/src`) would mean
  // guessing which part of it is the repository, and a wrong guess sends AWS looking for a
  // repository the user does not own. Being visibly strict here costs one re-paste; being
  // quietly clever costs a failed connection nobody can explain.
  if (segments.length !== 2) return null;

  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  // `.` and `..` pass the character test and are not repositories.
  if (repo === "." || repo === "..") return null;

  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/**
 * The `owner/repo` part of whatever was pasted, or null when this is not a GitHub address
 * at all. Kept separate from the parsing above so "not GitHub" stays distinguishable from
 * "not a repository".
 */
function repoPath(text: string): string | null {
  // git@github.com:owner/repo.git — the SSH form has no scheme and uses a colon.
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i.exec(text);
  if (ssh) return GITHUB_HOSTS.has((ssh[1] ?? "").toLowerCase()) ? trimPath(ssh[2] ?? "") : null;

  // Anything with a scheme, or anything whose first label looks like a host name.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^/\s]+\.[^/\s]+\//.test(text)) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return null;
    }
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
    return trimPath(url.pathname);
  }

  // The bare `owner/repo` shorthand. A host would have a dot in its first label, so
  // "gitlab.com/x/y" cannot reach here and is answered as "not GitHub" above.
  if (/^[^/\s]+\/[^/\s]+\/?$/.test(text)) return trimPath(text);
  return null;
}

function trimPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** True when the text names a host we can't connect — used to say so in as many words. */
function namesAnotherHost(text: string): boolean {
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:git@)?([^/:\s]+\.[^/:\s]+)[:/]/i.exec(text.trim());
  return !!host && !GITHUB_HOSTS.has((host[1] ?? "").toLowerCase());
}

/**
 * A human sentence when the repository address won't do; null when it's fine.
 *
 * Same shape as sites.ts's validators, and for the same reason: this is a rule the user
 * bumps into, so the sentence matters more than the check.
 */
export function validateRepoUrl(input: string): string | null {
  const text = (input ?? "").trim();
  if (!text) return "Paste the address of your repository on GitHub, like https://github.com/you/your-site.";
  if (namesAnotherHost(text)) {
    return "HostingPoppy can only connect repositories on GitHub today — if your code is somewhere else, upload your built site instead.";
  }
  if (!parseRepoUrl(text)) {
    return "That doesn't look like a repository address — paste the one from your repository's page, like https://github.com/you/your-site.";
  }
  return null;
}

/**
 * The page where the user lets AWS read their repositories.
 *
 * Amplify runs one GitHub App per region, and installing it is what actually scopes access:
 * the user picks which repositories AWS may see, on GitHub's own screen. The AWS console is
 * not involved at any point, which is the whole reason this path is shippable (DESIGN §3.2).
 */
export function amplifyGitHubAppUrl(region: string): string {
  const name = (region ?? "").trim().toLowerCase();
  return `https://github.com/apps/aws-amplify-${name}/installations/new`;
}

export interface TokenUrlInput {
  /** The repository's owner, so GitHub pre-selects the right account. */
  owner: string;
  /** What the token is called in the user's GitHub settings. */
  name?: string;
  /** How long GitHub offers to keep it alive, in days. */
  expiresInDays?: number;
}

/**
 * 30 days. The token is only read once — during `CreateApp`, where AWS exchanges it for the
 * GitHub App installation it uses from then on — so nothing breaks when it expires, and a
 * short life is one less credential left lying around. It is not 7 because people make the
 * token, get interrupted, and come back to it.
 */
const DEFAULT_TOKEN_DAYS = 30;

/**
 * GitHub's new-token page, pre-filled, so the user only has to press *Generate token*.
 *
 * The template parameters (GitHub added them on 2025-08-26) are fixed by DESIGN §3.2 and are
 * exactly the four permissions Amplify needs: read the code, read the metadata, read the
 * repository's administration, and write its webhooks — the last is what makes a push
 * deploy. Everything else is left alone.
 *
 * `target_name` only PRE-SELECTS the owner visually; for an organisation the user still
 * chooses it themselves, and the organisation's policy may require an owner to approve the
 * token. The screen has to say so — this URL cannot.
 */
export function fineGrainedTokenUrl(input: TokenUrlInput): string {
  const params = new URLSearchParams({
    name: (input.name ?? "HostingPoppy").trim() || "HostingPoppy",
    target_name: (input.owner ?? "").trim(),
    expires_in: String(input.expiresInDays ?? DEFAULT_TOKEN_DAYS),
    contents: "read",
    metadata: "read",
    administration: "read",
    repository_hooks: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/** The prefix GitHub gives every fine-grained token. */
const FINE_GRAINED_PREFIX = "github_pat_";

/** The prefixes GitHub gives the classic tokens — the ones that produce the wrong wiring. */
const CLASSIC_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"];

/**
 * Does this look like the right KIND of token?
 *
 * A guess, on purpose, and never a gate: GitHub owns this prefix and can add more, so
 * refusing an unfamiliar one would break the poppy the day that happens. What it buys is a
 * warning BEFORE the user spends a minute connecting something that will have to be deleted
 * — the authoritative check is amplify.ts reading `repositoryCloneMethod` back from AWS.
 */
export function looksFineGrained(token: string): boolean {
  return (token ?? "").trim().startsWith(FINE_GRAINED_PREFIX);
}

/**
 * The warning to show beside the token box, or null when nothing looks wrong. Never quotes
 * the token back — not even a piece of it.
 */
export function tokenWarning(token: string): string | null {
  const value = (token ?? "").trim();
  if (!value || looksFineGrained(value)) return null;
  if (CLASSIC_PREFIXES.some((p) => value.startsWith(p))) {
    return "That looks like a classic token, which connects your repository the old way — AWS can't change it afterwards, so it would have to be set up again from scratch. Make a fine-grained token instead.";
  }
  return "That doesn't look like a fine-grained token (they start with github_pat_). Check you copied the whole thing from the fine-grained token page.";
}

/**
 * A human sentence when the token can't be used at all; null when it's worth trying.
 *
 * Only the unusable is refused here — empty, or something with whitespace in it, which is
 * always a half-copied paste rather than a token. The KIND of token is a warning, not a
 * refusal (see above).
 */
export function validateToken(token: string): string | null {
  const value = (token ?? "").trim();
  if (!value) return "Paste the access key you generated on GitHub — HostingPoppy sends it straight to your own AWS account and keeps no copy.";
  if (/\s/.test(value)) return "That key has a space or a line break in it — copy it again from GitHub, all in one piece.";
  if (value.length < 20) return "That key looks too short — copy the whole thing from GitHub, it's about 90 characters long.";
  return null;
}

/**
 * Take a secret back out of text that is about to be logged or shown.
 *
 * Belt and braces: nothing we write puts the token in a message, but an error from AWS or
 * from the runtime is not ours to predict, and it passes through a log line and a
 * "technical details" disclosure on its way to a screen. One function, applied at the only
 * boundary the token crosses, is cheaper than trusting every future error to behave.
 */
export function redactToken(text: string, token: string): string {
  const secret = (token ?? "").trim();
  if (!secret || secret.length < 8 || !text) return text;
  return text.split(secret).join("[the access key you pasted]");
}

/**
 * The branch AWS serves and rebuilds, when the user hasn't said otherwise.
 *
 * The same name the upload path uses (sites.ts `LIVE_BRANCH`), because it is what nearly
 * every repository calls its main line. Not imported from there: this module is about
 * GitHub, that one is about AWS, and the coincidence is not a dependency.
 */
export const DEFAULT_BRANCH = "main";

/** Trim, and drop the decorations people paste with a branch name (`origin/`, quotes). */
export function normalizeBranch(raw: string): string {
  return (raw ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .trim();
}

/**
 * A human sentence when the branch name won't do; null when it's fine.
 *
 * Git's own rules, kept to the parts a person can trip over. A name we accept but Git does
 * not simply means AWS finds no such branch and the first build never starts — so the
 * checks here are worth more than they look.
 */
export function validateBranch(raw: string): string | null {
  const branch = normalizeBranch(raw);
  if (!branch) return "Which branch should go live? Most repositories use main.";
  if (branch.length > 255) return "That branch name is longer than Git allows — check it for typos.";
  if (/\s/.test(branch)) return "A branch name has no spaces in it — check it against the branch list on GitHub.";
  // The characters Git itself forbids in a ref, plus the control range, which only ever
  // arrives by paste.
  if (/[~^:?*[\\\]]/.test(branch) || /[\u0000-\u001f\u007f]/.test(branch)) {
    return "That branch name has characters Git doesn't allow — check it against the branch list on GitHub.";
  }
  if (branch.includes("..") || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    return "That doesn't look like a branch name — copy it from the branch list on GitHub, like main.";
  }
  if (branch.startsWith("-") || branch.startsWith(".") || branch.endsWith(".") || branch.endsWith(".lock")) {
    return "That doesn't look like a branch name — copy it from the branch list on GitHub, like main.";
  }
  return null;
}

/**
 * The build instructions AWS follows when the repository doesn't carry its own.
 *
 * WHY WE SUPPLY ONE AT ALL: Amplify's console flow runs framework detection and writes the
 * build settings for you. Creating an app through the API does not — so a repository with no
 * `amplify.yml` of its own has nothing to build with and every build fails on a fresh app
 * with a message about missing build settings. A repository that DOES have its own
 * `amplify.yml` wins: this is the fallback, not an override.
 *
 * It covers the two shapes this poppy is for, and refuses to guess beyond them:
 *
 *  - **A plain site** (no package.json, or no `build` script): the repository IS the site,
 *    so it is published as it is, minus `.git` and `node_modules`.
 *  - **A built site** (`npm run build`): the output is looked for in the five directories
 *    frameworks actually use, in the order that resolves the ambiguous ones correctly —
 *    `dist` before `public` (Vite ships both), `build` before `public` (Create React App's
 *    `public/index.html` is a template, not a site).
 *
 * If a build ran and left nothing recognisable, the build FAILS with a sentence naming what
 * to do. That is deliberate: the alternative is publishing whatever happened to be lying
 * around — a template with unreplaced placeholders, or the previous build — and a site that
 * is quietly wrong is worse than a build that stopped and said why.
 *
 * The staging directory exists because `baseDirectory` is fixed text in this file, while the
 * real output directory is only known once the build has run. The build phase is deliberately
 * ONE command rather than two: the second half reads a variable the first half set, and
 * whether AWS runs each command in the same shell is not a promise worth leaning on.
 */
export function defaultBuildSpec(): string {
  return `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - |
          if [ -f package-lock.json ]; then
            npm ci --no-audit --no-fund
          elif [ -f package.json ]; then
            npm install --no-audit --no-fund
          else
            echo "No package.json here, so there is nothing to install."
          fi
    build:
      commands:
        - |
          if [ -f package.json ] && node -e "var s=(require('./package.json').scripts)||{};process.exit(s.build?0:1)"; then
            npm run build
            BUILT=yes
          else
            echo "No build step in this repository, so the files in it are the site."
            BUILT=no
          fi
          OUT=""
          for candidate in dist build out _site public; do
            if [ -f "$candidate/index.html" ]; then OUT="$candidate"; break; fi
          done
          rm -rf .hostingpoppy-site
          mkdir -p .hostingpoppy-site
          if [ -n "$OUT" ]; then
            echo "Publishing the site your build put in $OUT"
            cp -R "$OUT/." .hostingpoppy-site/
          elif [ "$BUILT" = "yes" ]; then
            echo "The build finished, but there is no index.html in dist, build, out, _site or public."
            echo "Add an amplify.yml to your repository saying where your built site ends up, then push again."
            exit 1
          elif [ -f index.html ]; then
            echo "Publishing this repository as it is"
            tar -cf - --exclude=./.git --exclude=./node_modules --exclude=./.hostingpoppy-site . | (cd .hostingpoppy-site && tar -xf -)
          else
            echo "There is no index.html in this repository, so there is no site to publish yet."
            exit 1
          fi
  artifacts:
    baseDirectory: .hostingpoppy-site
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
`;
}

/**
 * The build instructions for a Next.js app.
 *
 * WHY WE SUPPLY ONE AT ALL, when Amplify recognises Next.js perfectly well in its console:
 * the same reason {@link defaultBuildSpec} exists. Framework detection is part of the CONSOLE
 * flow, not the API, and this poppy only ever creates apps through the API. A repository that
 * carries its own `amplify.yml` still wins — this is the floor, not an override.
 *
 * WHY IT IS A SEPARATE SPEC and not `defaultBuildSpec`: that one copies a folder of finished
 * files into a staging directory and publishes it. Run against a Next.js app it would "succeed"
 * and serve nothing that renders — the failure this poppy's whole kind-mapping exists to make
 * impossible.
 *
 * `baseDirectory: .next` is the part that is easy to get wrong and impossible to notice: it is
 * what makes Amplify Hosting treat the output as something to RUN rather than files to serve,
 * and AWS requires it even for a Next.js 14+ app that only generates static pages (see the
 * `platform` documentation on CreateApp). An app configured for `output: "export"` genuinely
 * produces a folder of files instead — that one belongs on the finished-site path, which is
 * what the screen tells its user, and it is why that sentence is worth keeping there.
 *
 * The install step mirrors the other spec's defensiveness rather than assuming `npm ci`: that
 * needs a `package-lock.json`, and a repository without one would fail on its first build with
 * an error about a missing lockfile — which reads as "my app is broken", not "add a file".
 */
export function nextBuildSpec(): string {
  return `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - |
          if [ -f package-lock.json ]; then
            npm ci --no-audit --no-fund
          else
            npm install --no-audit --no-fund
          fi
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
`;
}

/**
 * The GitHub page for one branch of a repository — `…/tree/main`.
 *
 * The Amplify console links a branch to GitHub rather than to itself, and it is right to:
 * a branch IS a GitHub branch, and the code is what a person opening it wants to see. The
 * Resources tab does the same (2026-09-12, the founder's suggestion after an Amplify console
 * link rendered a blank page).
 *
 * Pure and tested because it is string surgery on user input: a repository address arrives
 * however the user pasted it — with a `.git` suffix, with a trailing slash, sometimes both —
 * and `…/site.git/tree/main` is a 404 that would look like our bug rather than a typo.
 * Returns undefined rather than a broken link when there is nothing usable to build from.
 */
export function branchUrl(repository: string | undefined, branch: string): string | undefined {
  // Trailing slashes FIRST: "…/site.git/" hides the .git from a $-anchored match, and the
  // half-stripped result is a 404 that reads as our bug. (Caught by its own test, 2026-09-12.)
  const base = (repository ?? "").trim().replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const name = branch.trim();
  if (!base || !name) return undefined;
  // Only GitHub has a /tree/ path in this shape, and this poppy only connects GitHub —
  // building it for anything else would invent a URL we have no reason to believe in.
  if (!/^https?:\/\/(www\.)?github\.com\//i.test(base)) return undefined;
  return `${base}/tree/${name.split("/").map(encodeURIComponent).join("/")}`;
}
