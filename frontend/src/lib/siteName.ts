// The name AWS will really store for a website — worked out here, in the browser, so the
// user reads it BEFORE they commit instead of discovering it afterwards.
//
// Two facts make this worth a module. A website's name is not free text: AWS keeps it as
// letters, numbers and hyphens, so "Café ☕" is stored as "Cafe" and "My site" as "My-site".
// And nothing in HostingPoppy can rename a website once it exists — the name the site list
// shows from then on is the one AWS stored. So a surprise here is permanent, which is the
// whole reason the derived name is on screen at all.
//
// This MIRRORS `amplifyAppName` in backend/src/sites.ts, which is the side that actually
// names the thing; the two are separate builds with no package between them, so the mirror
// is a copy. siteName.test.ts runs both functions over the same names and fails the moment
// they disagree, so the copy cannot drift in silence.

/** AWS's own ceiling for a website name. Nothing we generate comes near it. */
const MAX_STORED_NAME = 255;

/** The name AWS will store for a website called `typed`. Never empty — an empty one fails. */
export function storedSiteName(typed: string): string {
  const slug = typed
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STORED_NAME)
    .replace(/-+$/, "");
  return slug || "website";
}

/**
 * The stored name when it differs visibly from what was typed, or null when the user's own
 * words survive unchanged and there is nothing to warn them about.
 *
 * Two cases deliberately stay quiet. Nothing typed yet is not a surprise — the form already
 * asks for a name. And a name with no letter or number in it ("!!!") would derive to
 * "website", which is not what will happen either: the backend refuses that name outright,
 * in its own sentence, and inventing a second answer here would just be wrong twice.
 */
export function renamedSiteName(typed: string): string | null {
  const name = typed.replace(/\s+/g, " ").trim();
  if (!name || !/[a-z0-9]/i.test(name)) return null;
  const stored = storedSiteName(name);
  return stored === name ? null : stored;
}
