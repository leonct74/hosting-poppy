// The AI helper prompt (AGENTS.md §9, REQUIRED) — and, because the prompt has to be built
// from the same options the form renders, the option catalogue itself.
//
// Onboarding here is a prompt, not a manual. The person this poppy is for has an AWS
// account and has never created hosting infrastructure; the two things they genuinely have
// to get right — hand over a BUILT site with index.html at its top level, or connect a
// repository with a key of the right kind — are things their own AI already knows how to do,
// if it is told our rules. So we hand them the rules, pre-written, and their next sentence
// is the goal.
//
// Everything below lives in ONE file on purpose. `buildHelperPrompt` reads the same
// constants NewSite renders, so a prompt that recommends an option the form doesn't have is
// not a bug we can have — it is a shape the code cannot express. (The alternative, a
// hand-maintained parallel text, drifts silently and is worse than no helper at all.)

import { MAX_UPLOAD_MB } from "./zip";

/**
 * One of the cards or fields the form shows, in the words the form uses.
 *
 * TWO lengths, and they are not the same job. `brief` is what the CARD says — one line, the
 * thing you need to choose correctly. `explain` is the full version: it goes to the AI helper
 * prompt, where more detail is strictly better, and sits behind a disclosure on the screen for
 * anyone who wants it.
 *
 * They were one field until 2026-09-12, which meant the screen carried prompt-length prose:
 * 600 words on the first screen a new user meets, roughly twice any other poppy in the fleet.
 * When everything is explained at the same volume, nothing stands out, and the founder could
 * not find the one thing he needed on his own product.
 */
export interface FormOption {
  id: string;
  label: string;
  /** The card's own line. Short enough to read without deciding to read it. */
  brief: string;
  /** The whole truth — for the copied AI prompt, and behind "What this means" on screen. */
  explain: string;
}

/** A card on "What are you putting online?" (UX.md S2). */
export interface SiteTypeOption extends FormOption {
  emoji: string;
  /**
   * True when this kind can only be built by AWS from its code, so the upload door does not
   * exist for it. Said out loud here because the screen hides that door rather than offering
   * it and failing — and because the copied prompt has to tell the user's AI the same thing
   * the screen will tell them.
   */
  fromRepoOnly?: boolean;
}

export const SITE_TYPES: SiteTypeOption[] = [
  {
    id: "finished",
    brief: "Files you have already built — or a plain HTML site.",
    emoji: "🗂",
    label: "A finished site",
    explain:
      "You already have the built files — HTML, CSS, JavaScript, images. A React, Vue, Svelte or Astro site once it's been built, or a plain hand-written one. We put them on a fast network that serves your visitors worldwide.",
  },
  {
    id: "nextjs",
    brief: "An app that builds its pages as people visit. Comes from GitHub.",
    emoji: "⚡",
    label: "A Next.js app",
    explain:
      "Your app puts each page together as somebody asks for it, instead of being a folder of finished files. AWS keeps it running for you. It has to be built from its code, so this one comes from GitHub.",
    fromRepoOnly: true,
  },
];

/** A card on "Where does your code live?" (UX.md S3) — the first fork in the road. */
export interface CodeSourceOption extends FormOption {
  emoji: string;
  /** The line under the title: what the user gets out of it, never how it works. */
  tagline: string;
  /** The path the poppy leads with, and the one selected when the screen opens. Exactly one. */
  recommended: boolean;
}

/**
 * The two ways a website's code reaches AWS.
 *
 * Both are first-class and neither is going away: connecting a repository is what somebody
 * with a project on GitHub expects (push, and it's live), and uploading is the only way in
 * for a site with no repository or no build step at all. The recommendation is a default,
 * not a verdict — which is why the second card explains what it is FOR rather than
 * apologising for not being the first.
 */
