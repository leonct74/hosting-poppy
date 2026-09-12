# CLAUDE.md — HostingPoppy

Operating guide for working in this repo. **`DESIGN.md` is the source of truth** for what and
why; **`UX.md` is a contract, not a mood board** — the screens, the wording rules and the
error dictionary in it are the spec. When a decision changes, change `DESIGN.md` in the same
commit.

> **Boundary:** HostingPoppy is a standalone project that runs *on* AgentsPoppy and never
> forks it (PolyForm Shield non-compete). `~/Projects/agentspoppy`, `~/Projects/traffic-poppy`,
> `~/Projects/mailpoppy` and `~/Projects/vm-poppy` are **read-only reference material** — copy
> patterns out of them, never edit them from here.

## What this is

A poppy that puts a website online inside the user's **own AWS account**, using **AWS Amplify
Hosting** and nothing else. One website = one Amplify Hosting app, born tagged, holding one
live branch, the deployments the user uploads and (optionally) their custom domain with its
AWS-managed certificate. v0.1.0 deploys a site the user has already built; GitHub
push-to-deploy and Next.js are later phases on the same code path.

The audience is the whole design: **someone with an AWS account who has never created hosting
infrastructure.** They know *website, domain, visitors, monthly cost*. They do not know
*distribution, origin, bucket, stack, branch*. That is why the vocabulary rules below are
hard rules and not style preferences.

## Read these before coding, in this order

1. **`DESIGN.md` §3** — why Amplify Hosting and not S3 + CloudFront (a security-mechanism
   reason, not a preference), and **§4** — confinement, the constraint that shapes the whole
   product.
2. **`UX.md`** — every screen, the banned-vocabulary rule, the error-language dictionary.
3. **`PLAN.md`** — the file-level architecture, what exists, and the live-AWS checks (L1–L6)
   that are still open.
4. **`backend/src/types.ts`** — the wire contract between backend and frontend. Read it before
   inventing a shape; it already answers most questions.
5. **`~/Projects/agentspoppy/AGENTS.md` §§3, 4, 5, 9, 9a** — the platform contract. Its rules
   are requirements, not advice.
6. Conventions to copy, never edit: `~/Projects/traffic-poppy` (`backend/src/server.ts`,
   `boot.ts`, `frontend/src/App.tsx`, `api.ts`, `host.ts`) for the shape of a poppy;
   `~/Projects/mailpoppy` for the wizard, resources and teardown patterns.

## Non-negotiables (digest — `AGENTS.md` is authoritative)

- **Confinement.** The backend runs under `node --permission`. **Never** `child_process`,
  `worker_threads` or native addons. Write only inside `dataDir` or `os.tmpdir()`. There is no
  `~/.hostingpoppy` and there never has been — this poppy was strict from v0.1.0, so no
  migration release is owed to anyone.
- **Birth-tagging.** Every AWS resource is created **with** its tags in the same call
  (`CreateApp` and `CreateBranch` both take a `tags` map). An untagged resource is invisible to
  the teardown sweep — and under our scoped credentials AWS refuses the call outright, so this
  fails loudly rather than silently.
- **Permissions are exactly what `extension.json` grants: Amplify, and nothing else.** No S3,
  no CloudFormation, no ACM, no Route 53, no IAM. If a design needs one, that design has taken
  a wrong turn — say so and stop, rather than widening the manifest.
- **Teardown leaves no trace.** Deleting a site is `DeleteApp`; *Remove everything* is
  `ListApps` → keep only apps carrying our `agentspoppy:app` tag → delete each. The tag check
  is what stops us ever deleting an app another tool made. `npm run certify` is the proof, and
  it must pass before any catalogue listing.
- **Destructive actions never take one bare click.** Two steps, the blast radius named in
  plain words, the danger button not focused. Wiping the whole footprint is **type-to-confirm**.
- **Cloud work runs in the background and always resumes.** Never cage the user behind a modal
  spinner. On mount, rebuild the view from *live AWS state* (`GetJob`, `GetDomainAssociation`),
  never from memory or `localStorage`, and re-attach the poller if work is in flight.
