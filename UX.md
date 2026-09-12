# HostingPoppy — UX SPEC

**Audience assumption: the user has an AWS account (AgentsPoppy got them that far) and has
NEVER created hosting infrastructure.** They know these words: website, domain, visitors,
monthly cost, GitHub. They do not know these words: CloudFront, ACM, OAC, ECR, distribution,
origin, task definition. **AWS vocabulary is banned from every primary screen** — it may
appear only in the Resources tab (where transparency REQUIRES real resource names) and
behind "Advanced" disclosures.

## Ground rules (apply to every screen)

1. **One decision per screen.** Every choice has a recommended default pre-selected.
   The whole happy path is ≤ 5 screens and ≤ 5 minutes of the user's attention.
2. **Money before commitment.** No resource is created before the user has seen the
   monthly estimate for *their* choices, labelled *"billed by AWS to you, at AWS's
   prices — we add nothing."*
3. **Success comes early.** Deploy to the temporary URL FIRST; the site is live and
   clickable within minutes. The custom domain is attached afterwards — DNS waits never
   block the first win.
4. **Every wait tells a story.** Multi-minute AWS operations (CDN setup, certificates,
   DNS) get a staged checklist with plain labels and honest time ranges
   ("usually 2–5 minutes"), never a bare spinner. (MailPoppy deploy-step pattern.)
5. **Every error is a sentence a human wrote**, naming the one thing to do next.
   Raw AWS errors go in a collapsible "technical details" section. (describeError pattern.)
6. **The exit is visible from the entrance.** "Remove everything with one click, any
   time" appears on the very first screen — fear of mess is the biggest barrier to trying.
7. **Reversible by default.** Every setting screen states what happens when changed
   ("takes effect in ~1 minute, no downtime").

## Screen-by-screen

### S1 — Home / empty state
- Headline: **"Put your website online — in your own AWS account."**
- Sub: "Pay AWS at cost. No middleman, no lock-in. Remove everything with one click."
- Primary button: **Set up my website**. Secondary: "How it works" (3-panel explainer:
  your code → your AWS → your domain).
- After the first site exists, S1 becomes the **site list** (S8) with an "Add another
  website" button — the poppy hosts many sites.

### S2 — "What are you putting online?"
Two cards (auto-detected later when a repo is connected first):
- 🗂 **"A finished site"** — "You already have the built files (HTML/CSS/JS — e.g. a
  React, Vue, or plain site). We'll serve them worldwide on a fast network."
- ⚡ **"A Next.js app"** — "Your app renders pages on a server. We'll run it for you
  and scale it."
No mention of S3/CloudFront/Amplify/App Runner here.

### S3 — "Where does your code live?"
- Primary card: **"Connect GitHub"** — "Deploy automatically every time you push."
  (The mechanics — GitHub App install / connection handshake — are Phase 0's job; the
  screen contract is: click, authorize in the browser, pick a repo + branch, done.)
- Secondary card: **"Upload a zip"** — for the finished-site path: "Drop in your build
  folder as a .zip." Uses the file picker (user-mediated handover; confinement-safe).
- Footnote: "You can switch later."

### S4 — "How should AWS bill you?"
The audience question first, with the founder-approved copy beside it:
> **"About how many people are on your site at a busy moment?"**
> *"We ask this to set your always-on floor — the smallest setup that serves your usual
> traffic, so you pay the minimum possible. If more people show up, the infrastructure
> scales up automatically — your site stays up. The only limit is a spending ceiling
> you control."*

Then two cards, each showing a live estimate computed from that number:
- **On-demand** — "Pay per visit. Costs about **$X/mo** at your traffic — and about $0
  in months when nobody comes." Badge: *recommended for most sites*.
- **Dedicated** — "Always warm, never a cold start. From about **$Y/mo**."
(A finished-site/SPA deployment skips this screen — it's effectively free; the estimate
is shown inline on S5 instead.)