export const CODE_SOURCES: CodeSourceOption[] = [
  {
    id: "github",
    brief: "AWS builds your code and republishes on every push.",
    emoji: "🔁",
    label: "Deploy from GitHub",
    tagline: "Every push goes live",
    explain:
      "AWS reads the repository you choose, builds it inside your own account and puts the result online. From then on, every time you push to the branch you picked, your website updates itself — you never come back here to do it.",
    recommended: true,
  },
  {
    id: "upload",
    brief: "Send the finished files from this computer. No build step.",
    emoji: "🗂",
    label: "Upload a built site",
    tagline: "No repository, no build step",
    explain:
      "Hand the finished files over straight from this computer. Nothing is built anywhere: what you upload is exactly what visitors get, and you upload again whenever you want to change it.",
    recommended: false,
  },
];

/**
 * The three steps of connecting a repository, in the words the screen uses.
 *
 * Two of them happen on github.com rather than in this app, which is the whole reason they
 * are written down here as well as rendered: an outside AI advising the user has to know
 * that the key is created on GitHub, that it is used once, and above all that it must be the
 * FINE-GRAINED kind. An AI that helpfully says "make a personal access token" without that
 * word sends the user to GitHub's classic page, and the website that comes out the other
 * side is wired the deprecated way and cannot be corrected — only deleted and rebuilt
 * (DESIGN §3.2).
 */
export const GITHUB_STEPS: FormOption[] = [
  {
    id: "install",
    brief: "Choose on GitHub which repositories AWS may read.",
    label: "Let AWS read your repository",
    explain:
      "A button opens GitHub, where you choose which of your repositories AWS may read. It is GitHub's own page, not ours and not AWS's — and you can change or take that access back there at any time.",
  },
  {
    id: "repo",
    brief: "Its address, and the branch that goes live.",
    label: "Which repository, and which branch",
    explain:
      "Paste the repository's address — https://github.com/you/your-site — and say which branch should go live. Usually main.",
  },
  {
    id: "key",
    brief: "A one-time key so AWS can set up the automatic deploy.",
    label: "Create a key",
    explain:
      "A button opens GitHub's key page with almost everything filled in — one choice is yours to make there: under Repository access, pick Only select repositories and choose the repository you just named. Then press Generate and copy. The key is what lets AWS set up the automatic deploy; it is used once and HostingPoppy never stores it. It has to be a fine-grained token — the kind that starts with github_pat_ — because GitHub's older classic kind (ghp_) quietly sets the website up a way that cannot be corrected afterwards.",
  },
];

/** A card on "Where do your files come from?" (UX.md S3, the upload half). */
export const SOURCES: FormOption[] = [
  {
    id: "folder",
    brief: "Pick the folder your build produced — usually dist, build or out.",
    label: "Choose the folder",
    explain:
      "Pick the folder your build produced — usually called dist, build or out. Your browser packs it up before anything leaves your computer, and nothing outside the folder you pick is ever read.",
  },
  {
    id: "zip",
    brief: "Pick a .zip you made yourself.",
    label: "Choose a .zip",
    explain:
      "Already have your built site as a .zip? Use it as it is — as long as index.html sits at the top of the archive rather than inside a folder.",
  },
];

/**
 * The one thing the user types on this screen.
 *
 * The explanation says what the name is FOR and stops there. It used to promise "you can
 * change your mind later", which was not true in either direction: AWS stores the name when
 * the website is created, reduced to letters, numbers and hyphens, and nothing in
 * HostingPoppy can rename a website afterwards. The form shows the stored name before the
 * user commits instead (see `renamedSiteName`).
 */
export const NAME_FIELD = {
  label: "What should we call this website?",
  explain:
    "It's how you'll tell this site apart from your others, here and in your AWS account. It never appears on the site itself — and it can't be changed once the site exists, so pick one you'll still recognise.",
  placeholder: "My portfolio",
};

/**
 * Our ceiling on one site, in megabytes, for the sentences that quote it.
 *
 * The number itself lives in lib/zip.ts, beside the guard that enforces it and the note on
 * which side is the authority. Stating it twice is how the form ends up promising a limit
 * the code does not keep.
 */
export const MAX_SITE_MB = MAX_UPLOAD_MB;

