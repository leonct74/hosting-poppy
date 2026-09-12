# HostingPoppy — DESIGN

**Status: PLANNING COMPLETE (2026-08-21).** Name decided by the founder: **HostingPoppy**
(id `com.hostingpoppy.desktop`). Detailed planning lives in **`UX.md`** (screen-by-screen
frontend spec — the founder's headline requirement: friendly for people who never created
hosting in AWS) and **`PLAN.md`** (implementation phases, architecture, de-risk gates).
Working decisions adopted there: GitHub connect primary (founder), App Runner for
dedicated, SPA-first build order, v1 ships with Next.js/GitHub, and **HostingPoppy is FREE**
(founder, 2026-08-24 — no price to install, nothing sold inside). Nothing is open. Next step:
**live verification against a real AWS account** (PLAN §4).

A poppy that sets up web hosting for a user's website **inside their own AWS account** —
server-side-rendered apps (Next.js) or single-page apps — in minutes, with their own
domain pointed at it. Two offers: **on-demand** (pay per request, scales to ~zero) or
**dedicated** (always-warm capacity with auto-scaling sized to their audience).

> Pitch: *Vercel/Netlify, but in your own AWS account. No per-seat pricing, no platform
> lock-in, traffic billed at AWS cost. Your site, your cloud.*

---

## 1. Who it's for

- A developer or small team with a Next.js app or an SPA (React/Vue dist folder) who
  wants it live on their domain **today**, without learning CloudFront, ACM, ALBs, or
  task definitions.
- Vercel/Netlify users hitting bandwidth/seat pricing walls who already have (or will
  make) an AWS account.
- Agencies hosting client sites: one AWS account per client, one poppy, full teardown.

Not for (v1): monorepos with exotic build steps, websockets-heavy apps, non-Node SSR
(Rails/Django), databases (they can attach their own; we host the web tier).

## 2. The two offers (user-facing framing)

| | **On-demand** | **Dedicated** |
|---|---|---|
| Billing feel | Pay per visit; ~$0 when nobody comes | Fixed monthly floor, predictable |
| Cold starts | Possible on rare traffic | None — always warm |
| Best for | Portfolios, launches, spiky traffic | Production apps with steady users |
| Scaling | Automatic, invisible | **Sized by the wizard** (§7), auto-scales with concurrent users |

The picker asks one question — "About how many people are on your site at a busy
moment?" — and shows an honest monthly estimate for each offer before anything is
created (§8).

## 3. Engine mapping (what we actually provision)

**Decision (2026-08-23, corrected during implementation — supersedes the draft below):
both static sites and Next.js SSR run on AWS Amplify Hosting. One engine, not two.**
Dedicated stays App Runner (Phase 4).

| Offer the user picks | What we provision |
|---|---|
| A finished site (SPA/static) | Amplify Hosting app, `platform: WEB` |
| A Next.js app (on-demand) | Amplify Hosting app, `platform: WEB_COMPUTE` |
| Dedicated (always warm) | App Runner service (Phase 4) |

### Why NOT the drafted "S3 (private) + CloudFront + ACM" for static sites

The draft was right on paper and unshippable in practice — the platform's own security
mechanism forbids it, and finding out cost one API check rather than a live deploy:

- A private S3 origin behind CloudFront requires an **Origin Access Control**. Verified
  against the AWS SDK's type definitions: `CreateOriginAccessControl` accepts **no tags**,
  and CloudFront exposes **no ARN pattern** for OACs.
- AgentsPoppy's invariant **I3 (born-tagged-or-refused)** conditions every create under a
  `tagged-as-self` grant on `aws:RequestTag`. An untaggable create can only be granted by
  **name-scoping**, which an OAC has no name to scope by.
