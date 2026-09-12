// Removing one website — the scoped destructive control (AGENTS.md §4).
//
// This throws away live infrastructure in somebody's own AWS account, so it earns the full
// ceremony rather than a confirm dialog:
//
//  - two distinct steps: the first press only opens the dialog, a second, differently
//    labelled action destroys;
//  - the blast radius is named item by item, in plain words, including the things that are
//    NOT touched — "what survives" is the half people actually worry about;
//  - type-the-site-name arms the button, so this can never happen on autopilot;
//  - Cancel holds focus, so a stray Enter or a double-click can't destroy anything.
//
// `window.confirm` is not an option even if we wanted it: inside the host's webview it can
// silently do nothing, which would make the whole control look dead (AGENTS.md §9).

import { useEffect, useRef, useState } from "react";
import { readFailure, type Failure } from "../lib/errors";
import { FailureBanner } from "./FailureBanner";

export interface DangerZoneProps {
  /** The site's name — what it is called, and the word that arms the button. */
  siteName: string;
  /** Its AWS address, named in the dialog so "which links stop working" is concrete. */
  address?: string;
  /** The user's own domain, when one is attached. Changes what gets deleted. */
  domain?: string;
  /** True while AWS is mid-upload — removing then would race a job we can't cancel. */
  disabled?: boolean;
  /** Does the removal. Rejecting keeps the dialog open and shows the reason inside it. */
  onRemove: () => Promise<void>;
}

/** What the banner says when nothing in the failure was written for a person. */
const REMOVE_FAILED =
  "Something went wrong while removing this website — the technical details say what AWS reported.";

export function DangerZone({ siteName, address, domain, disabled, onRemove }: DangerZoneProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Tolerate the stray space a paste or an autocorrect adds, but require the exact name:
  // the point of typing it is to notice WHICH website this is.
  const matches = typed.trim() === siteName.trim();

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const destroy = async () => {
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove();
      close();
    } catch (e) {
      setError(readFailure(e, REMOVE_FAILED));
    } finally {
      // Always clears, so a rejection can never leave the button spinning for ever.
      setBusy(false);
    }
  };

  const host = hostOf(address);

  return (
    <div className="card card-2">
      <h2 className="section-title">Remove this website</h2>
      <div className="spread">
        <p className="muted" style={{ margin: 0, maxWidth: "46ch" }}>
          Deletes this website from your AWS account — the files you put online, its address, and any domain
          you connected to it. Nothing else in your account is touched.
        </p>
        <button
          className="btn btn-danger"
          disabled={disabled}
          title={disabled ? "Wait for the upload to finish first" : undefined}
          onClick={() => setOpen(true)}
        >
          Remove this website…
        </button>
      </div>
      {disabled && (
        <p className="muted small" style={{ margin: "10px 0 0" }}>
          Available again once the version being put online has finished.
        </p>
      )}

      {open && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="remove-site-title">
          <div className="modal stack">
            <h3 id="remove-site-title" style={{ margin: 0 }} className="break">
              Remove {siteName} from your AWS account?
            </h3>

            <p style={{ margin: 0 }}>This deletes, permanently:</p>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>the website and every file you put online here</li>
              <li>
                its address{host ? <> — <span className="mono break">{host}</span></> : ""} — any link to it
                stops working, straight away
              </li>
              {domain && (
                <li>
                  the connection for <span className="mono break">{domain}</span> and the free security
                  certificate that came with it. The domain stays yours — it just stops pointing here.
                </li>
              )}
            </ul>
            <p style={{ margin: 0 }}>
              <strong>This can't be undone.</strong> Your AWS account, your other websites and the files on
              your own computer are not touched — you can put this site online again any time by uploading it
              afresh.
            </p>

            <label className="field" style={{ margin: 0 }}>
              <span>
                To switch on the button below, type <strong>{siteName}</strong> here:
              </span>
              <input
                className="input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={siteName}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label={`Type ${siteName} to confirm`}
                disabled={busy}
              />
              {typed.length > 0 &&
                (matches ? (
                  <small style={{ color: "var(--poppy-ok)", fontSize: 12 }}>Match — the button is now on.</small>
                ) : (
                  <small className="muted" style={{ fontSize: 12 }}>
                    Doesn't match yet — type the name exactly as it's written above.
                  </small>
                ))}
            </label>

            {error && <FailureBanner error={error} />}

            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" ref={cancelRef} onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                disabled={!matches || busy}
                aria-busy={busy || undefined}
                title={matches ? undefined : `Type ${siteName} above to switch this on`}
                onClick={() => void destroy()}
              >
                {busy && <span className="spinner" aria-hidden="true" />}
                <span>{busy ? "Removing…" : "Remove this website"}</span>
              </button>
            </div>

            {!matches && !busy && (
              <p className="muted" style={{ margin: 0, fontSize: 12, textAlign: "right" }}>
                The button turns on once the name matches.
              </p>
            )}
            {busy && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                This takes a couple of minutes — AWS takes the security certificate down with it. It keeps
                going even if you leave this tab.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Just the host part of the site's address, so the dialog names a thing, not a URL. */
function hostOf(address?: string): string {
  const text = (address ?? "").trim();
  if (!text) return "";
  return text.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}
