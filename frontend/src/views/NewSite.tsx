// S2 + S3 + S5 — name the website, say where its code comes from, see what it will cost,
// press go.
//
// Three of UX.md's screens on one scrolling column, because they are three answers to one
// question and the frame is narrow. The order is the order of the decisions: what to call
// it, what kind of thing it is, where its code lives, and only then — with the real repository
// or the real archive in hand — what AWS will charge for it. Nothing is created in the
// user's account until the last button (ground rule 2: money before commitment).
//
// "Where its code lives" is a fork rather than a setting: connecting GitHub hands the rest
// of the screen to `ConnectRepo`, and uploading keeps the path below, which is unchanged.
// Both stay first-class. GitHub is what somebody with a project expects — push, and it's
// live — and uploading is the only way in for a site with no repository or no build step,
// so demoting it to a footnote would lock those people out.
//
// The FIRST question now decides the second one. A site that renders its own pages as people
// visit has to be built, and this poppy can build nothing on the user's machine (DESIGN §4),
// so AWS building it from a repository is not the recommended route — it is the only one. The
// screen therefore drops the fork for that answer rather than offering an upload it would
// refuse, and names the one case where somebody can still take the other path: an app set up
// to export a static site has finished files like any other.
//
// The browser does the file handling on purpose. The backend is confined and cannot read a
// disk, so the picker is the one handover it is allowed: the user chooses, the browser packs
// what they chose, and the bytes cross the bridge. Nothing is read that they did not pick.

import { useRef, useState } from "react";
import { api, uploadSite, type ConnectRepoInput, type GithubSetup, type UploadProgress } from "../api";
import { readFailure, type Failure } from "../lib/errors";
import { AWS_PRICES_NOTE, describeBytes, estimateMonthlyCost, formatBytes } from "../lib/format";
import { CODE_SOURCES, CONSTRAINTS, NAME_FIELD, SITE_TYPES, SOURCES, buildHelperPrompt } from "../lib/helperPrompt";
import { renamedSiteName } from "../lib/siteName";
import { describeArchiveProblem, describeOversizePick, isZip, readAsBytes, zipFolder } from "../lib/zip";
import type { Site, SiteKind } from "../types";
import { ConnectRepo } from "./ConnectRepo";
import { FailureBanner } from "./FailureBanner";

/** The slice of the backend client this screen uses. Injected so tests never touch the bridge. */
export interface NewSiteApi {
  createSite(name: string): Promise<{ site: Site }>;
  uploadSite(
    siteId: string,
    bytes: Uint8Array,
    fileName: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ jobId: string }>;
  /**
   * The GitHub path's two calls, optional because the shell hands this screen the upload
   * pair and nothing else. Left out, `ConnectRepo` reaches for the real client itself —
   * which is right in the app and wrong in a test, so a test passes them.
   */
  githubSetup?(): Promise<GithubSetup>;
  connectRepo?(input: ConnectRepoInput): Promise<{ site: Site; jobId: string }>;
}

export interface NewSiteProps {
  /**
   * AWS is working: hand over to the Progress screen. `uploadedBytes` is what crossed the
   * bridge from this computer — zero for a website AWS builds from a repository, where
   * nothing did.
   */
  onDeployStarted: (started: { site: Site; jobId: string; uploadedBytes: number }) => void;
  /** Back to the list without creating anything. */
  onCancel: () => void;
  /**
   * The website this upload replaces, when there is one — a new version of something that
   * already exists rather than a new website.
   *
   * Set, this screen asks for nothing but the files: there is no name to give (AWS stored
   * the site's name when it was created and nothing here can change it), nothing is created
   * in the user's account, and the copy talks about replacing what is live. Without this the
   * screen asked for a name it then threw away, and promised to make something new.
   */
  updating?: Site;
  api?: NewSiteApi;
  /**
   * Opens a page in the real browser, for the GitHub path's two trips to github.com.
   * Only ever passed by a test — the shell doesn't hand this screen the bridge, and the
   * default inside `ConnectRepo` is the bridge itself.
   */
  openExternal?: (url: string) => void | Promise<void>;
}

const DEFAULT_API: NewSiteApi = { createSite: api.createSite, uploadSite };