- That leaves two dead ends: a `*`-scoped grant carrying `Delete/UpdateOriginAccessControl`
  — which the real risk assessor rates **red** ("can change or delete ANY CloudFront
  resource"), disqualifying — or never deleting the OAC, which **leaves a trace** and fails
  leaves-no-trace. A public bucket would dodge both and give up the private-origin promise.

### Why Amplify Hosting is the better answer anyway

Verified against the SDK types before committing to it:

- **`CreateApp`/`CreateBranch` accept `tags`** → born tagged, so one `tagged-as-self`
  grant covers the whole footprint and the host's tag sweep can always find it.
- **Manual deploys need no bucket at all**: `CreateDeployment` returns a **presigned
  `zipUploadUrl`**; the backend PUTs the user's zip to it and calls `StartDeployment`.
  Amplify expands the zip itself. No S3 grant, no OAC, no invalidation, no unzipping in
  our process — a materially smaller attack surface *and* less code.
- **TLS is managed**: `CreateDomainAssociation` issues and renews the certificate and
  returns the exact DNS records to publish. No ACM lifecycle, no us-east-1 special case.
- **SPA routing is a first-class setting** (`customRules`), not a CloudFront 403/404 hack.
- **Teardown is one call**: `DeleteApp` removes branches, deployments, domain association
  and certificate together.
- **It is the same service Phase 3 needs for Next.js** — SSR becomes a `platform` value on
  a code path already proven, instead of a second engine.

Cost is the one honest trade: CloudFront's always-free 1 TB/month egress would beat
Amplify's $0.15/GB for a busy site. For the sites this poppy targets the difference is
cents a month, and it buys a design that can actually ship. Revisit if a user ever serves
enough traffic for it to matter.

### 3.1 The untaggable-create trap (found by review, 2026-08-24)

The first implementation put all four Amplify `Create*` actions in one `tagged-as-self` grant.
That would have shipped a poppy that **could never deploy a website**, and it is worth recording
precisely, because the same trap is waiting for every future poppy.

The broker compiles a `tagged-as-self` grant into two IAM statements, and it chooses between them
by **matching the action name** (`/:(Create|Request)/`):

- creates get `aws:RequestTag/agentspoppy:app` — born tagged, or refused;
- everything else gets `aws:ResourceTag/agentspoppy:app` — only resources already tagged as ours.

`CreateDeployment` and `CreateDomainAssociation` accept **no tags** (verified against the SDK's
types: `{appId, branchName, fileMap}` and a domain request with no tags field). An absent
`aws:RequestTag` makes `StringEquals` false, so the statement never matches and the call is
denied. The parent app's tags are irrelevant — IAM is evaluating the *request*, not the app.

The same applies to the other half: `JobSummary` and `DomainAssociation` expose no `tags` field
either, so jobs, deployments and domain associations cannot be reached by a `ResourceTag`
condition at all. **Only apps and branches are taggable**, so only they can be tag-scoped.

Hence three grants: `tagged-as-self` for apps and branches, a name-scoped
`arn:aws:amplify:*:*:apps/*` for deployments/jobs/domains, and account-wide read-only `ListApps`.
Ownership of the untaggable resources is enforced by our own `isOurs` check rather than by IAM,
and the manifest description says so in plain words, because the user approves that sentence.

**Why offline testing missed it:** the manifest validated, the rating stayed amber, and all 285
tests passed. Nothing but real IAM would have failed. `scripts/assess-permissions.mjs` now carries
a gate — a create may sit in a tagged grant only if its SDK request type has a `tags` field — so
the class of bug fails the build instead of the user's first deploy.

### 3.2 Connecting a GitHub repository — the unknown, resolved (2026-08-24)

The plan's biggest open risk was whether a repo could be connected **without the user ever
opening the AWS console**. AWS's own documentation settles it: **yes**, and the console is not
involved at any point. Amplify moved to a GitHub App for repository access, and the
SDK/CloudFormation path is explicitly supported alongside it
(`docs.aws.amazon.com/amplify/latest/userguide/setting-up-GitHub-access.html`).

The sequence, all of it either a github.com page or an API call we make:

1. **Install the Amplify GitHub App** — `https://github.com/apps/aws-amplify-<region>/installations/new`,
   opened in the user's browser. They choose *which repositories* AWS may read. This is the step
   that scopes access, and it is GitHub's own screen, not ours and not AWS's console.
2. **Create a token** — opened pre-filled, so the user only presses *Generate token*.

   ⚠️ **It must be a FINE-GRAINED token, not a classic one, and AWS's own instructions send you
   to the wrong page.** The token TYPE — not its scopes — decides which wiring Amplify uses: a
   classic `ghp_` token yields `repositoryCloneMethod=SSH`, the deprecated deploy-key path, while
   a fine-grained `github_pat_` token yields `TOKEN`, the GitHub App path. Nothing tells the user
   this; the app simply works while sitting on legacy wiring, and it is **not repairable in
   place** — `UpdateApp` with the wrong token type downgrades an app that was already correct, so
   the only fix is delete and recreate, which loses the site's address and forces the custom
   domain to be re-validated.

   So we open `https://github.com/settings/personal-access-tokens/new` with the template
   parameters GitHub added on 2025-08-26 (`name`, `target_name`, `expires_in`, `contents=read`,
   `metadata=read`, `administration=read`, `repository_hooks=write`). Note `target_name` only
   pre-selects the resource owner visually — for an organisation repo the user still has to pick
   the org themselves, and org policy may require an owner to approve the token.

   **Confidence is medium and the mitigation is not optional.** The token-type rule comes from a
   single community report with no AWS confirmation. Because being wrong is unrepairable, the
   code does not trust it: after `CreateApp` it reads the app back and asserts
   `repositoryCloneMethod === "TOKEN"`, deleting the app and explaining plainly if it is not.
   There is no request field for this — the read-back is the only way to know.
3. **`CreateApp({ repository, accessToken, buildSpec, tags })`** — we supply a build spec so a
   plain HTML repo with no `amplify.yml` still builds — then the read-back above, then
   `CreateBranch({ enableAutoBuild: true, framework })`, then `StartJob({ jobType: "RELEASE" })`,
   because an app created through the API does **not** build by itself. Afterwards Amplify builds
   in the user's own account on every push.

   **The build spec and the branch `framework` are supplied for a Next.js app too, and this
   reversed an earlier decision.** The first version deliberately sent NEITHER, on the theory
   that Amplify recognises Next.js and writes the right settings itself. It does — *in the
   console*. Framework detection is part of the console's create flow, not the API's, and this
   poppy only ever creates apps through the API. That leaves two build-time failures, neither
   visible at `CreateApp`, which returns 200 either way:

   - no build settings at all, the same failure a plain HTML repo has (`defaultBuildSpec`
     already existed for exactly this reason — the two readings of one fact had drifted apart);
   - a branch whose framework resolves to plain `Web`, which fails **every** build with
     `Framework Web not supported`. AWS's documented repair is `UpdateBranch` — an action this
     poppy does not grant itself and should not need to, because the answer is known at the
     moment the branch is created. Getting it wrong is not repairable in place.

   So `amplifySetupFor(kind)` decides **four** coupled values, not three: `platform`, the SPA
   rewrite, the build spec, and the branch framework. The Next.js spec publishes `.next` —
   which is what makes Hosting *run* the app rather than serve files, and which AWS requires
   even for a Next.js 14+ app that only generates static pages. A repository carrying its own
   `amplify.yml` still wins; ours is the floor, not an override.

   Builds cost the user about **$0.01 a build-minute** in their own account; a small site is one
   to three minutes, so a few deploys a week is pennies a month, and often nothing against the
   free build allowance. Say "usually nothing, at most a few pence" rather than promising free —
   AWS reworked free-tier eligibility in 2025. Uploading a zip uses no build minutes at all.

Two consequences worth writing down:

- **The token is the user's, and it goes to their own AWS.** It never reaches a vendor server,
  and no vendor-registered OAuth app is needed — which matters, because HostingPoppy is free and
  should not depend on infrastructure someone has to run.
- **`amplify:StartJob` must be granted** and is not in the manifest today. Its resource is a job,
  which carries no tags, so it belongs in the name-scoped grant beside the other untaggable
  resources — see §3.1, this is exactly the trap that section describes.

Uploading a built site stays as the fallback, for someone with no repo or no build.

### 3.3 The domain step reads the zone before it acts (founder, 2026-08-24)

Found on the first live domain attach and worth more than the test that found it.
`hp-test.example.net` failed in under a minute. The cause was not our code: the domain carried a
wildcard `*.example.net` pointing at a Firebase app, so every possible subdomain already resolved
somewhere. Amplify asked whether the name pointed at its distribution, got a *wrong* answer
rather than *no* answer, and gave up. The user would have seen "We couldn't finish connecting
that address" — true, useless, and impossible to act on.

**The rule, from the founder: before touching a domain, map what the hosted zone already
contains, and choose the action from that.** Handing over records blind is how a beginner ends
up stuck on a failure nobody can explain.

What the step does, in order:

1. **Find the zone.** `ListHostedZonesByName`. If the domain is not managed in this AWS account,
   say so plainly and fall back to showing records to paste — today's behaviour, and correct
   when we genuinely cannot help.
2. **Read what is there.** `ListResourceRecordSets`, and classify the name the user asked for:
   - **free** — nothing claims it;
   - **shadowed by a wildcard** — a `*` record answers for it. Explain that a specific record
     always wins, so their existing app keeps every other name;
   - **already taken** — an A/CNAME/ALIAS exists at that exact name. Say where it points today
     and that connecting the site will move it, and require a deliberate confirmation. This is
     the case that can take somebody's live site down, so it is never silent;
   - **already ours** — it points at this site already; nothing to do.
3. **Offer to do it.** For a zone in this account, "add the record for me" is one click. The
   alternative — copy these two records to your DNS host — stays for everyone else, and for
   anyone who would rather do it by hand.
4. **Verify by resolving**, not only by asking AWS. When a name resolves somewhere unexpected,
   the honest message names what it found.

Cost: two Route 53 permissions. Reading zones is account-wide because AWS gives listing nothing
to scope to; writing is scoped to hosted zones. Both are amber and neither can reach outside
DNS. That is the trade — one more permission against a step the user cannot get wrong — and for
an audience who has never set hosting up before, the founder's call is that it is worth it.

## 4. The build problem — shaped by confinement (this is the load-bearing constraint)

Poppies are **confined** (backend.isolation "strict", fleet-wide since 2026-08-20): the
backend cannot read the user's files and **cannot spawn child processes**. So the poppy
can never run `npm run build` or `docker build` on the laptop. Builds happen in exactly
two acceptable places:

- **A. In the user's AWS — Amplify builds from GitHub** (Phase 3, the default once it
  lands). The user connects a repo, and every push deploys — the Vercel muscle memory.
