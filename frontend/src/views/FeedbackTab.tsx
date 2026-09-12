// The mandatory Feedback tab (AGENTS.md §9a) — the LAST tab in every poppy.
//
// We render the platform's own element rather than building a rating widget, a request form
// and a donate flow of our own: somebody who installs three poppies must find the same four
// things in the same place — rate it, ask for a feature, report a bug, support the
// developer. That consistency is what makes the star rating on a catalogue listing mean
// anything. The element is vendored verbatim from the AgentsPoppy SDK
// (`npm run sync-feedback`; `npm run check-feedback` fails if the copy has drifted).

import { useEffect, useRef } from "react";
import { host } from "../host";
import { defineFeedbackTab } from "../vendor/agentspoppy-feedback-tab";

/** This poppy's manifest id — what a rating is recorded against. */
const POPPY_ID = "com.hostingpoppy.desktop";

/** Where a bug goes: the PUBLIC issue tracker, mirroring `bugsUrl` in extension.json. */
const BUGS_URL = "https://github.com/leonct74/hosting-poppy/issues";

// The tab talks to the AgentsPoppy feedback API itself. The only thing it needs from the
// host is `openExternal` (a sandboxed frame cannot open an OS window), which our bridge
// already has — so this needs no new capability and no new AgentsPoppy release.
// Registering a custom element twice throws, and the vendored `defineFeedbackTab` guards
// against that itself, which is why this can safely sit at module scope.
defineFeedbackTab(host);

export function FeedbackTab() {
  const slot = useRef<HTMLDivElement>(null);

  // Created imperatively so React never tries to reconcile the custom element's shadow DOM.
  useEffect(() => {
    const mount = slot.current;
    if (!mount || mount.firstChild) return;
    const el = document.createElement("agentspoppy-feedback");
    el.setAttribute("poppy", POPPY_ID);
    el.setAttribute("bugs", BUGS_URL);
    el.setAttribute("name", "HostingPoppy");
    mount.appendChild(el);
  }, []);

  return (
    <div className="stack">
      <div>
        <h2 style={{ margin: "0 0 4px" }}>Feedback</h2>
        <p className="muted" style={{ margin: 0 }}>
          Tell us how HostingPoppy is doing. Your rating shows on the AgentsPoppy catalogue, and everything
          here is anonymous unless you choose to leave your email.
        </p>
      </div>
      <div ref={slot} />
    </div>
  );
}