/**
 * What the poppy needs from the FILES — the upload path's rules, in the user's terms.
 * Rendered on the form AND stated to the outside AI as constraints to plan within (§9 rule
 * 2); several of them are the difference between a site that works and a site that is live
 * and quietly broken.
 *
 * Kept separate from `REPO_CONSTRAINTS` because the two paths genuinely disagree: the first
 * rule below — you must build it yourself, we can't — is exactly what connecting a
 * repository removes, since AWS then does the building. One merged list would have to be
 * true of both, and would end up true of neither.
 */
export const CONSTRAINTS: string[] = [
  "It has to be built already. HostingPoppy can't run a build on your computer, so run your build yourself first (npm run build, or whatever your project uses) and hand over the folder it produces.",
  "index.html has to be at the top of what you upload, not inside another folder. If you're making a .zip, zip the contents of your build folder rather than the folder itself.",
  "Everything is served as plain files — HTML, CSS, JavaScript, images, fonts. There's no server code, no database and no secret keys: anything the site needs while people are using it has to come from an API that already exists somewhere else.",
  `The whole site has to come to less than ${MAX_SITE_MB} MB once it's packed up.`,
  "Links straight to a page, and refreshing on one, already work — anything that isn't a file is served index.html, so an ordinary client-side router is fine. Don't switch to hash routing (#/about) for this.",
];

/**
 * What the poppy needs from a REPOSITORY. The same job as `CONSTRAINTS`, for the path where
 * AWS does the building — so nothing here mentions packing folders or upload sizes, and the
 * costs are build minutes rather than storage.
 *
 * The last rule is the one people are surprised by afterwards rather than before: a
 * connected website rebuilds itself on every push, so choosing the branch is choosing what
 * the public sees.
 */
export const REPO_CONSTRAINTS: string[] = [
  "The repository has to be on GitHub, and it has to be one you can give access to. AWS builds it inside your own account — HostingPoppy can't build anything on your computer.",
  "AWS runs your build in the cloud and serves whatever it produces. If your project needs a particular build command or a particular output folder, put an amplify.yml file at the top of the repository: that's the file AWS reads.",
  "What gets served is whatever your project produces — plain files for a finished site, or pages your app puts together as people visit. Either way AWS builds it from the branch you pick.",
  "Everything in the build is public. Nothing secret — API keys, passwords, private data — can be in the repository or baked into the build.",
  "Every push to the branch you choose goes live on its own, a few minutes later. Pick a branch you're happy for the public to see.",
  "Each build costs about a penny a minute in your own AWS account, and a small site takes one to three minutes — usually inside AWS's free build allowance, though that's AWS's to change. Uploading instead uses no build minutes at all.",
];

/** The money rule for an app AWS keeps running, where the upload sentence above is not true. */
const SERVER_RENDERED_COST =
  "Each build costs about a penny a minute in your own AWS account. AWS also charges for keeping your app running and putting pages together as people visit, so the bill grows with your visitors rather than staying flat. There is no uploading instead of building for this kind.";

/**
 * The repository rules, for the kind of site being made.
 *
 * A function rather than two arrays because only ONE of the six differs: five are true of any
 * repository, and copying them to fork the sixth is how the two lists drift apart. The one that
 * differs is money, and it differs in the direction that matters — pointing a Next.js user at
 * "upload instead, it uses no build minutes" sends them to a door that does not exist for them.
 */
export function repoConstraints(serverRendered = false): string[] {
  if (!serverRendered) return REPO_CONSTRAINTS;
  return REPO_CONSTRAINTS.slice(0, -1).concat(SERVER_RENDERED_COST);
}

/**
 * The prompt the user copies into whatever AI they already talk to.
 *
 * Argument-free on purpose: nothing in it is specific to one install (no account id, no
 * region, no address), so there is nothing here that could go stale between the moment it
 * is copied and the moment it is pasted.
 */
