# HostingPoppy — IMPLEMENTATION PLAN

Companion to `DESIGN.md` (what & why) and `UX.md` (every screen). This is the build order,
the architecture at file level, and what still has to be proven against live AWS.

**Working decisions adopted** (founder can overturn any of these):
- Name: **HostingPoppy**, id `com.hostingpoppy.desktop` (founder, 2026-08-21).
- **Static sites AND Next.js both run on Amplify Hosting** (2026-08-23 — see DESIGN §3 for the
  security-mechanism reason the drafted S3+CloudFront design could not ship).
- GitHub connect = the primary deploy path once it lands (founder, 2026-08-21); uploading a
  built site is v1's path and stays the permanent no-GitHub fallback.
- Dedicated engine = **App Runner** (Phase 4, unchanged).
- **Pricing: FREE** (founder, 2026-08-24). No install price, nothing sold inside, so no
  commerce capability and no first-party product. Nothing is open.

## 1. What v0.1.0 actually is

A poppy with **no CloudFormation, no Lambdas, no S3 buckets and no IAM roles**. It calls one
AWS service — Amplify Hosting — and that is the whole footprint:

```
hosting-poppy/
├── DESIGN.md · UX.md · PLAN.md · README.md · CLAUDE.md · LICENSE
├── extension.json            # strict + node22 from v0.1.0; listing needs minHost 0.3.1
├── frontend/                 # Vite + React + TS (dist is what ships)
│   └── src/
│       ├── App.tsx           # site list ⇄ wizard ⇄ dashboard state machine
│       ├── host.ts api.ts    # the host bridge + our typed routes
│       ├── views/            # one file per UX.md screen
│       └── lib/              # zip (fflate), format/estimates, helper prompt — all pure
└── backend/
    └── src/
        ├── server.ts         # the route table; esbuild → backend/index.cjs
        ├── boot.ts           # AGENTSPOPPY_BOOTSTRAP + brokered credentials
        ├── amplify.ts        # every AWS call, with pure mappers beside it
        ├── sites.ts          # naming, domain splitting, DNS parsing (pure)
        ├── uploads.ts        # chunk assembly for the site archive
        ├── storage.ts        # dataDir only — no legacy home has ever existed
        ├── ledger.ts errors.ts regions.ts tags.ts
```

Consequences worth naming, because they remove three of the family's recurring traps:

- **No embedded template or Lambda zip → the stale-bundle trap does not exist here.** There is
  nothing that can silently deploy yesterday's code.
- **No deploy bucket → no out-of-stack storage to sweep up** at teardown.
- **No `cdk`, no synth step** — the build is one esbuild call.

## 2. Provisioning model

One website = **one Amplify Hosting app**, born tagged, holding one production branch and (when
the user attaches one) one custom domain with its AWS-managed certificate.

- Teardown of one site = `DeleteApp` — branches, deployments, domain and certificate go with it.
- Teardown of everything = `ListApps` → keep only apps whose `agentspoppy:app` tag is ours →
  delete each. The tag check is what stops us ever deleting an app another tool made.
- Deploying = `CreateDeployment` → PUT the user's archive to the presigned URL it returns →
  `StartDeployment` → poll `GetJob`. No bucket, and no unzipping on the user's machine.

## 3. Permissions — the tightest set in the fleet

Two grants, and they are the whole story (`extension.json`):

| Grant | Scope | Why |
|---|---|---|
| `amplify` create/update/delete apps, branches, deployments, domains | `tagged-as-self` | Everything we make is born tagged, so we can never touch another tool's app |
| `amplify:ListApps` | `*` | AWS gives listing no resource to scope to. Read-only, and it is what makes "remove everything" provable |

Assessed with the **real** assessor (`npm run assess-permissions`, `npm run validate-manifest`):
**amber, no red findings, nothing we create or delete reaches beyond our own resources.** No
IAM grant of any kind — the amber-with-IAM worry in the original plan is gone with CloudFront.

## 4. Live verification — RUN 2026-08-24 (L1–L4) and RUN 2026-09-10 (L7, L11, L13)

Against a real account in eu-west-1, through the installed poppy and
the AgentsPoppy broker — not the CLI, because the machinery under test is the broker compiling
the manifest into a real IAM session policy.