/**
 * The traffic the estimate assumes, so the number on screen means something specific.
 *
 * A visitor downloads roughly one page's worth, which for the small sites this poppy hosts
 * is usually the whole thing — so we bill a visit at the site's own size, capped at a couple
 * of megabytes. Both numbers are stated on screen next to the figure they produce: an
 * estimate whose assumptions are hidden is a number the user cannot argue with, and this
 * one is a guess about THEIR audience that only they can correct.
 */
const EXAMPLE_VISITS_PER_MONTH = 1000;
const EXAMPLE_BYTES_PER_VISIT = 2 * 1024 * 1024;

const NOTHING_PICKED = "Nothing came through from that pick — try choosing the folder again.";
const NOT_A_ZIP = "That isn't a .zip — either choose a .zip file, or use “Choose the folder” and pick your build folder instead.";
const FOLDER_DROP = "Dropping a folder in doesn't work here — use “Choose the folder” and pick it in the file window.";
const READ_FAILED = "We couldn't read what you picked — check it hasn't moved or been renamed, then pick it again.";
const LAUNCH_FAILED = "We couldn't put your site online just now — try again in a moment.";

interface Picked {
  /** The archive we will upload, already stripped so index.html is at its root. */
  bytes: Uint8Array;
  /** What to call the archive when it reaches AWS. Cosmetic — Amplify expands it and throws it away. */
  fileName: string;
  /** What the user actually chose, for the sentence describing it back to them. */
  from: string;
}

