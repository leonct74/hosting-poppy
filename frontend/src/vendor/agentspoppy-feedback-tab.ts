// GENERATED — DO NOT EDIT. Vendored from AgentsPoppy's extension SDK:
//   packages/extension-sdk/src/feedback-tab.ts   (sha256:28a6cad1da3c7ba1)
// Refresh it with:  npm run sync-feedback
// Edit the copy and `--check` fails: every poppy must ship the SAME Feedback tab, or the
// consistency users rely on — and the rating the catalogue shows — stops meaning anything.

// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
/// <reference lib="dom" />

/**
 * The STANDARD AgentsPoppy Feedback tab — a framework-agnostic custom element
 * (`<agentspoppy-feedback>`) that EVERY poppy mounts as its LAST tab. It is mandatory (AGENTS.md
 * "The Feedback tab"), and it lives here rather than in each poppy so that:
 *
 *   - a user meets the same four things in every poppy they install — rate it, ask for a feature,
 *     report a bug, support the developer — and learns to trust the shape;
 *   - a developer (or an AI building a poppy) writes ONE line instead of a form, a rating widget,
 *     a Stripe integration and a bug flow;
 *   - the rating that ends up on the catalogue can only come from a real install, through the
 *     host, keyed by the same anonymous per-install id purchases use.
 *
 *   defineFeedbackTab(bridge);
 *   <agentspoppy-feedback bugs="https://github.com/you/your-poppy/issues"></agentspoppy-feedback>
 *
 * THE HOST IS NOT INVOLVED (founder 2026-08-07). The tab talks to the AgentsPoppy feedback API
 * directly from the poppy's own frontend, and asks the host for exactly one thing it cannot do
 * itself: `openExternal`, an EXISTING capability every poppy already has. So adding the Feedback
 * tab to a poppy needs no change to — and no new release of — the AgentsPoppy app.
 *
 * SELF-CONTAINED ON PURPOSE — no imports. Poppies don't depend on this package (the SDK isn't
 * published to npm; they mirror the wire contract instead), so they VENDOR this exact file via
 * `scripts/sync-feedback-tab.mjs`, and a checksum test catches any copy that drifts. Adding an
 * import here would break every vendored copy, so don't.
 */

/** A poppy's rating as the Feedback tab renders it. */
export interface RatingInfo {
  /** Average stars across every install that rated (0 when nobody has). */
  average: number;
  /** How many installs rated. */
  count: number;
  /** What THIS install gave, or null if it hasn't rated yet. */
  yours: number | null;
}

/**
 * The ONLY thing this element needs from the host: opening a URL in the system browser (the
 * `host:openExternal` capability every poppy already declares). A sandboxed frame can't open an
 * OS window itself, so the bug tracker and the donation checkout go through here. Every poppy's
 * own inlined bridge already has this method, so a poppy passes its `host` object directly.
 */
export interface FeedbackBridge {
  openExternal(url: string): Promise<void>;
}

/** Where the feedback API lives. Override per element with `api="…"` (used by tests/harnesses). */
const DEFAULT_API = "https://agentspoppy.com";

/**
 * One stable id per INSTALL, minted here and kept in localStorage — the same idea as the host's
 * buyer id, but the poppy's own, so no host call is needed. Every poppy's frontend is served from
 * the broker's fixed origin (127.0.0.1:8799), so this survives restarts and is shared across the
 * poppies on this machine: one person, one rating each.
 *
 * It identifies nobody — it's a random id whose only job is "don't count the same install twice".
 */
const ID_KEY = "ap.feedbackId";
function installId(): string {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked: fall back to a per-session id. Rating still works; it just won't be
    // recognised as the same install next time.
    return `session-${Math.random().toString(36).slice(2)}`;
  }
}

const TAG = "agentspoppy-feedback";