| # | Result |
|---|---|
| L1 | ✅ Site created, deployed and served at its AWS address; deploy took 4 seconds |
| L2 | ✅ Deep link `/about` served the app and the client-side router read the path — the SPA rewrite rule works |
| L3 | ✅ A test subdomain live over HTTPS on an AWS-issued certificate, verifying → pending-dns → live in ~4 minutes |
| L4 | ✅ Teardown left NOTHING: no apps, no resources, and the DNS record we wrote was removed — the name fell back to the domain's wildcard and the apex was untouched |
| L5 | Region list taken from AWS's published endpoint table; not exercised beyond eu-west-1 |
| L6 | Not measured — needs a site left running for days |
| L7 | ✅ **The token kind.** A FINE-GRAINED token connected a real Next.js repository and the app survived `assertModernWiring` — which deletes any app whose `repositoryCloneMethod` is not `TOKEN`, so the app existing at all IS the proof. The rule DESIGN §3.2 recorded from one unconfirmed community report holds |
| L8 | Not run: needs a push to the connected branch |
| L9 | Not applicable to this run (a Next.js app gets no SPA rewrite by design); still open for a connected static SPA |
| L10 | ✅ No false positive: the `GetApp` read-back straight after `CreateApp` returned the tags and clone method, and a correct app was NOT wrongly deleted |
| L11 | ✅ **A Next.js app builds.** The app built from the repository and serves on its AWS address. Neither known failure mode fired — no `Framework Web not supported`, no missing-build-settings — so the branch `framework` and the `.next` build spec added on 2026-08-24 are both doing their job |
| L12 | ✅ **A Next.js server really is running.** Every route answers with `x-powered-by: Next.js` and `x-nextjs-cache: HIT` — headers only the Next.js runtime emits, which a static site on S3/CloudFront can never send. So `platform: WEB_COMPUTE` is doing its job and the app is not a static site paying for a server. Checked on `/` and `/professionals`. (This particular app's pages are prerendered with a 5-minute revalidate — `x-nextjs-prerender: 1`, `x-nextjs-stale-time: 300` — which is the APP's own design, not a hosting fault) |
| L13 | ✅ **No IAM service role is needed.** The build succeeded and the site serves with no `iamServiceRoleArn` and no `computeRoleArn` — HostingPoppy holds no `iam:*` and needed none. The docs' "an SSR app requires an IAM service role" belongs to Classic (`WEB_DYNAMIC`) hosting, exactly as the 2026-08-24 investigation argued |

**The grant redesign's one empirical assumption also held:** the new app's id is
the new app's id began with `d`, so the `apps/d*` scope written on 2026-09-02 covered it, as every Amplify id
observed so far has. Still an observation about AWS's id format, not a documented contract.

**Four bugs found, none of which any offline test could have caught.** Each one sat in the gap
between "the code is self-consistent" and "AWS agrees":

1. `amplify:TagResource` is required to CREATE a tagged app — removed earlier as "an action the
   code never calls", which was the wrong test entirely.
2. Every permission error was reported as a broken connection, because the no-credentials rule
   matched the bare word "agentspoppy" and every AWS AccessDenied quotes the assumed-role ARN.
3. AWS's own `statusReason` was discarded, so the first domain failure could not be diagnosed by
   anyone — user or author. Reversed within the hour, and it is what found the fourth.
4. `route53:ListHostedZones` — **Amplify itself** calls it with the CALLER'S credentials when the
   domain is hosted in Route 53 in the same account, because it configures the DNS for you.
   Denied, it marks the association FAILED with the reason buried in `statusReason`. This, not
   the wildcard, was the real cause of the first failed domain.

## 5. What still needs live AWS

Everything below is written and unit-tested but has NOT met real AWS. (L1–L4 have — see §4.)
Each item needs the founder's go-ahead and a spare domain first (repo working agreement).