export function NewSite({
  onDeployStarted,
  onCancel,
  updating,
  api: client = DEFAULT_API,
  openExternal,
}: NewSiteProps) {
  const [name, setName] = useState("");
  /**
   * What is going online (UX.md S2). A finished site is pre-selected because it is the common
   * answer and because ground rule 1 says every choice arrives with one already made — not
   * because the other is lesser. The value is the wire's own word, so nothing here has to
   * translate between what the card says and what AWS is asked for.
   */
  const [kind, setKind] = useState<SiteKind>("static");
  /**
   * How the code gets to AWS (UX.md S3). GitHub is pre-selected because it is the path this
   * poppy leads with — push, and the site updates itself — and because ground rule 1 says
   * every choice arrives with the recommended answer already made. Uploading is one click
   * away and unchanged: it is the way in for somebody with no repository or no build step,
   * and it is what a new version of an existing website always uses.
   */
  const [source, setSource] = useState<"github" | "upload">("github");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [picking, setPicking] = useState<null | "folder" | "zip">(null);
  const [pickError, setPickError] = useState<Failure | null>(null);
  const [dragging, setDragging] = useState(false);

  const [launching, setLaunching] = useState(false);
  const [stage, setStage] = useState<null | "creating" | "sending">(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [launchError, setLaunchError] = useState<Failure | null>(null);
  /**
   * The website AWS has already made for us, kept across a failed upload. Without this, a
   * second press of "Put my site online" after a network wobble would create a SECOND empty
   * website in the user's account — and they would have no idea why one appeared.
   */
  const [createdSite, setCreatedSite] = useState<Site | null>(null);

  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  const [promptText, setPromptText] = useState<string | null>(null);

  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const trimmedName = name.trim();
  /** The name AWS will store, when it isn't the one being typed. Null when they match. */
  const storedName = renamedSiteName(trimmedName);
  /**
   * An app that renders its own pages has to be built, and only AWS can build it — so there
   * is no upload to fall back to and the fork is not a question. Answering it for the user is
   * the honest shape: a card that refuses when pressed is the dead-button defect wearing a
   * different hat (AGENTS.md §9), and the panel below says why in plain words instead.
   */
  const serverRendered = kind === "nextjs";
  /**
   * A new version of a website that already exists is always an upload: it was made that
   * way, and Amplify has no path from a hand-fed website to a connected one — the choice was
   * made when the website was created and it is permanent (DESIGN §3.2). So the fork isn't
   * offered here at all, rather than offered and then refused.
   */
  const chosen = updating ? "upload" : serverRendered ? "github" : source;
  const ready = picked !== null && !launching && (updating !== undefined || trimmedName.length > 0);

  async function takeFiles(list: FileList | File[] | null, kind: "folder" | "zip") {
    const files = list ? Array.from(list) : [];
    setPickError(null);
    setPicked(null);
    setLaunchError(null);
    setPicking(kind);
    try {
      if (files.length === 0) {
        setPickError({ message: NOTHING_PICKED });
        return;
      }

      let bytes: Uint8Array;
      let fileName: string;
      let from: string;

      if (kind === "zip") {
        const file = files[0];
        if (!file) {
          setPickError({ message: NOTHING_PICKED });
          return;
        }
        if (!isZip(file)) {
          setPickError({ message: NOT_A_ZIP });
          return;
        }
        // On the size the browser already knows, before the read. A multi-gigabyte archive
        // read into memory takes the whole poppy down with it, and the user would never
        // learn why — the same reason `zipFolder` measures a folder pick first.
        const tooBigToRead = describeOversizePick(file.size, "zip");
        if (tooBigToRead) {
          setPickError({ message: tooBigToRead });
          return;
        }
        bytes = await readAsBytes(file);
        // Reading the archive's file names is cheap and catches the one mistake that
        // deploys perfectly and serves a 404 on every address: the site one folder deep.
        // It fails open — an archive we can't inspect goes up and AWS judges it.
        const problem = describeArchiveProblem(bytes);
        if (problem) {
          setPickError({ message: problem });
          return;
        }
        fileName = file.name;
        from = file.name;
      } else {
        // zipFolder both packs and vets: it strips the wrapper folder and refuses outright
        // when there is no index.html to serve, with a sentence saying which folder to pick.
        bytes = await zipFolder(files);
        const folder = folderNameOf(files);
        fileName = `${folder}.zip`;
        from = `${folder} (${files.length} ${files.length === 1 ? "file" : "files"})`;
      }

      // The backstop: the checks above go on what the OS reported, and this one on the
      // archive we actually hold. A pick that squeezed past them both is one the backend
      // would refuse anyway, after the whole thing had crossed the bridge.
      const tooBig = describeOversizePick(bytes.length, kind);
      if (tooBig) {
        setPickError({ message: tooBig });
        return;
      }
      setPicked({ bytes, fileName, from });
    } catch (e) {
      setPickError(readFailure(e, READ_FAILED));
    } finally {
      setPicking(null);
      // Let the same folder be picked again after a fix. A file input fires no change event
      // for an identical selection, so without this the second attempt looks like a dead
      // button — the exact defect AGENTS.md §9 opens with.
      if (folderInput.current) folderInput.current.value = "";
      if (zipInput.current) zipInput.current.value = "";
    }
  }

  async function launch() {
    if (!picked) return;
    setLaunching(true);
    setLaunchError(null);
    setProgress(null);
    try {
      // A website we were handed is never created again — that is the whole difference
      // between a new version and a second website in somebody's account.
      let site = updating ?? createdSite;
      if (!site) {
        setStage("creating");
        const created = await client.createSite(trimmedName);
        site = created.site;
        setCreatedSite(site);
      }
      setStage("sending");
      const { jobId } = await client.uploadSite(site.id, picked.bytes, picked.fileName, setProgress);
      onDeployStarted({ site, jobId, uploadedBytes: picked.bytes.length });
    } catch (e) {
      setLaunchError(readFailure(e, LAUNCH_FAILED));
    } finally {
      // Always — a thrown error must never leave the button spinning (AGENTS.md §9).
      setLaunching(false);
      setStage(null);
    }
  }

  async function copyPrompt() {
    const text = buildHelperPrompt();
    const ok = await copyText(text);
    setCopied(ok ? "ok" : "failed");
    // The webview can refuse the clipboard outright. Rather than a button that quietly did
    // nothing, put the prompt on screen where it can be selected by hand.
    setPromptText(ok ? null : text);
  }

  const estimate = picked
    ? estimateMonthlyCost({
        storedBytes: picked.bytes.length,
        servedBytesPerMonth: EXAMPLE_VISITS_PER_MONTH * Math.min(picked.bytes.length, EXAMPLE_BYTES_PER_VISIT),
      })
    : null;

  const percent = progress ? Math.round(progress.fraction * 100) : 0;

  /** The prompt on screen to be selected by hand, for the webview that refuses the clipboard. */
  const promptBox = promptText ? (
    <textarea
      className="input"
      readOnly
      aria-label="The helper prompt, to select and copy"
      value={promptText}
      style={{ marginTop: 10, minHeight: 120 }}
    />
  ) : null;

  return (
    <div>
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{updating ? "Put a new version online" : "Put a website online"}</h2>
        <button className="btn btn-ghost" onClick={onCancel}>
          Back
        </button>
      </div>

      {updating && (
        <div className="banner info" style={{ marginBottom: 14 }}>
          A new version of <strong className="break">{updating.name}</strong>. Choose its files below — it
          replaces what visitors see now, at the same address, and no second website is created. What&rsquo;s
          online stays online until the new version is ready.
        </div>
      )}

      {updating ? (
        /* The kit's quiet size (AGENTS.md §9): somebody putting up a new version has met the
           banner once already, and a second info strip under the one above is shouting. */
        <div style={{ marginBottom: 14 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => void copyPrompt()}>
            {copied === "ok" ? "Copied ✓" : copied === "failed" ? "Select it below" : "✨ Copy the helper prompt"}
          </button>
          {promptBox}
        </div>
      ) : (
        /* The kit's banner size — this is the primary creation form. */
        <div className="banner info" style={{ marginBottom: 14 }}>
          <div className="spread">
            <p className="small" style={{ margin: 0, maxWidth: 420 }}>
              Not sure what to hand over? Paste this into ChatGPT, Claude or whatever AI you
              use, and it will tell you exactly what to do here.
            </p>
            <button
              className={`btn btn-primary${copied === "idle" ? " poppy-helper-pulse" : ""}`}
              onClick={() => void copyPrompt()}
            >
              {copied === "ok" ? "Copied ✓" : copied === "failed" ? "Select it below" : "Copy the helper prompt"}
            </button>
          </div>
          {promptBox}
        </div>
      )}

      {/* Only when there is a name to give. A website that already exists has one, AWS is
          holding it, and asking again for something we would throw away is worse than not
          asking: it reads as "this is where you rename it", which nothing here can do. */}
      {!updating && (
        <div className="card">
          <label className="field">
            <span>{NAME_FIELD.label}</span>
            <input
              className="input"
              value={name}
              disabled={launching}
              placeholder={NAME_FIELD.placeholder}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="hint" style={{ marginTop: -6 }}>
            You can&rsquo;t change it later, and it never appears on the site itself.
          </p>
          {/* Said before they commit, because afterwards it is permanent and invisible: AWS
              stores names as letters, numbers and hyphens, and every screen from then on
              shows the name AWS stored rather than the one that was typed. */}
          {storedName && (
            <p className="hint" style={{ marginTop: 8 }}>
              Saved as <span className="chip">{storedName}</span> — a website&rsquo;s name can only hold
              letters, numbers and hyphens.
            </p>
          )}
        </div>
      )}

      {/* S2 — the first real decision, and the one that settles the next. Both answers are
          hosted now, so both cards are pressable; a card that reads as a choice and isn't is
          the dead-button defect (AGENTS.md §9), and one that says "coming later" about
          something we do is worse.

          Not offered for a new version of a website that already exists: AWS settled this
          when the website was made and nothing here can change it, so asking again could only
          be a promise this screen can't keep — the same reason the fork below is hidden. */}
      {!updating && (
        <>
          <p className="section-title">What are you putting online?</p>
          <div className="grid-2">
            {SITE_TYPES.map((type) => {
              // The card's own id is the product word; `SiteKind` is the wire's. They agree on
              // the one that matters, and anything that isn't the server-rendered card is a
              // folder of finished files.
              const value: SiteKind = type.id === "nextjs" ? "nextjs" : "static";
              const selected = kind === value;
              return (
                <button
                  key={type.id}
                  type="button"
                  className={`card card-choice${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  disabled={launching}
                  onClick={() => setKind(value)}
                >
                  <div className="spread">
                    <h3 style={{ margin: 0 }}>
                      <span aria-hidden="true">{type.emoji}</span> {type.label}
                    </h3>
                    {selected && <span className="badge ok">What we'll do</span>}
                  </div>
                  <p className="small muted" style={{ margin: "8px 0 0" }}>
                    {type.brief}
                  </p>
                </button>
              );
            })}
          </div>
          <p className="hint" style={{ marginTop: -4, marginBottom: 14 }}>
            Set when the website is made, and can&rsquo;t be changed afterwards.
          </p>
        </>
      )}

      {/* S3 — the fork in the road, and the only place the two paths are compared. Real
          buttons rather than a radio group: each one is a whole paragraph, and a card that
          reads as pressable has to be pressable (AGENTS.md §9). */}
      {!updating && (
        <>
          <p className="section-title" style={{ marginTop: 18 }}>
            Where does your code live?
          </p>
          {serverRendered ? (
            /* Where the upload card would be. The sentence has to do two jobs: say plainly
               that there is no second way in for this kind of app, and rescue the one person
               for whom there is — somebody whose Next.js app is set up to export a static
               site really does end up with a folder of finished files, and refusing them
               silently would be wrong. */
            <div className="card card-2">
              <p className="small" style={{ margin: 0 }}>
                <strong>From GitHub — and only from GitHub, for this kind of app.</strong>
              </p>
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                An app that puts its pages together as people visit has to be built first, and only
                AWS can build it — HostingPoppy can&rsquo;t build anything on your computer, so there
                are no finished files to hand over. If your app is set up to <strong>export a static
                site</strong>, that&rsquo;s different: choose <strong>A finished site</strong> above
                and upload what the export produces.
              </p>
            </div>
          ) : (
            <div className="grid-2">
              {CODE_SOURCES.map((option) => {
                const selected = chosen === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`card card-choice${selected ? " selected" : ""}`}
                    aria-pressed={selected}
                    disabled={launching}
                    onClick={() => setSource(option.id === "github" ? "github" : "upload")}
                  >
                    <div className="spread">
                      <h3 style={{ margin: 0 }}>
                        <span aria-hidden="true">{option.emoji}</span> {option.label}
                      </h3>
                      {option.recommended && <span className="badge ok">Recommended</span>}
                    </div>
                    <p className="small" style={{ margin: "6px 0 0" }}>
                      <strong>{option.tagline}</strong>
                    </p>
                    <p className="small muted" style={{ margin: "6px 0 0" }}>
                      {option.brief}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
          {!serverRendered && (
            <p className="hint" style={{ marginTop: -4, marginBottom: 14 }}>
              Pick either one — but pick it now: this can&rsquo;t be swapped over later.
            </p>
          )}
        </>
      )}

      {chosen === "github" ? (
        <ConnectRepo
          name={trimmedName}
          // What the card above said, carried into the one call that acts on it. AWS sets the
          // website up this way once and for ever, so the answer travels rather than being
          // guessed from the repository.
          kind={kind}
          openExternal={openExternal}
          setup={client.githubSetup}
          connect={client.connectRepo}
          // Nothing crossed the bridge — AWS reads the code from GitHub itself, so the
          // progress screen has no upload to describe.
          onConnected={({ site, jobId }) => onDeployStarted({ site, jobId, uploadedBytes: 0 })}
        />
      ) : (
        <>
          <p className="section-title" style={{ marginTop: 18 }}>
            Where do your files come from?
          </p>

          <div
            className={`dropzone${dragging ? " over" : ""}`}
            // The zone looks pressable, so it has to be pressable — it opens the recommended
            // picker. The buttons inside stop the click travelling here, or choosing ".zip"
            // would also pop the folder picker.
            onClick={() => !launching && picking === null && folderInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const dropped = Array.from(e.dataTransfer.files);
              // A dropped folder arrives as zero files in every browser we run in — worth its
              // own sentence, because the user did something reasonable and saw nothing happen.
              if (dropped.length === 0) {
                setPickError({ message: FOLDER_DROP });
                return;
              }
              const first = dropped[0];
              void takeFiles(dropped, first && dropped.length === 1 && isZip(first) ? "zip" : "folder");
            }}
          >
            <p className="small muted" style={{ marginBottom: 12 }}>
              Drag your built site in — or choose it:
            </p>
            <div className="grid-2" style={{ textAlign: "left" }}>
              {SOURCES.map((source) => {
                const kind = source.id === "zip" ? "zip" : "folder";
                const busy = picking === kind;
                return (
                  <div key={source.id}>
                    <button
                      className={`btn${source.id === "folder" ? " btn-primary" : ""}`}
                      disabled={launching || picking !== null}
                      aria-busy={busy || undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (kind === "zip") zipInput.current?.click();
                        else folderInput.current?.click();
                      }}
                    >
                      {busy && <span className="spinner" aria-hidden="true" />}
                      {busy ? "Packing it up…" : source.label}
                    </button>
                    <p className="hint">{source.explain}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hidden inputs, driven by the buttons above — the picker's own styling can't be made
              to match the kit, and every browser renders it differently. */}
          <input
            ref={folderInput}
            data-testid="pick-folder"
            type="file"
            multiple
            aria-label="Choose the folder your site was built into"
            style={{ display: "none" }}
            onChange={(e) => void takeFiles(e.target.files, "folder")}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
          <input
            ref={zipInput}
            data-testid="pick-zip"
            type="file"
            accept=".zip,application/zip"
            aria-label="Choose a .zip of your built site"
            style={{ display: "none" }}
            onChange={(e) => void takeFiles(e.target.files, "zip")}
          />

          {pickError && <FailureBanner error={pickError} style={{ marginTop: 12 }} />}

          {picked && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="spread">
                <span className="chip break">{picked.from}</span>
                <span className="small muted">{formatBytes(picked.bytes.length)} packed up</span>
              </div>
            </div>
          )}

          <details className="details card card-2" style={{ marginTop: 12 }}>
            <summary>What HostingPoppy needs from your files</summary>
            <ul className="small muted" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
              {CONSTRAINTS.map((rule) => (
                <li key={rule} style={{ marginBottom: 6 }}>
                  {rule}
                </li>
              ))}
            </ul>
          </details>

          {picked && estimate && (
            <div className="card" style={{ marginTop: 18 }}>
              <h3>Ready when you are</h3>
              {/* What is really about to happen, which is a different list for a site that
                  already exists — nothing is made, and something live is being replaced. */}
              {updating ? (
                <ul className="small muted" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
                  <li>We'll send {describeBytes(picked.bytes.length)} from this computer up to AWS.</li>
                  <li>
                    It replaces what visitors see on <strong className="break">{updating.name}</strong> — the
                    version that's online now keeps serving them until the new one is ready.
                  </li>
                  <li>
                    The address doesn't change{updating.domain ? ", and neither does your domain" : ""}.
                  </li>
                  <li>Nothing new is created in your AWS account.</li>
                </ul>
              ) : (
                <ul className="small muted" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
                  <li>
                    We'll make a space for <strong>{storedName ?? (trimmedName || "your website")}</strong> in
                    your own AWS account.
                  </li>
                  <li>We'll send {describeBytes(picked.bytes.length)} from this computer up to AWS.</li>
                  <li>AWS puts it online at a secure address of its own, usually within a couple of minutes.</li>
                  <li>Your own domain is a separate step afterwards — the site is live and clickable before that.</li>
                </ul>
              )}

              <div className="card card-2" style={{ marginBottom: 12 }}>
                <p style={{ margin: 0 }}>
                  Costs <strong>{estimate.text}</strong>
                </p>
                <p className="hint" style={{ marginTop: 4 }}>
                  Reckoned on about {EXAMPLE_VISITS_PER_MONTH.toLocaleString("en-GB")} visits a month. Busier
                  than that and it rises with what visitors download, at $0.15 a gigabyte. {AWS_PRICES_NOTE}
                </p>
              </div>

              {launchError && <FailureBanner error={launchError} style={{ marginBottom: 12 }} />}

              {launching && (
                <div style={{ marginBottom: 12 }}>
                  <p className="small muted" style={{ marginBottom: 6 }}>
                    {stage === "creating"
                      ? "Making space for your website in AWS…"
                      : `Sending your files to AWS — ${percent}%`}
                  </p>
                  <div className="bar">
                    <span style={{ width: `${stage === "creating" ? 2 : percent}%` }} />
                  </div>
                </div>
              )}

              <button
                className="btn btn-primary btn-lg"
                onClick={() => void launch()}
                disabled={!ready}
                aria-busy={launching || undefined}
              >
                {launching && <span className="spinner" aria-hidden="true" />}
                {launching ? "Putting it online…" : updating ? "Put the new version online" : "Put my site online"}
              </button>
              {!updating && !trimmedName && !launching && (
                <p className="hint">Give your website a name first.</p>
              )}
              <p className="small muted-2" style={{ marginTop: 10 }}>
                You can remove all of this with one click, any time.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The folder the user picked, read off the paths the browser gave us. */
function folderNameOf(files: File[]): string {
  const first = files[0] as (File & { webkitRelativePath?: string }) | undefined;
  const path = first?.webkitRelativePath ?? "";
  const top = path.split("/")[0];
  return top && top !== first?.name ? top : "site";
}

/**
 * Copy, with the fallback that matters here: the host renders us in a webview that may not
 * grant `clipboard-write`, and a copy button that silently fails is a dead button.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