### S4b — Dedicated details (only if Dedicated chosen)
- Summary sentence: "We'll keep **1 server warm** (about $Y/mo) and add more
  automatically when traffic grows."
- **Optional max-spend field**: "Don't scale beyond ~$___/month." Helper: "$60/mo ≈
  enough for ~900 people at once. If your site ever hits this ceiling, it slows down
  instead of costing more — and we'll tell you."
- "Advanced" disclosure: instance size, warm count, per-instance concurrency — with
  the plain defaults pre-filled and a "leave the defaults" note (PolicyEditor pattern).

### S5 — Confirm & go
One screen with the whole picture: what's deploying, from where, billing choice,
estimated monthly cost, and the reassurance line "You can remove all of this with one
click in Settings." Button: **Put my site online**.

### S6 — Progress
Staged checklist, human labels, honest times:
- "Preparing your space in AWS" (seconds)
- "Building your site from GitHub" (1–5 min, live build log behind a disclosure)
- "Setting up the worldwide network" (2–10 min for CDN paths)
- "Securing it with HTTPS" (1–5 min)
- Done → **confetti-level moment**: "Your site is live" + the temporary URL as a big
  clickable link + screenshot-style preview if feasible.
Each stage that fails flips to a human sentence + one action ("Retry" / "Fix on GitHub
and push again").

### S7 — "Your domain" (offered right after the first success, skippable)
- Input: `yourdomain.com` (force-lowercase, autoCapitalize off — MailPoppy lesson).
- Domain already in Route53 in this account → "We can connect it for you" → one click,
  then "Waiting for the internet to notice (usually minutes, can take up to an hour)."
- Domain elsewhere → the exact records in a copy-paste table + registrar-agnostic
  instructions + a **"Check my DNS"** button that polls and celebrates when it lands.
- Explicitly reassure: "Your site stays live on the temporary address the whole time."

### S8 — Site dashboard (the everyday screen)
Per site: status pill (Live / Deploying / Attention), the URL(s), last deploy ("2h ago —
'fix navbar' from GitHub"), this month's **estimated cost so far**, and for dedicated a
live "servers right now: 1 of max 6" readout. Actions: **Deploy again**, **Settings**
(domain, billing mode, audience/max-spend, GitHub branch), **Remove this website**
(type-the-domain-to-confirm; MailPoppy Danger Zone pattern).
- Ceiling-hit banner when applicable: "Your site hit its spending ceiling yesterday at
  14:02 — visitors saw slower pages. Raise the ceiling?" [Raise to $90/mo] [Keep it]
- Tasteful cross-link: "Want visitor stats? TrafficPoppy measures in your own AWS."

### S9 — Resources tab (fleet transparency requirement)
The ONE place real AWS names appear: every resource grouped by service with console
deep-links + the created/deleted ledger timeline. Header: "Everything HostingPoppy
created in your account — nothing hidden." (Lifted from MailPoppy ResourcesView.)

## Error-language dictionary (seed list, grows in Phase 1)
| Raw condition | What the user reads |
|---|---|
| ACM validation stuck | "We're waiting for your domain provider to confirm — this can take up to an hour. Nothing is wrong yet." |
| Build failed (CodeBuild/Amplify) | "Your site didn't build. The last line of the build log usually says why — here it is. Fix it on GitHub and push again." |
| Route53 zone not found | "This domain isn't managed in this AWS account, so we'll show you two records to add wherever you bought it." |
| Region capability missing | "AWS doesn't offer this hosting type in <region> yet — these regions work: …" |
| Broker/credentials down | "Can't reach your AgentsPoppy connection — reopen HostingPoppy from AgentsPoppy." |

## Copy tone
Short sentences. "Your site", "your account", "we set up / you own". Never "provision",
"distribution", "origin", "stack". Numbers rounded and honest ("about $4/mo", never
"$3.87"). Every promise enforceable (the fuse rule from DESIGN §7).
