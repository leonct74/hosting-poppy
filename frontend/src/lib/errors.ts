// Turning a thrown thing into something a person can read. The ONE place it happens.
//
// The host bridge does not hand us the backend's reply — it flattens it. The host does
// `throw new Error(`backend ${res.status}: ${text}`)`, and `text` is the JSON body our
// backend answered with (`{ "message": …, "detail"?: … }` — backend/src/errors.ts). So the
// sentence written FOR this user arrives welded to an HTTP status and wrapped around the
// raw AWS text that must never reach a primary screen (UX.md ground rule 5). Unwrapping is
// not cosmetic: without it, somebody who types too long a website name reads
// `backend 400: {"message":"That name is a little long — keep it under 100 characters."}`
// in a red banner, technical detail and all.
//
// Anything that is NOT a backend reply — a bridge timeout, a sentence this frontend threw
// itself — was already written for a person, so it passes straight through.
//
// It lived as a private copy inside three screens, while the four screens of the happy path
// shared a helper that only ever read `.message` — so the poppy both handled the envelope
// correctly and printed it raw, depending on where you were standing. One implementation, so
// that can't drift apart again.

/** A failure, split into the part the user reads and the part they can open if they want to. */
export interface Failure {
  /** One calm sentence, naming the next thing to do. Never a raw error. */
  message: string;
  /** What AWS actually said, for the "Technical details" disclosure. Absent when there is nothing to add. */
  detail?: string;
}

/**
 * The sentence for a failure, plus the raw text to hide behind a disclosure.
 *
 * `fallback` is what the banner says when nothing in the thrown value was written for a
 * person — so it should name what was being attempted ("We couldn't read your websites…"),
 * because at that point it is the only thing the user has.
 */
export function readFailure(e: unknown, fallback: string): Failure {
  const raw = String((e as { message?: unknown } | null)?.message ?? e ?? "").trim();
  if (!raw) return { message: fallback };

  // The status prefix is the bridge's, the body is ours. Both readings are needed: the same
  // JSON reaches us bare from anything that rejects with the reply rather than wrapping it.
  const prefix = /^backend \d{3}:\s*/.exec(raw);
  const body = prefix ? raw.slice(prefix[0].length) : raw;

  const reply = parseReply(body);
  if (reply) {
    // A reply with only a detail still names what failed for us, so the caller's sentence
    // carries the banner and the raw half keeps its place behind the disclosure.
    const message = reply.message || fallback;
    return reply.detail ? { message, detail: reply.detail } : { message };
  }

  // Nothing readable in there. Whatever the bridge wrapped is raw text — from AWS, or from a
  // gateway that never reached our backend — so it belongs in the disclosure and the banner
  // says the caller's sentence instead. An UNwrapped throw is a sentence somebody wrote (a
  // bridge timeout, one of this frontend's own messages), so it stays exactly as it is.
  return prefix ? { message: fallback, detail: body || raw } : { message: raw };
}

/** The `{ message, detail? }` shape our backend answers with, or null when the body isn't one. */
function parseReply(body: string): { message: string; detail?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // an HTML error page, a plain sentence, an empty body
  }
  if (!parsed || typeof parsed !== "object") return null;

  const { message, detail } = parsed as { message?: unknown; detail?: unknown };
  const sentence = typeof message === "string" ? message.trim() : "";
  const technical = typeof detail === "string" ? detail.trim() : "";
  // Neither field means this JSON is something else entirely — a payload, not a reply.
  if (!sentence && !technical) return null;
  return technical ? { message: sentence, detail: technical } : { message: sentence };
}