- **Plain language, and no AWS jargon on any primary screen** — no "Amplify", "bucket",
  "distribution", "stack", "job", "branch", "deployment". Say website, address, upload, going
  live. Real AWS names appear **only** in the Resources tab, where transparency requires them.
- **Every error the user sees is one calm human sentence naming the one thing to do next.**
  Raw AWS text goes behind a "technical details" disclosure. `UX.md`'s dictionary is the
  starting vocabulary; grow it there when a new failure appears.
- **Every button responds within ~100 ms** — spinner + disabled on the control itself, resolved
  in a `finally` so nothing can hang spinning. Click every control in the running poppy before
  claiming it works; reading the code is not the test. Note `window.alert/confirm/open` are
  silent no-ops in the host webview — use the host bridge and in-page panels.
- **The Feedback tab is mandatory and is the LAST tab.** It comes from the SDK
  (`defineFeedbackTab` + `<agentspoppy-feedback>`); we don't build our own.
- **Design kit.** Build every colour, space and radius from `frontend/src/poppy.css`'s
  `--poppy-*` tokens — no raw hex. Our accent is **`#c9b8e8`** (that really is
  `poppyAccent("com.hostingpoppy.desktop")`; set `--poppy-accent` to it). Never clay
  (`#d97757`, the host's reserved colour) and never `backdrop-filter`. The host frame can be
  narrow: single-column, responsive layouts only.
- **Show the money.** Costs belong next to the decision that causes them, labelled *"billed by
  AWS to you, at AWS's prices — we add nothing"*, and the $0 state is worth celebrating out
  loud.
- **TypeScript strict with `noUncheckedIndexedAccess`.** Decision logic lives in **pure**
  functions with vitest tests; AWS clients are injected so no test ever touches the network.
- **Comments explain WHY** — a constraint, a trap, a rejected alternative. Never what the next
  line does.

## Commands

- `npm install` — once.
- `npm run typecheck` · `npm run test` — per workspace, both green before anything else.
- `npm run validate-manifest` · `npm run assess-permissions` — the manifest and the **real**
  risk assessor.
- `npm run check` — all four of the above; the gate before every commit.
- `npm run build` — `frontend/dist` (Vite) + `backend/index.cjs` (one esbuild call).
- `npm run rig` — boot the built backend under the host's exact confinement flags and prove it
  still works. Run it after `npm run build`, and before every release: confinement failures
  never show up in a normal `npm run dev`.
- `node scripts/make-icon.mjs` — redraw the app icon into `frontend/public/`.
- `npm run install-dev` — side-load into a local AgentsPoppy; `npm run pack` — build the
  distributable. Both need the AgentsPoppy checkout (`AGENTSPOPPY_REPO`, default
  `../agentspoppy`).
- `npm run certify -- --yes` — the real leaves-no-trace run, against a deployed *and used*
  connection. Pass no `--extension`: the script already passes `$PWD`, and a second one wins.
- `npm run sync-feedback` / `check-feedback` — refresh the vendored Feedback tab from the SDK.

## Gotchas

1. **🪤 There is NO embedded CloudFormation template and NO Lambda zip in this poppy — so the
   family's famous stale-bundle trap does not exist here.** In MailPoppy and TrafficPoppy the
   shipped bundle *embeds* a synthesized template plus a content-addressed Lambda zip, so
   editing backend code without rebuilding silently deploys yesterday's code and CloudFormation
   reports `NO_CHANGE`. HostingPoppy provisions through the SDK at runtime; the build is one
   esbuild call over our own source. **Do not casually reintroduce an embedded artifact** — if
   a future phase seems to need one, that is a design decision with a real cost, not an
   implementation detail.
2. **🪤 Amplify Hosting is a taken dependency, consciously.** Static sites *and* Next.js SSR
   both ride on it (`DESIGN.md` §3). If AWS ever limits or sunsets it — and the fleet has a
   WorkMail-EOL precedent for exactly that — **both** paths move, and the fallback (self-built
   OpenNext on Lambda/CloudFront) is the treadmill `DESIGN.md` §13 rejected on purpose. That
   trade bought a design that could actually ship; it is worth re-reading yearly, and it is not
   something to quietly re-litigate mid-feature.
3. **`fs.existsSync` THROWS on a denied path under `--permission`** — it does not return
   `false`. Every filesystem probe goes through the catch-wrapped `exists()` helper. This has
   bitten the fleet more than once.
4. **The wire contract exists twice.** `backend/src/types.ts` and `frontend/src/types.ts` are
   separate builds and separate files. Change both in the same commit or the two halves drift
   silently — the vendored-client class of bug that hid a whole capability in MailPoppy's web
   app for months.
5. **`amplify:ListApps` is the only account-wide grant, and it is read-only on purpose.** Any
   new action means re-running `npm run assess-permissions` — never eyeball the rating. The
   assessor matches action names by **substring**, so an innocent action containing "put" can
   false-flag red (VM-Poppy DR3).
6. **The icon is generated, not hand-committed.** `scripts/make-icon.mjs` draws it with node's
   zlib because a stock Mac has no SVG rasteriser. It writes `frontend/public/`, and the Vite
   build copies it to `frontend/dist/`, which is where the manifest's
   `frontend/hostingpoppy-icon.png` resolves after packing.
7. **Never `git add -A` after a build.** `.gitignore` covers `backend/index.cjs`, `dist/` and
   `release/` — keep it that way. An 86 MB binary once landed in a sibling poppy's history.

## Publishing — THIS repo's history must never be pushed

**This local repository has no git remote, and that is deliberate. Do not add one.**

Its history is not publishable. Ten of its commits carry a live AWS account number, real app
ids and the founder's own domains — in commit *content*, not just messages — because the work
was done against a live account before the first release. A scrub of the working tree does
nothing about that: `git push` would disclose all of it. (MailPoppy, 2026-07-30: anything ever
pushed while public must be treated as disclosed.)

The public repository is **`github.com/leonct74/hosting-poppy`**, and it is a **snapshot**:

```bash
S=/tmp/hp-public && rm -rf $S && mkdir -p $S
git archive HEAD | tar -x -C $S            # the working tree, no history
cd $S && git init -q -b main && git add -A
grep -rnE "<account id>|<real domains>|<live app ids>" --exclude-dir=.git .   # must print nothing
git commit -m "HostingPoppy <version> — …" && git remote add origin <public> && git push -u origin main
```

Before every publish, re-run that grep. Live details come back: they arrive in verification
notes, in a test fixture copied from a real error message, in a comment explaining a bug that
actually happened. Each release is a fresh snapshot commit on the public repo.

## Working agreements (live AWS)

- **Explicit founder confirmation before any AWS call that creates, changes or deletes
  anything.** Read-only calls (`Get*`, `List*`, `sts`) are fine to run.
- Live tests use a **spare** domain, never a production one, and end with a teardown plus a
  verification that the account is clean — prove, log, tear down, check.
- The founder decides product questions. Implementation questions get decided here and written
  into `DESIGN.md`.

## Status

**v0.1.1 is released and proven against live AWS** — 2026-09-12, published at
`github.com/leonct74/hosting-poppy` (a SNAPSHOT; see the publishing section above). Both
paths have run for real: a static site and a Next.js app, each created, built, given a custom
domain over HTTPS, and torn down leaving nothing — including the DNS record HostingPoppy
wrote, so no name is left pointing at a deleted distribution. `PLAN.md` §4 lists what each
gate proved.

Still open: push-to-deploy actually firing (L8), deep links on a connected static site (L9),
the region matrix (L5) and a real bill (L6).

**`certify` cannot confirm the teardown, and its pass means nothing today.** Run 2026-09-12
found NOTHING tagged before teardown and reported `passed: true` on an empty footprint — the
platform's known blind sweep (operator credentials cannot see the poppy's tagged resources,
and the errors are swallowed). The teardown evidence we have is hand-verified, from outside,
twice. Do not cite the certificate as proof, and do not let a green certify stand in for
watching the resources actually disappear.

Do not describe any of that as working until it has actually run against AWS. The fleet's
sharpest lesson on this is MailPoppy's v0.1.18: "the fix is on main" and "the fix reached the
user" are different claims, and only one of them is worth telling someone.
