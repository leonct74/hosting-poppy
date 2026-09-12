import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANCH,
  amplifyGitHubAppUrl,
  defaultBuildSpec,
  fineGrainedTokenUrl,
  branchUrl,
  looksFineGrained,
  nextBuildSpec,
  normalizeBranch,
  parseRepoUrl,
  redactToken,
  tokenWarning,
  validateBranch,
  validateRepoUrl,
  validateToken,
} from "./github";

describe("parseRepoUrl", () => {
  // The four things people actually paste. Every one of them has to work, because the
  // alternative is telling somebody their own repository address is wrong.
  const same = [
    "https://github.com/olly/my-site",
    "https://github.com/olly/my-site/",
    "https://github.com/olly/my-site.git",
    "https://github.com/olly/my-site.git/",
    "http://github.com/olly/my-site",
    "https://www.github.com/olly/my-site",
    "github.com/olly/my-site",
    "  https://github.com/olly/my-site  ",
    "olly/my-site",
    "olly/my-site/",
    "git@github.com:olly/my-site.git",
    "ssh://git@github.com/olly/my-site.git",
  ];

  for (const input of same) {
    it(`reads ${JSON.stringify(input)} as olly/my-site`, () => {
      expect(parseRepoUrl(input)).toEqual({
        owner: "olly",
        repo: "my-site",
        // Always the canonical https form — that is what Amplify is given, whatever was typed.
        url: "https://github.com/olly/my-site",
      });
    });
  }

  it("keeps the owner's and the repository's own capitalisation", () => {
    expect(parseRepoUrl("https://github.com/Olly/My-Site")).toMatchObject({
      owner: "Olly",
      repo: "My-Site",
      url: "https://github.com/Olly/My-Site",
    });
  });

  it("refuses a deeper link rather than guessing which part is the repository", () => {
    expect(parseRepoUrl("https://github.com/olly/my-site/tree/main")).toBeNull();
    expect(parseRepoUrl("https://github.com/orgs/olly/repositories")).toBeNull();
  });

  it("refuses an owner with no repository", () => {
    expect(parseRepoUrl("https://github.com/olly")).toBeNull();
    expect(parseRepoUrl("github.com")).toBeNull();
  });

  it("refuses another service", () => {
    expect(parseRepoUrl("https://gitlab.com/olly/my-site")).toBeNull();
    expect(parseRepoUrl("https://bitbucket.org/olly/my-site")).toBeNull();
    expect(parseRepoUrl("git@gitlab.com:olly/my-site.git")).toBeNull();
    // A look-alike host must not pass as GitHub.
    expect(parseRepoUrl("https://github.com.evil.example/olly/my-site")).toBeNull();
  });

  it("refuses names GitHub itself would not accept", () => {
    expect(parseRepoUrl("-olly/my-site")).toBeNull();
    expect(parseRepoUrl("olly-/my-site")).toBeNull();
    expect(parseRepoUrl("ol ly/my-site")).toBeNull();
    expect(parseRepoUrl("olly/..")).toBeNull();
    expect(parseRepoUrl("olly/my site")).toBeNull();
    expect(parseRepoUrl(`olly/${"x".repeat(101)}`)).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(parseRepoUrl("")).toBeNull();
    expect(parseRepoUrl("   ")).toBeNull();
  });
});