- **B. Pre-built artifact upload** (v1's path, and permanently the no-GitHub fallback).
  The frontend file picker takes the built site — a `.zip`, or a folder the frontend zips
  in the browser — and the backend PUTs those bytes to Amplify's presigned upload URL.
  **Nothing is unzipped on the user's machine and no S3 bucket is involved**; Amplify
  expands the archive. No build step, so this ships first.

The file picker is the user-mediated handover a confined backend is allowed (same
principle as TrafficPoppy's restore): the browser hands us bytes the user chose, never a
path we went looking for. Bytes cross the host bridge in chunks, which is also what makes
an honest progress bar possible.

Never on the table: building on the user's machine (confinement), or building on
vendor infrastructure (BYO-cloud — we hold no customer code).

## 5. Domain + TLS flow (reuse MailPoppy's proven pieces)

- Domain in Route53 in this account → one click writes the ALIAS/CNAME + ACM
  validation records; poll to verified. (MailPoppy's DKIM/MX flow, same code shape.)
- Domain elsewhere → show the exact records to add at the registrar + a "Check DNS"
  button. Amplify/App Runner manage their own certs; the CloudFront path needs an ACM
  cert **in us-east-1 regardless of site region** (classic gotcha, §11).
- 🪤 Route53 `UPSERT` replaces the whole record set — merge TXT values, never clobber
  (bit MailPoppy in Phase 0).

## 6. What the wizard looks like (quick and friendly)

1. "What are you deploying?" — SPA / Next.js (framework auto-detected from the repo or
   zip when possible).
2. "How should it get your code?" — GitHub connect (push-to-deploy) or upload a zip.
3. "How do you want to pay AWS?" — On-demand vs Dedicated, each with the live monthly
   estimate for *their* stated audience size.
4. Dedicated only: the auto-scaling advisor (§7) pre-fills size/min/max — accept or tweak.
5. "Your domain" — enter it, records written or shown; progress until live.
6. Done: the site URL, an https padlock check, and a "what we created" resources view.

## 7. The auto-scaling advisor (dedicated)

Translate audience language into knobs — never ask for vCPUs first:

- Input: "busy-moment concurrent visitors" (+ optional "requests per visitor/min").
- Output: instance size (CPU/mem), **max concurrent requests per instance** (App
  Runner's native knob), min instances (1 = warm floor), max instances (cost ceiling —
  shown in $/mo, not instance counts: "never spend more than ~$X/mo even if you go
  viral").
- **The stated number sizes the floor, never a cap** (founder Q, 2026-08-21: "if they
  answer 50 but get 1000?"). Scaling is driven by LIVE concurrent requests — App Runner
  adds instances automatically within seconds when real traffic exceeds the estimate;
  the typed "50" only decides what stays warm and how big each instance is. The one
  true limit is the max-instances ceiling, which is a **cost-protection feature, not a
  capacity guess**: default it generously (~20× the stated audience) and phrase it in
  money. At the ceiling, visitors get slowdowns instead of the owner getting a surprise
  bill.
- **The ceiling control IS a dollar amount (founder, 2026-08-21)** — an *optional*
  "max spend" field: "Don't scale beyond ~$X/month." The user never sees instance
  counts unless they open the advanced view; the poppy converts the budget into a
  max-instances ceiling (`floor(budget / per-instance monthly cost)`, min = the warm
  floor) and shows the translation ("$60/mo ≈ up to 6 instances ≈ ~900 concurrent
  visitors"). Left unset, the generous ~20× default applies — still shown in $/mo.
  **Honest phrasing rule:** the cap bounds the *rate* of spend (the worst-case bill if
  the site ran at full tilt all month), not a hard AWS billing stop — AWS has no kill
  switch at a dollar figure, and we don't pretend otherwise. Instance-ceiling
  enforcement is real and immediate; the dollar number is its truthful translation.
- **How the cap actually works (founder Q, 2026-08-21: "how can we stop the billing?")**
  — we don't stop billing, we make the overspend impossible upfront: the fuse, not the
  meter. App Runner bills per instance-second, and the deployed auto-scaling config's
  hard `MaxSize` is enforced by AWS's own autoscaler — the 7th instance is never
  launched, so the maximum spend rate is bounded *by construction*; there is nothing to
  switch off later. Bandwidth ($/GB) is billed separately but is bounded in practice by
  the same fuse (N instances can only serve so many GB/s); the estimator must include a
  typical bandwidth line so the shown cap is the real total, not compute-only.
- **Optional AWS Budgets alert** (belt-and-braces): create a budget in their account
  emailing at 80%/100% of expected monthly spend. It can't stop anything (that's the
  missing AWS switch) — it's the warning light next to our fuse. Opt-in, cost-bearing
  conventions per DESIGN §10 of MailPoppy's model.
- **On-screen copy (founder-approved framing, 2026-08-21)** — shown beside the
  audience question so nobody fears under-estimating:
  > *"We ask this to set your always-on floor — the smallest setup that serves your
  > usual traffic, so you pay the minimum possible. If more people show up, the
  > infrastructure scales up automatically — your site stays up. The only limit is a
  > spending ceiling you control."*
  The claim is honest because the failure mode at the (user-controlled, generous)
  ceiling is slowdown, not downtime — never promise "infinite" scale, promise "growth
  never takes you down; only your own spending ceiling can throttle you."
- **Ceiling-hit alert**: if the service ever scales to its ceiling, the poppy surfaces
  it ("your site hit its spending ceiling yesterday at 14:02") with a one-click raise.
- Show the mapping honestly: "≈ N visitors per instance; at your ceiling you can serve
  ≈ M." Re-tunable any time from the dashboard, with a live "instances right now" readout.

## 8. Cost transparency (before anything is created)

The estimate panel is a first-class feature, not fine print — it's the anti-Vercel
pitch. Rough anchors (verify in Phase 0): SPA ≈ **$0–1/mo** (CloudFront free tier);
Amplify SSR small site ≈ **single-digit $/mo** (build minutes + GB served + compute);
App Runner dedicated ≈ **$10/mo idle floor**, ~$50/mo per busy vCPU-instance;
Fargate+ALB alternative adds a **~$16–20/mo ALB floor** (a reason App Runner is
recommended). Always labelled "billed by AWS to you, at AWS's prices — we add nothing."

## 9. Platform integration

- **Confinement**: strict from v0.1.0 (R7 — new listings must be confined). State in
  `dataDir` only. File in via picker; file out (if ever needed) via the one-shot
  `/ext-dl` token handoff.
- **Grants / risk rating**: this poppy needs IAM service roles (CodeBuild, Amplify,
  App Runner ECR-access) → `iam:PassRole` + scoped `iam:CreateRole`. **Expect amber**
  (VM-Poppy avoided IAM entirely; we can't). Scope everything to a name prefix
  (`hostingpoppy-*`); validate with the REAL risk assessor early — remember the
  substring trap (a "…put…" in an action name can false-flag red).
- **Transparency + teardown**: CloudFormation stack where possible + the provisioning
  ledger for out-of-stack mutations (Route53, Amplify domain associations); a Resources
  tab with console deep-links; a type-the-domain-to-confirm "Remove everything" that
  leaves no trace — the MailPoppy pattern, lifted wholesale.
- **Commerce: none. HostingPoppy is free** (founder, 2026-08-24) — no install price and
  nothing sold inside it. So it declares no `commerce:purchase` capability and registers no
  first-party product, and the catalogue shows it as a free full version rather than a lite
  one. The Feedback tab still carries the standard donate box; that is the shared element,
  not a product of ours. Worth revisiting only if hosting ever costs the VENDOR something —
  today it costs nothing, because every resource lives in the user's own account.

## 10. What we reuse from the fleet (accelerants)

- MailPoppy: asset-free CloudFormation deploy from the sidecar, Route53 writer + DNS
  polling, resources/ledger view, teardown sweep, Cognito-free — this poppy has **no
  end-user auth at all** (site visitors are the public; the admin is the poppy user).
- CrewPoppy/VM-Poppy: `local-download.ts` + `download.ts` pattern files; `initStorage(dataDir)`.
- The wizard/progress UX conventions from MailPoppy's deploy step.

## 11. Gotchas to design around (known today)

- ACM certs for CloudFront live in **us-east-1** only.
- CloudFront distribution create/update takes minutes — progress UX, never a spinner lie.
- SPA client-side routing needs 403/404 → `/index.html` rewrites (CloudFront custom
  error responses).
- App Runner is not in every region; Amplify WEB_COMPUTE region list ≠ all regions.
  Region picker must be capability-aware (MailPoppy does this for SES inbound).
- Amplify's **manual (non-Git) deploy for SSR** is the shakiest assumption in this
  design — it's proven for static, less clear for WEB_COMPUTE. Phase 0 must prove or
  kill it; fallback = SSR requires GitHub in v1 (zip path stays SPA-only).
- Next.js version churn is Amplify's problem, not ours — that's the point of buying.

## 12. Open questions (founder)

1. ~~**Name.**~~ **DECIDED (founder, 2026-08-21): HostingPoppy** — matches fleet
   naming, and "hosting" is the word the target user searches.
2. ~~**v1 scope order.**~~ **ADOPTED (PLAN.md): SPA first (no build step), then
   Next.js via GitHub; v1 ships after Phase 3** (a hosting poppy without
   Next.js/GitHub is too weak against Vercel muscle memory).
3. ~~**Dedicated engine.**~~ **ADOPTED (PLAN.md): App Runner** — concurrency scaling
   maps to "number of users", no ALB floor, managed certs. Fargate+ALB stays the
   documented fallback if Phase 0d finds App Runner wanting.
4. **Poppy pricing.** Flat subscription per install vs per-site/per-domain (MailPoppy
   precedent is per-domain $14.99/yr). **Still open — needed by Phase 5, blocks nothing
   before that.**
5. ~~**GitHub connect in v1?**~~ **DECIDED (founder, 2026-08-21): yes — GitHub connect
   is the primary path.** "I don't see issues for the user to connect their GitHub
   repository, that's the best approach." Zip upload stays as the no-GitHub fallback
   (and the SPA fast path), but push-to-deploy is the headline UX.

## 13. Rejected alternatives (and why)

- **Self-built OpenNext → Lambda/CloudFront** for SSR: full control, but we'd own
  compatibility with every Next.js release forever. Treadmill; rejected while Amplify
  exists.
- **EC2 auto-scaling group** as the dedicated engine: cheapest raw compute, but the
  user owns AMIs/patching — the opposite of "quick and friendly". VM-Poppy already
  serves the raw-VM audience.
- **Lightsail** ("dedicated server" in its friendliest form): fixed price but no real
  auto-scaling, which is a stated requirement. Out.
- **Vendor-side build service**: violates BYO-cloud; we never hold customer code.

## 14. Phase plan

- **Phase 0 — de-risk (live, in a spare AWS account)**: (a) SPA chain end-to-end via
  SDK: S3+OAC+CloudFront+ACM(us-east-1)+Route53 → https on a real domain; (b) Amplify
  WEB_COMPUTE Next.js deploy via SDK only — Git path AND manual-zip path (prove or
  kill §11's assumption); (c) App Runner: container from ECR, custom domain, watch
  concurrency scaling under `hey`-style load; (d) CodeBuild from a source zip in S3 →
  image → ECR, no GitHub. Each gets the MailPoppy treatment: proven live, written up,
  torn down, account verified clean.
- **Phase 1** — scaffold (hello-poppy shape, confined from day one) + SPA offer + domain flow.
- **Phase 2** — cost estimator + resources view + teardown.
- **Phase 3** — SSR on-demand (Amplify, GitHub path first).
- **Phase 4** — dedicated (App Runner) + the auto-scaling advisor.
- **Phase 5** — commerce + catalogue listing (strict, minHost 0.3.1, audit-prompt clean).
