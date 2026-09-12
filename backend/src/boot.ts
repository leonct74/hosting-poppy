// Bootstrap + credential minting for the container model.
//
// The host spawns this backend and injects AGENTSPOPPY_BOOTSTRAP (JSON). We mint
// short-lived, tag-scoped credentials on demand by POSTing credentialsUrl with the
// per-backend bearer token, and hand them to the AWS SDK as an auto-refreshing
// credential provider. We NEVER see the operator's own keys. See AGENTS.md §7.

export interface BackendBootstrap {
  connectionId: string;
  credentialsUrl: string;
  credentialsToken?: string;
  port?: number;
  /**
   * The private, per-poppy folder the host created for us (0700) — under confinement
   * (extension.json `backend.isolation: "strict"`) the ONLY place outside the OS temp dir
   * this backend may write. The site registry lives in `<dataDir>/sites.json` (storage.ts). Absent
   * only on a host too old to send it, which is also a host too old to confine us.
   */
  dataDir?: string;
  account: { accountId: string; region: string };
}

/** AWS SDK v3 AwsCredentialIdentity (structural — avoids importing the SDK here). */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

const REFRESH_BUFFER_MS = 300_000; // re-mint 5 min before expiry

export function readBootstrap(): BackendBootstrap {
  const raw = process.env.AGENTSPOPPY_BOOTSTRAP;
  if (!raw) throw new Error("AGENTSPOPPY_BOOTSTRAP is not set — this backend must be spawned by AgentsPoppy.");
  let boot: BackendBootstrap;
  try {
    boot = JSON.parse(raw);
  } catch (e) {
    throw new Error(`AGENTSPOPPY_BOOTSTRAP is not valid JSON: ${(e as Error).message}`);
  }
  if (!boot.connectionId || !boot.credentialsUrl || !boot.account?.accountId) {
    throw new Error("AGENTSPOPPY_BOOTSTRAP is missing required fields (connectionId/credentialsUrl/account).");
  }
  return boot;
}

interface ScopedCredentialsDTO {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

/** True when the body is a full scoped-credentials object (not a 202 approval envelope). */
function isScopedCredentials(v: unknown): v is ScopedCredentialsDTO {
  const c = v as Partial<ScopedCredentialsDTO> | null;
  return (
    !!c &&
    typeof c.accessKeyId === "string" &&
    typeof c.secretAccessKey === "string" &&
    typeof c.sessionToken === "string" &&
    !!c.expiration
  );
}

/** Injectable deps so the mint/approval logic is unit-testable without real fetch/timers. */
export interface CredentialDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const APPROVAL_POLL_MS = 2000;

/**
 * An auto-refreshing credential provider backed by the broker's mint endpoint.
 *
 * A NORMAL connection answers the mint at once (200 + scoped credentials). A
 * *supervised* connection answers `202 { approvalRequired, approval }` — the user must
 * approve in the AgentsPoppy window — so we poll (echoing the approval id) until it's
 * approved (→ credentials) or denied (→ error). A 202 is still `res.ok`, so we MUST
 * distinguish by body shape, not status — mishandling this yields the AWS SDK's
 * "Resolved credential object is not valid". Mirrors MailPoppy's proven minter.
 *
 * Caches until ~5 min before expiry, then re-mints. Never falls back to broader creds
 * when the broker refuses (framework decision D1).
 *
 * Carried over from VM-Poppy unchanged apart from the poppy name in the error copy — it
 * is the same broker contract, and the 202-envelope handling below is hard-won: a 202 is
 * still `res.ok`, so distinguishing by body shape rather than status is what avoids the
 * AWS SDK's opaque "Resolved credential object is not valid".
 */
export function brokerCredentialsProvider(
  boot: BackendBootstrap,
  deps: CredentialDeps = {},
): AwsCredentialIdentityProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cached: AwsCredentialIdentity | null = null;

  const post = async (body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (boot.credentialsToken) headers["authorization"] = `Bearer ${boot.credentialsToken}`;
    try {
      return await doFetch(boot.credentialsUrl, {
        method: "POST",
        headers: Object.keys(headers).length ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // The broker isn't answering at all (host shutting down, connection torn down
      // underneath us). AGENTS.md §7: surface a calm "waiting for AWS access", never a
      // raw transport error like "fetch failed".
      throw new Error(
        `HostingPoppy is waiting for AWS access from AgentsPoppy. If this doesn't clear, reopen AgentsPoppy and check HostingPoppy is connected. (${(e as Error).message})`,
      );
    }
  };

  async function mint(): Promise<AwsCredentialIdentity> {
    let res = await post();
    for (;;) {
      if (!res.ok) {
        let message = `AgentsPoppy won't grant AWS access right now (${res.status}). Check that HostingPoppy is connected and your AWS access is healthy in AgentsPoppy.`;
        try {
          const b = (await res.json()) as { message?: string };
          if (b?.message) message = b.message;
        } catch {
          /* keep the status-based message */
        }
        // A pending approval has a short TTL; if it lapsed mid-wait, transparently re-request.
        if (/expired|already been used|request again/i.test(message)) {
          await sleep(APPROVAL_POLL_MS);
          res = await post();
          continue;
        }
        throw new Error(message);
      }
      const body: unknown = await res.json();
      if (isScopedCredentials(body)) {
        return {
          accessKeyId: body.accessKeyId,
          secretAccessKey: body.secretAccessKey,
          sessionToken: body.sessionToken,
          expiration: new Date(body.expiration),
        };
      }
      // Not credentials → a supervised-approval envelope. Poll until the user decides.
      const approvalId = (body as { approval?: { id?: string } })?.approval?.id;
      if (!approvalId) throw new Error("AgentsPoppy returned an unexpected credentials response.");
      await sleep(APPROVAL_POLL_MS);
      res = await post({ approvalId });
    }
  }

  return async () => {
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > REFRESH_BUFFER_MS) {
      return cached;
    }
    cached = await mint();
    return cached;
  };
}