/** Founder-set floor: a donation is at least this many whole US dollars. */
export const DONATION_MIN_USD = 5;
export const FEATURE_REQUEST_MAX = 500;
export const DONATION_MESSAGE_MAX = 100;
/** The amounts offered as one click. Anything else goes in the box. */
const PRESETS = [5, 10, 25];

const STYLE = `
  :host { display: block; font-family: system-ui, -apple-system, sans-serif; color: var(--poppy-text, #ece9e2); }
  section {
    border: 1px solid var(--poppy-border, #2e2b27); border-radius: 12px;
    padding: 16px 18px; margin: 0 0 14px; background: var(--poppy-surface, #171614);
  }
  h3 { font-size: 15px; margin: 0 0 4px; font-weight: 640; }
  p { margin: 0 0 12px; font-size: 13px; color: var(--poppy-text-muted, #a8a294); line-height: 1.5; }
  p:last-child { margin-bottom: 0; }
  .stars { display: flex; gap: 4px; }
  .star {
    background: none; border: none; padding: 2px; cursor: pointer; line-height: 1;
    font-size: 30px; color: var(--poppy-border, #3d3b37);
  }
  .star.on { color: #e0a86d; }
  .star:disabled { cursor: default; }
  .tally { font-size: 12px; color: var(--poppy-text-muted, #8f8a80); margin-top: 8px; }
  textarea, input[type="number"] {
    width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 8px;
    border: 1px solid var(--poppy-border, #3d3b37); background: var(--poppy-bg, #0f0e0d);
    color: var(--poppy-text, #ece9e2); font: inherit; font-size: 13px;
  }
  textarea { resize: vertical; min-height: 74px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .count { font-size: 11px; color: var(--poppy-text-muted, #8f8a80); margin-top: 4px; text-align: right; }
  .count.over { color: #e0836d; }
  button.action {
    border: none; border-radius: 999px; padding: 8px 15px; font-size: 13px; font-weight: 600;
    cursor: pointer; background: var(--poppy-accent, #d97757); color: #1a1712;
  }
  button.action:disabled { opacity: 0.5; cursor: default; }
  button.ghost {
    background: none; border: 1px solid var(--poppy-border, #3d3b37);
    color: var(--poppy-text, #ece9e2); border-radius: 999px; padding: 8px 15px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  button.preset {
    background: none; border: 1px solid var(--poppy-border, #3d3b37);
    color: var(--poppy-text, #ece9e2); border-radius: 999px; padding: 7px 14px;
    font-size: 13px; cursor: pointer; font-weight: 600;
  }
  button.preset[aria-pressed="true"] { background: var(--poppy-accent, #d97757); color: #1a1712; border-color: transparent; }
  .amount { width: 96px; }
  .note { font-size: 12px; color: var(--poppy-text-muted, #8f8a80); }
  .msg { font-size: 13px; margin-top: 10px; }
  .ok { color: #7bbf7b; }
  .bad { color: #e0836d; }
  .mark { width: 13px; height: 13px; vertical-align: -1px; }
`;

// The AgentsPoppy four-petal mark, so a donation reads as a platform checkout (same as the
// purchase button) rather than as a poppy asking for money on its own terms.
const MARK = `<svg class="mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="7" r="4"/><circle cx="12" cy="17" r="4"/><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/></svg>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** POST/GET the feedback API. Throws a sentence the tab can show, never a status code. */
async function apiCall<T>(base: string, path: string, body?: unknown, whatFailed = "reach AgentsPoppy"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/feedback/${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`Couldn't ${whatFailed} — check your internet connection.`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      json.error === "donations_unavailable"
        ? "This developer hasn't set up payments yet, so donations aren't possible."
        : `Couldn't ${whatFailed} (${json.error ?? res.status}).`,
    );
  }
  return json;
}