| # | Prove | If it fails |
|---|---|---|
| L1 | Create a site, upload a built SPA, reach it on its AWS address — and measure the real timings so the progress copy never lies | The whole v1 loop; nothing ships without it |
| L2 | Deep links work (the SPA rewrite rule) — `/some/route` serves the app, not a 404 | Fix the rewrite rule; it is one `customRules` value |
| L3 | Attach a custom domain end to end: records shown, published, certificate issued, HTTPS live | The DNS copy and the polling states in `DomainStep` |
| L4 | `Remove everything` leaves zero residuals under a tag sweep (`npm run certify`, host cleanup off) | Shipping blocker — the promise the ecosystem rests on |
| L5 | Region matrix: which regions actually offer Amplify Hosting (drives `regions.ts`) | Data gathering; the list ships conservative until then |
| L6 | Estimate vs the real bill after a few days | Estimator credibility, which the anti-Vercel pitch rests on |
| L7 | **The token kind.** Connect a scratch repo with a FINE-GRAINED token and confirm `GetApp` reports `repositoryCloneMethod=TOKEN`. Then try a classic token and confirm our guard catches it, deletes the app, and says so | The whole GitHub path. The rule comes from one unconfirmed community report, and being wrong is unrepairable in place (DESIGN §3.2) |
| L8 | **Push-to-deploy actually fires.** After connecting, delete the token, push a commit, and confirm a build starts unprompted | We tell the user "every push goes live". No dated source witnesses this on a TOKEN app — it is inferred |
| L9 | **Deep links on a connected site.** Build an SPA from a repo and load `/some/route` directly | We set the rewrite rule explicitly rather than trusting Amplify's framework detection (DESIGN §3.2); L9 proves which of us is right |
| L10 | **The create-then-read race.** Confirm the `GetApp` read-back immediately after `CreateApp` returns the tags and `repositoryCloneMethod` reliably | `createSite`'s own comment says a tag read can lag a create by a second or two. If that applies here, a CORRECT app gets deleted and the user is wrongly told their key was bad |
| L11 | **A Next.js app builds at all.** Connect a real Next.js repo and watch the job reach `SUCCEED`. A 200 from `CreateApp` proves nothing here: both known failure modes happen at BUILD time | The whole Next.js kind. Two causes to tell apart in the log — `Framework Web not supported` (the branch `framework` we now set) and a missing-build-settings error (the `.next` spec we now send) |
| L12 | **It renders on a server.** Load a route that is generated per request, not just the home page, and confirm it is current rather than baked at build time | `platform: WEB_COMPUTE` is doing nothing, and the app is a static site wearing a server's price tag |
| L13 | **No IAM service role is needed.** AWS docs say an SSR app "requires an IAM service role", but every scoped statement ties that to CloudWatch Logs and the hard-denial sentence is filed under Classic (Next.js 11 / `WEB_DYNAMIC`) hosting, which provisioned resources in the customer account. `WEB_COMPUTE` does not | **No in-app exit.** HostingPoppy holds no `iam:*`, no `iam:PassRole` and no `amplify:UpdateApp`, so if the role is genuinely required the fix is a new grant and a re-consent, not a patch |

## 6. Phases after v1

- **Phase 3 — GitHub + Next.js.** ✅ Built (GitHub connect; `kind: "nextjs"` →
  `platform: WEB_COMPUTE`, no SPA rewrite, the `.next` build spec and the `Next.js - SSR`
  branch framework, all decided in one place by `amplifySetupFor`). Unproven against real AWS:
  gates L7–L13. This is where v1 becomes competitive with Vercel muscle memory.
- **Phase 4 — dedicated.** App Runner, the audience→floor advisor, and the max-spend fuse
  (`MaxSize`, which AWS's own autoscaler enforces). New grants, and the first time this poppy
  needs `iam:PassRole` — expect the rating conversation then, not now.
- **Phase 5 — polish.** No commerce: the poppy is free. Docs, release runbook, listing.

## 7. Listing prerequisites

- The repository goes **public at first listing** — it is new and holds nothing private. Keep it
  that way: no live account ids, pool ids or API URLs in tests (the MailPoppy lesson).
- Licence: PolyForm Shield 1.0.0, already in place.
- Release: pack, publish a GitHub release, then **fetch the asset URL with no credentials and
  require a 200** before the catalogue points at it.
- The listing must carry `minHost: "0.3.1"` — an older host ignores `isolation: strict` and
  would run the backend unconfined, which would make the label a lie.

## 8. Testing strategy

Pure logic first (domain splitting, DNS parsing, status mapping, chunk assembly, estimates),
then views with an injected client so every screen is testable offline, then the packed bundle
booted under the host's exact strict flags, and only then live AWS — prove, log, tear down,
verify the account is clean.
