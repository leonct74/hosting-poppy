// One calm sentence, with the raw text one click away and never in the sentence.
//
// The pair belongs together in one component because the rule is a pair (UX.md ground rule
// 5): the banner may only ever hold something a human wrote, and the technical detail may
// only ever live behind the disclosure. Kept apart, screens drift — which is exactly how the
// happy path came to print `backend 400: {"message":…}` in a red banner while three other
// screens showed the sentence and hid the AWS text.

import type { CSSProperties } from "react";
import type { Failure } from "../lib/errors";

export interface FailureBannerProps {
  error: Failure;
  /**
   * `err` for something that failed and needs the user, `warn` for something we simply
   * couldn't hear this time — a failed status check is not a failed deploy, and painting it
   * red would tell the user their site broke when nothing of the sort happened.
   */
  tone?: "err" | "warn";
  /** Spacing from whatever it sits next to. The screens differ; the markup shouldn't. */
  style?: CSSProperties;
}

export function FailureBanner({ error, tone = "err", style }: FailureBannerProps) {
  return (
    <div style={style}>
      <div className={`banner ${tone}`} role="alert">
        {error.message}
      </div>
      {error.detail && (
        <details className="details" style={{ marginTop: 8 }}>
          <summary>Technical details</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
    </div>
  );
}