describe("validateRepoUrl", () => {
  it("says nothing about a repository it can use", () => {
    expect(validateRepoUrl("https://github.com/olly/my-site")).toBeNull();
  });

  it("asks for one when the box is empty", () => {
    expect(validateRepoUrl("")).toMatch(/paste the address/i);
  });

  it("says GitHub-only in as many words, and points at the fallback", () => {
    const said = validateRepoUrl("https://gitlab.com/olly/my-site") ?? "";
    expect(said).toMatch(/only connect repositories on GitHub/i);
    expect(said).toMatch(/upload your built site/i);
  });

  it("says something different when it IS GitHub but isn't a repository", () => {
    const said = validateRepoUrl("https://github.com/olly") ?? "";
    expect(said).toMatch(/doesn't look like a repository address/i);
    expect(said).not.toMatch(/only GitHub/i);
  });

  it("never blames the user in AWS words", () => {
    for (const input of ["", "https://gitlab.com/x/y", "nonsense"]) {
      expect(validateRepoUrl(input) ?? "").not.toMatch(/amplify|repositoryCloneMethod|IAM/i);
    }
  });
});

describe("amplifyGitHubAppUrl", () => {
  it("is the per-region Amplify GitHub App install page", () => {
    expect(amplifyGitHubAppUrl("eu-west-1")).toBe("https://github.com/apps/aws-amplify-eu-west-1/installations/new");
  });

  it("tolerates a region that arrives shouted or padded", () => {
    expect(amplifyGitHubAppUrl("  US-EAST-1 ")).toBe("https://github.com/apps/aws-amplify-us-east-1/installations/new");
  });
});

describe("fineGrainedTokenUrl", () => {
  const url = new URL(fineGrainedTokenUrl({ owner: "olly" }));

  it("opens GitHub's fine-grained token page — not the classic one", () => {
    expect(url.origin + url.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
  });

  it("pre-fills exactly the four permissions Amplify needs", () => {
    expect(url.searchParams.get("contents")).toBe("read");
    expect(url.searchParams.get("metadata")).toBe("read");
    expect(url.searchParams.get("administration")).toBe("read");
    // Writing webhooks is what makes a push deploy — without it nothing rebuilds.
    expect(url.searchParams.get("repository_hooks")).toBe("write");
  });

  it("pre-selects the repository's owner and names the token", () => {
    expect(url.searchParams.get("target_name")).toBe("olly");
    expect(url.searchParams.get("name")).toBe("HostingPoppy");
    expect(Number(url.searchParams.get("expires_in"))).toBeGreaterThan(0);
  });

  it("encodes an owner that needs it, rather than breaking the address", () => {
    const built = new URL(fineGrainedTokenUrl({ owner: "olly digital&co", name: "Hosting Poppy" }));
    expect(built.searchParams.get("target_name")).toBe("olly digital&co");
    expect(built.searchParams.get("name")).toBe("Hosting Poppy");
  });

  it("falls back to a name rather than sending an empty one", () => {
    const built = new URL(fineGrainedTokenUrl({ owner: "olly", name: "   " }));
    expect(built.searchParams.get("name")).toBe("HostingPoppy");
  });
});

describe("looksFineGrained / tokenWarning", () => {
  it("recognises a fine-grained token", () => {
    expect(looksFineGrained("github_pat_11ABCDEFG0abcdefghijkl")).toBe(true);
    expect(tokenWarning("github_pat_11ABCDEFG0abcdefghijkl")).toBeNull();
  });

  it("warns — but does not refuse — a classic token, naming the consequence", () => {
    const said = tokenWarning("ghp_abcdefghijklmnopqrstuvwxyz0123456789") ?? "";
    expect(looksFineGrained("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(said).toMatch(/classic token/i);
    expect(said).toMatch(/set up again from scratch/i);
    // It is a warning, not a gate: validateToken is what refuses, and it doesn't.
    expect(validateToken("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBeNull();
  });

  it("warns about a prefix nobody has seen, without pretending to know it's wrong", () => {
    expect(tokenWarning("gitfoo_something_new_from_github_2027")).toMatch(/github_pat_/);
  });

  it("says nothing at all about an empty box — that is the validator's job", () => {
    expect(tokenWarning("")).toBeNull();
  });

  it("never quotes the key back", () => {
    const secret = "ghp_supersecretvalue0123456789abcdef";
    expect(tokenWarning(secret) ?? "").not.toContain(secret);
    expect(validateToken("a b") ?? "").not.toContain("a b");
  });
});

describe("validateToken", () => {
  it("accepts anything that could plausibly be a key — the read-back is the real check", () => {
    expect(validateToken("github_pat_11ABCDEFG0abcdefghijkl")).toBeNull();
    expect(validateToken("  github_pat_11ABCDEFG0abcdefghijkl  ")).toBeNull();
  });

  it("asks for one, and says where it goes", () => {
    expect(validateToken("") ?? "").toMatch(/your own AWS account/i);
  });

  it("catches a half-copied paste", () => {
    expect(validateToken("github_pat_11ABC DEFG0abcdefghijkl")).toMatch(/space or a line break/i);
    expect(validateToken("github_pat")).toMatch(/too short/i);
  });
});

describe("redactToken", () => {
  const secret = "github_pat_11ABCDEFG0abcdefghijklmnop";

  it("takes the key out of text that is about to be logged", () => {
    const raw = `BadRequestException: token ${secret} was rejected`;
    const safe = redactToken(raw, secret);
    expect(safe).not.toContain(secret);
    expect(safe).toContain("[the access key you pasted]");
    expect(safe).toContain("BadRequestException");
  });

  it("takes out every copy of it", () => {
    expect(redactToken(`${secret} and ${secret}`, secret)).not.toContain(secret);
  });

  it("leaves text alone when the key isn't in it", () => {
    expect(redactToken("nothing secret here", secret)).toBe("nothing secret here");
  });

  it("does nothing for something too short to be a key — it would redact ordinary words", () => {
    expect(redactToken("a token walks into a bar", "a")).toBe("a token walks into a bar");
    expect(redactToken("some text", "")).toBe("some text");
  });
});

describe("normalizeBranch / validateBranch", () => {
  it("drops the decorations people paste with a branch name", () => {
    expect(normalizeBranch("  main  ")).toBe("main");
    expect(normalizeBranch("origin/main")).toBe("main");
    expect(normalizeBranch("refs/heads/main")).toBe("main");
    expect(normalizeBranch('"main"')).toBe("main");
  });

  it("accepts the names real repositories use", () => {
    for (const branch of ["main", "master", "production", "fix-navbar", "release/2.0", "v1.2", "feature_x"]) {
      expect(validateBranch(branch)).toBeNull();
    }
  });

  it("asks for one, and says what most repositories use", () => {
    expect(validateBranch("") ?? "").toMatch(/main/);
  });

  it("refuses names Git itself would refuse", () => {
    for (const branch of ["my branch", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a..b", "/main", "main/", "-main", ".main", "main.", "main.lock"]) {
      expect(validateBranch(branch), branch).not.toBeNull();
    }
  });

  it("refuses a control character, which only ever arrives by paste", () => {
    expect(validateBranch(`main${String.fromCharCode(0)}`)).not.toBeNull();
    expect(validateBranch(`ma${String.fromCharCode(31)}in`)).not.toBeNull();
  });

  it("is the name the upload path already uses", () => {
    expect(DEFAULT_BRANCH).toBe("main");
    expect(validateBranch(DEFAULT_BRANCH)).toBeNull();
  });
});

describe("defaultBuildSpec", () => {
  const spec = defaultBuildSpec();

  it("is a version 1 Amplify build spec with a frontend phase", () => {
    expect(spec.startsWith("version: 1\n")).toBe(true);
    expect(spec).toContain("frontend:");
    expect(spec).toContain("preBuild:");
    expect(spec).toContain("artifacts:");
  });

  it("uses no tabs — YAML forbids them for indentation and AWS rejects the whole spec", () => {
    expect(spec).not.toContain("\t");
  });

  it("installs only when there is something to install", () => {
    expect(spec).toContain("npm ci");
    expect(spec).toContain("npm install");
    expect(spec).toContain("[ -f package.json ]");
  });

  it("builds only when the repository has a build script", () => {
    expect(spec).toContain("npm run build");
    expect(spec).toMatch(/scripts\)\|\|\{\};process\.exit\(s\.build\?0:1\)/);
  });

  it("looks for the output where frameworks actually put it, ambiguous ones first", () => {
    // dist before public (Vite ships both) and build before public (Create React App's
    // public/index.html is a template, not a site).
    expect(spec).toContain("for candidate in dist build out _site public; do");
  });

  it("publishes a plain repository as it is, without its .git or node_modules", () => {
    expect(spec).toContain("--exclude=./.git");
    expect(spec).toContain("--exclude=./node_modules");
  });

  it("fails loudly rather than publishing whatever was lying around", () => {
    expect(spec).toContain("exit 1");
    expect(spec).toContain("Add an amplify.yml to your repository");
  });

  it("publishes from the one directory it staged, so baseDirectory can be fixed text", () => {
    expect(spec).toContain("baseDirectory: .hostingpoppy-site");
    expect(spec).toContain("mkdir -p .hostingpoppy-site");
  });
});

describe("nextBuildSpec", () => {
  const spec = nextBuildSpec();

  it("is a version 1 Amplify build spec with a frontend phase", () => {
    expect(spec.startsWith("version: 1\n")).toBe(true);
    expect(spec).toContain("frontend:");
    expect(spec).toContain("preBuild:");
    expect(spec).toContain("artifacts:");
  });

  it("uses no tabs — YAML forbids them for indentation and AWS rejects the whole spec", () => {
    expect(spec).not.toContain("\t");
  });

  it("publishes .next, which is what makes AWS run the app instead of serving files", () => {
    // The single line that decides whether this is a website or a server. AWS requires it
    // even for a Next.js 14+ app that only generates static pages.
    expect(spec).toContain("baseDirectory: .next");
  });

  it("shares nothing with the static spec's staging directory", () => {
    // The failure this exists to prevent: the static spec copies a folder of finished files
    // and reports success, leaving a Next.js app serving nothing that renders.
    expect(spec).not.toContain(".hostingpoppy-site");
    expect(defaultBuildSpec()).not.toContain("baseDirectory: .next");
  });

  it("installs without demanding a lockfile", () => {
    // `npm ci` alone fails a repository with no package-lock.json, and that error reads as
    // "my app is broken" rather than "add a file".
    expect(spec).toContain("npm ci");
    expect(spec).toContain("npm install");
    expect(spec).toContain("[ -f package-lock.json ]");
  });

  it("caches the build between pushes, including Next.js's own cache", () => {
    expect(spec).toContain("node_modules/**/*");
    expect(spec).toContain(".next/cache/**/*");
  });
});

describe("branchUrl", () => {
  it("points at the branch's own page on GitHub", () => {
    expect(branchUrl("https://github.com/acme/site", "main")).toBe("https://github.com/acme/site/tree/main");
  });

  it("survives however the user pasted the address", () => {
    // Both of these are what people actually paste, and both would 404 unhandled.
    expect(branchUrl("https://github.com/acme/site.git", "main")).toBe("https://github.com/acme/site/tree/main");
    expect(branchUrl("https://github.com/acme/site/", "main")).toBe("https://github.com/acme/site/tree/main");
    expect(branchUrl("  https://github.com/acme/site.git/  ", "main")).toBe(
      "https://github.com/acme/site/tree/main",
    );
  });

  it("keeps a slash in a branch name as a path, and escapes the rest", () => {
    // feature/new-home is a real and common branch name; its slash is a path separator on
    // GitHub, so it must NOT be escaped away, while a space in one must be.
    expect(branchUrl("https://github.com/acme/site", "feature/new-home")).toBe(
      "https://github.com/acme/site/tree/feature/new-home",
    );
    expect(branchUrl("https://github.com/acme/site", "my branch")).toBe(
      "https://github.com/acme/site/tree/my%20branch",
    );
  });

  it("builds nothing rather than a broken link", () => {
    expect(branchUrl(undefined, "main")).toBeUndefined();
    expect(branchUrl("", "main")).toBeUndefined();
    expect(branchUrl("https://github.com/acme/site", "  ")).toBeUndefined();
    // An uploaded site has no repository, and a non-GitHub address is not ours to guess at:
    // /tree/ is GitHub's shape, and inventing it elsewhere invents a 404.
    expect(branchUrl("https://gitlab.com/acme/site", "main")).toBeUndefined();
  });
});