export function buildHelperPrompt(): string {
  const constraints = CONSTRAINTS.map((c) => `- ${c}`).join("\n");
  const repoConstraints = REPO_CONSTRAINTS.map((c) => `- ${c}`).join("\n");

  const siteTypes = SITE_TYPES.map((t) => {
    const state = t.fromRepoOnly ? " (GitHub only — there is no upload for this one)" : "";
    return `   - "${t.label}" — ${t.explain}${state}`;
  }).join("\n");

  const codeSources = CODE_SOURCES.map(
    (s) => `   - "${s.label}" (${s.tagline})${s.recommended ? " — the one it recommends" : ""} — ${s.explain}`,
  ).join("\n");

  const githubSteps = GITHUB_STEPS.map((s, i) => `   ${i + 1}. "${s.label}" — ${s.explain}`).join("\n");

  const sources = SOURCES.map((s) => `   - "${s.label}" — ${s.explain}`).join("\n");

  return `You are helping me put my website online with HostingPoppy — an app that hosts a website inside MY OWN AWS account. I pay AWS directly at AWS's prices; there is no middleman and no monthly platform fee. I'll describe my website in my own words below. Your job is to tell me exactly what to build, how to get my code to AWS, and what to choose in HostingPoppy's form. If what I've written is unclear or missing something that matters, ask me at most three short questions first.

THERE ARE TWO WAYS IN, and they need different things from me. Recommend ONE and plan within its rules:
${codeSources}

WHAT HOSTINGPOPPY NEEDS — these are how the app works, not preferences. Plan within them, and say so plainly if what I've described doesn't fit.

If I connect a GitHub repository:
${repoConstraints}

If I upload a built site instead:
${constraints}

THE FORM I'M LOOKING AT, field by field:
1. "${NAME_FIELD.label}" — ${NAME_FIELD.explain} Example: "${NAME_FIELD.placeholder}".
2. "What are you putting online?" — two cards:
${siteTypes}
3. "Where does your code live?" — two cards:
${codeSources}
4. If I choose GitHub, three steps follow, and two of them happen on github.com rather than in the app:
${githubSteps}
5. If I upload instead, two ways to hand the files over:
${sources}
6. A last panel showing what's about to happen and the estimated monthly cost, and one button: "Put my site online".

WHAT HAPPENS AFTER I PRESS IT, so you can tell me what to expect:
- HostingPoppy makes a space for the site in my AWS account. Either AWS pulls my code from GitHub and builds it, or my files go straight up from my computer — and then AWS puts the site online at a secure (https) address it gives me. It usually takes a couple of minutes.
- If I connected GitHub, every later push to that branch rebuilds and republishes the site on its own. I don't come back here to deploy.
- HostingPoppy bills me nothing. AWS bills me directly for storage, for what visitors download, and — if AWS is building it — for build minutes. For a small site that is normally pennies a month. A Next.js app is the exception worth saying out loud: AWS also charges for keeping it running and putting pages together as people visit, so its bill grows with visitors instead of staying flat.
- I can remove everything it created with one click, at any time.
- Putting my own domain in front of it is a separate step afterwards. The site is live on the AWS address first, and stays live the whole time the domain is being set up.

ANSWER IN EXACTLY THIS SHAPE:
1. Build first: … (the exact command that builds my site and the folder it produces — I run it myself if I'm uploading, and it's what AWS will run if I connect GitHub)
2. Name to type: …
3. Which card: "A finished site" or "A Next.js app" — and if it's the second, say so plainly, because that one is built from GitHub and there is no upload for it (unless my app is set up for static export, in which case say so and treat it as a finished site)
4. What to hand over: "connect https://github.com/<owner>/<repo>, branch <name>" or "the folder <name>" / "a .zip of …" — with the exact steps either way
5. If it's GitHub, the key: remind me it must be the FINE-GRAINED kind (it starts with github_pat_), never the classic kind (ghp_), and tell me what to do if GitHub offers me the classic page instead
6. Check before I go: … (for an upload, how I confirm index.html is at the top level; for GitHub, that the build really produces a folder of files — plus anything in my project that will break once it's served as plain files: API keys in the build, calls to a local server, missing images)
7. What won't work once it's hosted this way: … or "nothing"

MY WEBSITE: `;
}
