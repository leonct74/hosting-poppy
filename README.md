# HostingPoppy

Put your website online in **your own AWS account** — an [AgentsPoppy](https://agentspoppy.com)
poppy.

You hand it the built files of a website. It creates the hosting inside your AWS account,
uploads the site, and gives you back an HTTPS address that works straight away. Attach your
own domain when you're ready and AWS issues and renews the certificate for it. When you're
done, one click removes everything it made.

The audience is deliberate: someone who **has** an AWS account but has never set up hosting
there, and shouldn't have to learn what a CDN, an origin or a certificate authority is just
to get a site on the internet.

- **Your cloud.** The site lives in your account. Nobody else can serve it, move it, or
  hold it hostage.
- **Your bill.** AWS charges you directly, at AWS's prices. We add nothing on top.
- **Nothing hidden.** A Resources tab lists every real AWS resource the poppy created, with
  a console link to each one.
- **Leaves no trace.** Removing the poppy removes what it built — that promise is tested,
  not asserted (see *Teardown* below).

## What it actually creates

One AWS service: **AWS Amplify Hosting**. One website = one Amplify Hosting app, holding one
live branch, the deployments you upload, and — once you attach one — your custom domain with
its AWS-managed certificate.

That is the whole footprint. HostingPoppy creates **no storage buckets, no IAM roles, no
CloudFormation stacks, no Lambda functions, no DNS zones** — nothing else at all. Deploying
is `CreateDeployment` → upload your archive to the pre-signed URL AWS hands back →
`StartDeployment`; Amplify unpacks the archive itself, so no bucket is involved and nothing
is unpacked on your machine.

The obvious alternative — a private S3 bucket behind CloudFront — was designed first and
rejected during implementation, because CloudFront's Origin Access Control cannot be tagged
at creation and so cannot be granted safely under AgentsPoppy's rules. The reasoning is
written up in [`DESIGN.md`](./DESIGN.md) §3, including what it costs us (CloudFront's free
egress tier) and when that trade would be worth revisiting.

## The permissions it asks for

An AgentsPoppy poppy never receives your AWS keys. The host mints short-lived credentials
scoped to exactly the grants below, and every resource HostingPoppy creates is **born
carrying the poppy's own tags** — which is what makes the first grant self-limiting.

| Grant | Scope | Why it's needed |
|---|---|---|
| `amplify:` create / update / delete apps, branches, deployments and domain associations, plus their `Get`/`List`/tag actions | **only resources tagged as HostingPoppy's own** | Making a website, deploying to it, attaching a domain, and removing any of those again. Because the tag condition is on the resource, these calls cannot touch an Amplify app made by anything else — including one you made yourself in the console. |
| `amplify:ListApps` | account-wide | AWS gives listing no resource to scope to. It is read-only, and it is what lets *Remove everything* prove that none of ours is left behind. |

No `iam:*`, no `s3:*`, no `cloudformation:*`, no `route53:*`. The exact grants are in
[`extension.json`](./extension.json) and are checked on every build by the platform's own
risk assessor (`npm run assess-permissions`).

The backend also runs **confined** (`"isolation": "strict"`): it cannot start other
programs and can only write inside the private folder the host gives it. That is enforced by
the runtime, not by us being careful.

## Teardown

Removing a single website deletes its Amplify app, which takes its branches, deployments,
domain association and certificate with it. *Remove everything* lists the account's Amplify
apps, keeps only the ones carrying our tag, and deletes those — then the platform sweeps for
the tag itself and fails the poppy if anything is still standing. AgentsPoppy calls that
check `certify`; a poppy that can't pass it isn't listable.

## What is not built yet

Being straight about the shape of v0.1.0:

- **Two ways in, both built.** Connect a GitHub repository and AWS builds it in your own
  account on every push, or upload a site you have already built (a `.zip`, or a folder the
  browser zips for you) and it goes live with no build step at all.
- **Next.js is hosted from GitHub only.** A server-rendered app has to be built from its
  code, so there is no upload path for it; an app configured for static export uses the
  finished-site path like anything else.
- **Always-warm "dedicated" hosting** (AWS App Runner, with an audience-sized floor and a
  spending ceiling) is a later phase.
- **Both paths are proven against live AWS.** A static site was created, deployed, given a
  custom domain and torn down (gates L1–L4); a Next.js app was then connected from a GitHub
  repository and built (L7, L10, L11, L13) — including the claim that mattered most, that a
  server-rendered app needs no IAM service role. See [`PLAN.md`](./PLAN.md) §4. Still open:
  push-to-deploy (L8), a route rendered per request (L12), and the cost gates L5/L6.

## Build it yourself

Node 22, and no network access beyond `npm install`.

```bash
npm install
npm run check     # typecheck + tests + manifest validation + the real risk assessor
npm run build     # frontend/dist (Vite) and backend/index.cjs (one esbuild call)
```

Other scripts worth knowing:

- `npm run rig` — boots the built backend under the same confinement flags the host uses, so
  you can see for yourself that it runs with the user's home directory (and `~/.aws`) denied
  to it.
- `node scripts/make-icon.mjs` — redraws the app icon. There is no SVG rasteriser on a stock
  Mac, so the icon is generated from code rather than committed as a binary nobody can
  reproduce.
- `npm run pack` and `npm run install-dev` — build a distributable poppy, or side-load one
  into a local AgentsPoppy. Both need a checkout of the AgentsPoppy repository beside this
  one (or `AGENTSPOPPY_REPO` pointing at it), since they run the platform's own packer.

## The documents

[`DESIGN.md`](./DESIGN.md) is what and why (including the rejected alternatives and what
they would have cost). [`UX.md`](./UX.md) is every screen, the language rules and the
error dictionary. [`PLAN.md`](./PLAN.md) is the build order and what still has to meet real
AWS. [`CLAUDE.md`](./CLAUDE.md) is the operating guide for anyone — human or agent — writing
code in here.

## Licence

Source-available under the
**[PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0/)** —
see [`LICENSE`](./LICENSE). Read it, run it, host your own sites with it, change it, and use
it for any purpose *except* building a product that competes with HostingPoppy or with any
other product we provide using it. The HostingPoppy name and brand are not licensed with the
code.

(`frontend/src/poppy.css` is the AgentsPoppy design kit, vendored in under its own MIT
header — that file keeps its MIT terms.)