/**
 * Define `<agentspoppy-feedback>`, bound to the poppy's host bridge. Idempotent and a no-op
 * outside a browser (SSR-safe). Attributes:
 *   `bugs`  — https URL of the public issue tracker (usually the manifest's `bugsUrl`). Omit it
 *             and the bug-report block explains there's no public tracker instead of dead-ending.
 *   `name`  — the poppy's display name, used in the copy ("Rate MailPoppy").
 *   `poppy` — REQUIRED: the poppy's manifest id (e.g. "com.mailpoppy.desktop"), which is what
 *             the rating is recorded against.
 *   `api`   — override the API origin (tests and local harnesses only).
 */
export function defineFeedbackTab(bridge: FeedbackBridge): void {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(TAG)) return;

  class FeedbackTab extends HTMLElement {
    private root = this.attachShadow({ mode: "open" });
    private rating: RatingInfo = { average: 0, count: 0, yours: null };
    private hovered = 0;
    private amount = DONATION_MIN_USD;
    private busy = false;

    connectedCallback(): void {
      this.render();
      void this.loadRating();
    }

    private get bugsUrl(): string {
      return this.getAttribute("bugs")?.trim() ?? "";
    }
    private get poppyName(): string {
      return this.getAttribute("name")?.trim() || "this poppy";
    }
    private get poppyId(): string {
      return this.getAttribute("poppy")?.trim() ?? "";
    }
    private get api(): string {
      return this.getAttribute("api")?.trim() || DEFAULT_API;
    }

    private async loadRating(): Promise<void> {
      try {
        const q = new URLSearchParams({ poppyId: this.poppyId, buyerId: installId() });
        this.rating = await apiCall<RatingInfo>(this.api, `rating?${q}`);
        this.paintRating();
      } catch {
        // A rating we can't read is not worth an error message — the stars simply start empty.
      }
    }

    /** Show a result under one section without re-rendering the whole tab (which would throw
     *  away whatever the user has typed in the others). */
    private say(id: string, text: string, ok: boolean): void {
      const el = this.root.getElementById(id);
      if (el) {
        el.textContent = text;
        el.className = `msg ${ok ? "ok" : "bad"}`;
      }
    }

    private async rate(stars: number): Promise<void> {
      if (this.busy) return;
      this.busy = true;
      try {
        this.rating = await apiCall<RatingInfo>(
          this.api,
          "rating",
          { poppyId: this.poppyId, buyerId: installId(), stars },
          "save your rating",
        );
        this.paintRating();
        this.say("rate-msg", "Thank you — your rating is in.", true);
      } catch (e) {
        this.say("rate-msg", e instanceof Error ? e.message : "Could not save your rating.", false);
      } finally {
        this.busy = false;
      }
    }

    private async sendRequest(): Promise<void> {
      const box = this.root.getElementById("request") as HTMLTextAreaElement | null;
      const text = box?.value.trim() ?? "";
      if (!text || text.length > FEATURE_REQUEST_MAX) return;
      this.say("request-msg", "Sending…", true);
      try {
        await apiCall(this.api, "feature-request", { poppyId: this.poppyId, buyerId: installId(), text }, "send your request");
        if (box) box.value = "";
        this.updateCounts();
        this.say("request-msg", "Sent. The developer can read it in their dashboard.", true);
      } catch (e) {
        this.say("request-msg", e instanceof Error ? e.message : "Could not send your request.", false);
      }
    }

    private async donate(): Promise<void> {
      const msgBox = this.root.getElementById("donate-message") as HTMLInputElement | null;
      const message = msgBox?.value.trim() ?? "";
      if (this.amount < DONATION_MIN_USD || !Number.isInteger(this.amount)) {
        this.say("donate-msg", `The smallest donation is $${DONATION_MIN_USD}.`, false);
        return;
      }
      if (message.length > DONATION_MESSAGE_MAX) return;
      this.say("donate-msg", "Opening checkout…", true);
      try {
        const { url } = await apiCall<{ url: string }>(
          this.api,
          "donate",
          { poppyId: this.poppyId, buyerId: installId(), amountUsd: this.amount, ...(message ? { message } : {}) },
          "start the donation",
        );
        // The ONE host call: a sandboxed frame can't open an OS window itself.
        await bridge.openExternal(url);
        this.say("donate-msg", "Checkout is open in your browser. Thank you for supporting the developer.", true);
      } catch (e) {
        this.say("donate-msg", e instanceof Error ? e.message : "Could not start the donation.", false);
      }
    }

    private async reportBug(): Promise<void> {
      if (this.bugsUrl) await bridge.openExternal(this.bugsUrl);
    }

    /** Live character counts, and the send button disabled while a box is empty or over its cap. */
    private updateCounts(): void {
      const req = this.root.getElementById("request") as HTMLTextAreaElement | null;
      const reqCount = this.root.getElementById("request-count");
      const send = this.root.getElementById("send-request") as HTMLButtonElement | null;
      if (req && reqCount) {
        const n = req.value.trim().length;
        reqCount.textContent = `${n}/${FEATURE_REQUEST_MAX}`;
        reqCount.className = n > FEATURE_REQUEST_MAX ? "count over" : "count";
        if (send) send.disabled = n === 0 || n > FEATURE_REQUEST_MAX;
      }
      const msg = this.root.getElementById("donate-message") as HTMLInputElement | null;
      const msgCount = this.root.getElementById("donate-count");
      if (msg && msgCount) {
        const n = msg.value.trim().length;
        msgCount.textContent = `${n}/${DONATION_MESSAGE_MAX}`;
        msgCount.className = n > DONATION_MESSAGE_MAX ? "count over" : "count";
      }
    }

    private starsMarkup(): string {
      const shown = this.hovered || this.rating.yours || 0;
      return [1, 2, 3, 4, 5]
        .map(
          (n) =>
            `<button class="star${n <= shown ? " on" : ""}" data-star="${n}" title="${n} star${n > 1 ? "s" : ""}" aria-label="${n} out of 5">★</button>`,
        )
        .join("");
    }

    private render(): void {
      const tally = this.tallyText();

      this.root.innerHTML = `
        <style>${STYLE}</style>

        <section>
          <h3>Rate ${esc(this.poppyName)}</h3>
          <p>Your rating shows on the AgentsPoppy catalogue. It is anonymous, and you can change it any time.</p>
          <div class="stars">${this.starsMarkup()}</div>
          <div class="tally">${esc(tally)}</div>
          <div class="msg" id="rate-msg"></div>
        </section>

        <section>
          <h3>Ask for a feature</h3>
          <p>Tell the developer what you wish this did. If you'd like them to be able to write back,
             put your email address in the message — it's optional.</p>
          <textarea id="request" maxlength="${FEATURE_REQUEST_MAX}" placeholder="I wish it could…"></textarea>
          <div class="count" id="request-count">0/${FEATURE_REQUEST_MAX}</div>
          <button class="action" id="send-request" disabled>Send request</button>
          <div class="msg" id="request-msg"></div>
        </section>

        <section>
          <h3>Report a bug</h3>
          ${
            this.bugsUrl
              ? `<p>Bugs go to the public issue tracker, so everyone — including an AI reading the
                    repository — can see the problem and the fix.</p>
                 <button class="ghost" id="report-bug">Report a bug on GitHub →</button>`
              : `<p>This poppy hasn't published a public issue tracker, so there's nowhere to file a
                    bug from here. Its listing on the catalogue names how to reach the developer.</p>`
          }
        </section>

        <section>
          <h3>Support the developer</h3>
          <p>If this poppy saves you time, you can say so with a one-off donation. It goes through
             AgentsPoppy checkout ${MARK} — the same as any purchase — and the developer receives it.</p>
          <div class="row">
            ${PRESETS.map(
              (v) =>
                `<button class="preset" data-amount="${v}" aria-pressed="${v === this.amount}">$${v}</button>`,
            ).join("")}
            <input class="amount" id="amount" type="number" min="${DONATION_MIN_USD}" step="1" value="${this.amount}" aria-label="Donation amount in US dollars" />
            <span class="note">minimum $${DONATION_MIN_USD}</span>
          </div>
          <p style="margin:12px 0 6px">Developers love to thank their users directly — if you don't
             mind being contacted, put your email address in the message.</p>
          <input id="donate-message" maxlength="${DONATION_MESSAGE_MAX}" placeholder="Optional message" style="width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--poppy-border,#3d3b37);background:var(--poppy-bg,#0f0e0d);color:var(--poppy-text,#ece9e2);font:inherit;font-size:13px" />
          <div class="count" id="donate-count">0/${DONATION_MESSAGE_MAX}</div>
          <button class="action" id="donate">Donate $<span id="donate-amount">${this.amount}</span></button>
          <div class="msg" id="donate-msg"></div>
        </section>
      `;
      this.wire();
    }

    private wire(): void {
      for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".star"))) {
        const n = Number(el.dataset.star);
        el.onclick = () => void this.rate(n);
        el.onmouseenter = () => {
          this.hovered = n;
          this.paintStars();
        };
        el.onmouseleave = () => {
          this.hovered = 0;
          this.paintStars();
        };
      }

      const req = this.root.getElementById("request") as HTMLTextAreaElement | null;
      if (req) req.oninput = () => this.updateCounts();
      const send = this.root.getElementById("send-request") as HTMLButtonElement | null;
      if (send) send.onclick = () => void this.sendRequest();

      const bug = this.root.getElementById("report-bug") as HTMLButtonElement | null;
      if (bug) bug.onclick = () => void this.reportBug();

      for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".preset"))) {
        el.onclick = () => this.setAmount(Number(el.dataset.amount));
      }
      const amount = this.root.getElementById("amount") as HTMLInputElement | null;
      if (amount) amount.oninput = () => this.setAmount(Number(amount.value), true);

      const msg = this.root.getElementById("donate-message") as HTMLInputElement | null;
      if (msg) msg.oninput = () => this.updateCounts();
      const donate = this.root.getElementById("donate") as HTMLButtonElement | null;
      if (donate) donate.onclick = () => void this.donate();
    }

    /**
     * Update the rating display IN PLACE — the stars and the tally line.
     *
     * Deliberately not a re-render: a user who types a feature request and THEN rates would
     * otherwise watch their words vanish, because rendering replaces every node in the shadow
     * root. Same reason `say()` writes into one element instead of redrawing.
     */
    private paintRating(): void {
      this.paintStars();
      const tally = this.root.querySelector(".tally");
      if (tally) tally.textContent = this.tallyText();
    }

    private tallyText(): string {
      const r = this.rating;
      return r.count
        ? `★ ${r.average.toFixed(1)} from ${r.count} ${r.count === 1 ? "person" : "people"}${r.yours ? ` · you gave ${r.yours}` : ""}`
        : "No ratings yet — yours would be the first.";
    }

    /** Repaint only the stars, so hovering doesn't reset the boxes underneath. */
    private paintStars(): void {
      const shown = this.hovered || this.rating.yours || 0;
      for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".star"))) {
        el.classList.toggle("on", Number(el.dataset.star) <= shown);
      }
    }

    /** `fromInput` keeps the number box under the user's control mid-typing. */
    private setAmount(v: number, fromInput = false): void {
      this.amount = Number.isFinite(v) ? Math.floor(v) : DONATION_MIN_USD;
      const amountBox = this.root.getElementById("amount") as HTMLInputElement | null;
      if (amountBox && !fromInput) amountBox.value = String(this.amount);
      const label = this.root.getElementById("donate-amount");
      if (label) label.textContent = String(this.amount);
      for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".preset"))) {
        el.setAttribute("aria-pressed", String(Number(el.dataset.amount) === this.amount));
      }
      const donate = this.root.getElementById("donate") as HTMLButtonElement | null;
      if (donate) donate.disabled = this.amount < DONATION_MIN_USD;
    }
  }

  customElements.define(TAG, FeedbackTab);
}
