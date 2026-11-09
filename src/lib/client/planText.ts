import { COST_LABEL, masksAvailable, parsePricingCounts, type Issue, type PlanReviewItem, type SaidVsSeenEntry, type WorkPlan } from "@/lib/types";
import { fixFirstPlanLines } from "./fixFirst";
import { shareProgressLine } from "./stepProgress";
import { shareFixedLine } from "./problemsFixed";
import { countsShareLine } from "./countMethod";
import { partlyCount, planReview, reviewTally, supportedScope, verdictFor, verdictKind } from "@/lib/review";
import { runCostLine } from "./runCost";
import { coverageNote, rankedIssues, watchItems, type WatchItem } from "@/lib/planExtras";
import { walkTextLines } from "./walkTimeline";
import { calendarSummary } from "./stepCalendar";
import { noStepsCostLine, noStepsLine } from "./planEmpty";
import { nextUpShareLine } from "./nextUp";

/**
 * Longest share text we hand to the share sheet or clipboard. Sized for a group text (carriers join SMS up to
 * about 1,600 characters); long plans are cut at a line with a pointer to the PDF.
 */
export const MAX_SHARE_CHARS = 1600;

/** Last line when no PDF rides along: the teammate has no link to the plan, so say where it came from. */
export const SHARE_SIGNOFF = "Made with SightWork · sightwork.vercel.app";
export const SHARE_SIGNOFF_PDF = "Full plan with proof photos in the attached PDF.";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const span = (r: [number, number], unit = "") => (r[0] === r[1] ? `${r[0]}${unit}` : `${r[0]}-${r[1]}${unit}`);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

const PRIORITY: Record<string, string> = { high: "High priority", medium: "Medium priority", low: "Low priority" };

/** "Oct 30, 2026": the day the plan was shared or saved. */
export function shareDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * One sentence on how many material prices came from a live web search for the plan's place, the same
 * words on the cost card, in the shared text and in the PDF. Null when the cost step reported no counts
 * (example plans, older plans) or priced nothing.
 */
export function livePricesLine(costRange: { pricing?: unknown; region?: unknown } | null | undefined): string | null {
  if (!costRange) return null;
  const p = parsePricingCounts(costRange.pricing);
  if (!p || p.priced === 0) return null;
  const region = typeof costRange.region === "string" ? clean(costRange.region) : "";
  const where = region ? ` for ${region}` : "";
  const noun = p.priced === 1 ? "material price" : "material prices";
  if (p.grounded === p.priced) return p.priced === 1 ? `The 1 material price was looked up live on the web${where}.` : `All ${p.priced} ${noun} looked up live on the web${where}.`;
  if (p.grounded === 0) return `No live prices found, so the ${p.priced === 1 ? "" : `${p.priced} `}${noun} ${p.priced === 1 ? "is a regional estimate" : "are regional estimates"}${where}.`;
  return `${p.grounded} of ${p.priced} ${noun} looked up live on the web${where}; the rest are regional estimates.`;
}

/**
 * City and state the plan is for ("Sebring, FL"), when it has one: the run's own region first (kept even when
 * the cost step failed), else the region the cost range was priced for.
 */
export function planLocation(plan: Pick<WorkPlan, "costRange" | "meta">): string | null {
  const fromMeta = typeof plan.meta?.region === "string" ? clean(plan.meta.region) : "";
  if (fromMeta) return fromMeta;
  const r = typeof plan.costRange?.region === "string" ? clean(plan.costRange.region) : "";
  return r || null;
}

/**
 * The finished plan with the region the browser sent stamped on as meta.region, when the server left it off.
 * A region the server already set wins; a blank region changes nothing. Never mutates the input.
 */
export function withRunRegion(plan: WorkPlan, region: string | null | undefined): WorkPlan {
  const r = typeof region === "string" ? clean(region) : "";
  if (!r || (typeof plan.meta?.region === "string" && plan.meta.region.trim())) return plan;
  return { ...plan, meta: { ...(plan.meta ?? {}), region: r } };
}

/** Heading and hint for the lower-confidence finds: the same words as the plan screen. */
export const WATCH_HEADING = "Worth a closer look";
export const WATCH_HINT = "Lower confidence. Not in the ranked list or the work order; check these in person.";
/** Most lower-confidence finds listed in the shared text (the PDF lists them all). */
export const MAX_SHARE_WATCH = 5;

/**
 * "Why only one problem: Only the stage was filmed." The server's note on why the plan has few problems,
 * with the same lead-in as the plan screen. Null when there is no note.
 */
export function coverageLine(plan: WorkPlan): string | null {
  const note = coverageNote(plan);
  if (!note) return null;
  const n = rankedIssues(plan).length;
  return `Why ${n === 1 ? "only one problem" : n === 0 ? "no problems" : `only ${n} problems`}: ${clean(note)}`;
}

/** One lower-confidence find on one line: "Loose floor tile (side aisle, 40% sure)". */
export function watchLine(w: Pick<WatchItem, "title" | "area" | "confidence">): string {
  const extra = [w.area ? clean(w.area) : null, w.confidence !== undefined ? `${Math.round(w.confidence * 100)}% sure` : null].filter(Boolean).join(", ");
  return `${clean(w.title)}${extra ? ` (${extra})` : ""}`;
}

/** Heading for the said-vs-seen rows, the same words on the plan screen and in the PDF. */
export const SAID_VS_SEEN_HEADING = "What you said vs. what we saw";

/** One said-vs-seen row in plain words, as the plan screen shows it. */
export interface SaidVsSeenLine {
  /** "\u201CThe carpet is torn.\u201D (12 s)", or "Not mentioned". */
  said: string;
  /** What the video shows, or "Not visible in the video". */
  seen: string;
  /** Seen on video but never said: the screen and the PDF call these out. */
  unmentioned: boolean;
  /** Said but not seen: check it in person. */
  notSeen: boolean;
}

/**
 * The plan's said-vs-seen rows in the plan screen's words, for the screen and the PDF. Empty when the walk had
 * no narration (the screen hides the section then) or the plan has no rows.
 */
export function saidVsSeenLines(plan: Pick<WorkPlan, "saidVsSeen" | "transcript" | "transcriptTurns">): SaidVsSeenLine[] {
  const narrated = Boolean(plan.transcript?.trim()) || (plan.transcriptTurns?.length ?? 0) > 0;
  if (!narrated || !Array.isArray(plan.saidVsSeen)) return [];
  return plan.saidVsSeen.map((row) => {
    const quote = row.said && typeof row.said.quote === "string" ? clean(row.said.quote) : "";
    const at = row.said && Number.isFinite(row.said.atSec) ? ` (${row.said.atSec.toFixed(0)} s)` : "";
    const summary = row.seen && typeof row.seen.summary === "string" ? clean(row.seen.summary) : "";
    return {
      said: quote ? `\u201C${quote}\u201D${at}` : "Not mentioned",
      seen: summary || "Not visible in the video",
      unmentioned: row.status === "unmentioned",
      notSeen: row.status === "mentioned_not_seen" || !summary,
    };
  });
}

/** How each said-vs-seen row turned out, in the words the plan screen tags it with. */
export type SaidVsSeenKind = "matched" | "unmentioned" | "notSeen";

/** The tag a row gets: seen and never said, said but not on video, or both. */
export function saidVsSeenKind(row: Pick<SaidVsSeenEntry, "status" | "seen">): SaidVsSeenKind {
  if (row.status === "unmentioned") return "unmentioned";
  if (row.status === "mentioned_not_seen" || !row.seen || !String(row.seen.summary ?? "").trim()) return "notSeen";
  return "matched";
}

export const SAID_VS_SEEN_TAG: Record<SaidVsSeenKind, string> = {
  matched: "Matched",
  unmentioned: "You didn't mention",
  notSeen: "Check in person",
};

/**
 * One line above the said-vs-seen rows: "2 matched, 3 you didn't mention, 1 to check in person." Kinds with no
 * rows are left out; empty when there are no rows.
 */
export function saidVsSeenTally(rows: ReadonlyArray<Pick<SaidVsSeenEntry, "status" | "seen">> | null | undefined): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const n: Record<SaidVsSeenKind, number> = { matched: 0, unmentioned: 0, notSeen: 0 };
  for (const r of rows) n[saidVsSeenKind(r)] += 1;
  const parts = [
    n.matched > 0 ? `${n.matched} matched` : "",
    n.unmentioned > 0 ? `${n.unmentioned} you didn't mention` : "",
    n.notSeen > 0 ? `${n.notSeen} to check in person` : "",
  ].filter(Boolean);
  return `${parts.join(", ")}.`;
}

/** Most "said, not seen" quotes the shared text lists before it says how many more. */
const MAX_SHARE_NOT_SEEN = 3;

/**
 * The said-vs-seen section for the shared text, when the walk named things the video never showed: the same
 * tally the plan screen shows, then those quotes, so the team knows what to check in person. Empty without
 * narration, without rows, or when everything said was seen (the header line already counts what wasn't said).
 */
export function saidVsSeenShareLines(plan: Pick<WorkPlan, "saidVsSeen" | "transcript" | "transcriptTurns">): string[] {
  const rows = saidVsSeenLines(plan);
  if (rows.length === 0 || !Array.isArray(plan.saidVsSeen)) return [];
  const notSeen = plan.saidVsSeen
    .map((row, i) => ({ kind: saidVsSeenKind(row), said: rows[i].said }))
    .filter((r) => r.kind === "notSeen" && r.said !== "Not mentioned")
    .map((r) => r.said);
  if (notSeen.length === 0) return [];
  const lines = [`${SAID_VS_SEEN_HEADING}: ${saidVsSeenTally(plan.saidVsSeen)}`, "Said on the walk, not seen on video (check in person):"];
  for (const q of notSeen.slice(0, MAX_SHARE_NOT_SEEN)) lines.push(`- ${q}`);
  if (notSeen.length > MAX_SHARE_NOT_SEEN) lines.push(`- and ${notSeen.length - MAX_SHARE_NOT_SEEN} more`);
  return lines;
}

/** "3 problems, worst first" / "1 problem" / "No problems found". */
export function problemSummary(count: number): string {
  if (count === 0) return "No problems found";
  return count === 1 ? "1 problem" : `${count} problems, worst first`;
}

/**
 * The said-vs-seen headline for the top of the shared text and the PDF: how many of the ranked problems the
 * video caught that nobody said out loud. "3 of 6 never mentioned on the walk, caught on video."
 * Null without narration (nothing to compare against) or when every problem was mentioned.
 */
export function unmentionedHeadline(issues: readonly Pick<Issue, "unmentioned">[], narrated: boolean): string | null {
  if (!narrated) return null;
  const total = issues.length;
  const n = issues.filter((i) => i.unmentioned === true).length;
  if (n === 0 || total === 0) return null;
  if (total === 1) return "Never mentioned on the walk, caught on video.";
  if (n === total) return `All ${n} never mentioned on the walk, caught on video.`;
  return `${n} of ${total} never mentioned on the walk, caught on video.`;
}

/** "Not mentioned: Leaking valve · Peeling paint": the problems the walk never named, worst first. */
export function unmentionedTitlesLine(issues: readonly Pick<Issue, "unmentioned" | "title">[], narrated: boolean): string | null {
  if (!narrated) return null;
  const titles = issues.filter((i) => i.unmentioned === true).map((i) => clean(i.title)).filter(Boolean);
  return titles.length > 0 ? `Not mentioned: ${titles.join(" \u00B7 ")}` : null;
}

/**
 * One plain sentence about a problem: priority, then whether it was said and seen, then a missing-photo warning.
 * e.g. "Low priority. Spotted on video, not mentioned on the walk."
 */
export function issueNote(issue: Issue, narrated: boolean, verdict?: PlanReviewItem): string {
  const parts = [`${PRIORITY[issue.severity] ?? issue.severity}.`];
  if (!narrated) parts.push("Seen on camera.");
  else if (issue.unmentioned) parts.push("Spotted on video, not mentioned on the walk.");
  else if (issue.status === "mentioned_not_seen") parts.push("Mentioned on the walk, not seen on video. Check in person.");
  else parts.push("Mentioned on the walk and seen on video.");
  const kind = verdictKind(verdict);
  if (kind === "partly") {
    const scope = supportedScope(verdict);
    parts.push(scope ? `The photos back part of it: ${clean(scope).replace(/[.]$/, "")}. Check the rest in person.` : "The photos back part of it. Check the rest in person.");
  } else if (verdict?.verified === false && issue.status !== "mentioned_not_seen") parts.push("No photo backs it yet. Check in person.");
  return parts.join(" ");
}

const partly = (review: Parameters<typeof partlyCount>[0]) => {
  const n = partlyCount(review);
  return n > 0 ? `, ${n} partly backed` : "";
};

/** The reviewer pass in plain words, e.g. "Each problem was checked against a photo: 1 of 1 confirmed." */
export function plainReviewLine(plan: Pick<WorkPlan, "review" | "issues">): string | null {
  const review = planReview(plan);
  if (!review || plan.issues.length === 0) return null;
  if (!review.ran) return "The photo check didn't run, so check each problem in person before acting on it.";
  const t = reviewTally(review);
  if (!t) return null;
  return review.source === "precomputed"
    ? `Each problem was matched to its photo ahead of time: ${t.verified} of ${t.total} have one.`
    : `Each problem was checked against a photo: ${t.verified} of ${t.total} confirmed${partly(review)}.`;
}

export interface PlanTextOptions {
  maxChars?: number;
  sample?: boolean;
  /** Date shown in the header. Default: now. */
  date?: Date;
  /** The PDF goes with the text on the same share, so the last line points at it. */
  pdfAttached?: boolean;
  /** "Since the last walkthrough" lines (planCompare.compareShareLines), placed after the problems. */
  sinceLines?: readonly string[];
  /** Work steps already ticked off on this device; adds one progress line after the steps. */
  doneSteps?: readonly number[];
}

/** Priority word for the one-line problem form: "high", "medium", "low". */
const SHORT_PRIORITY: Record<string, string> = { high: "high", medium: "medium", low: "low" };

/**
 * The short form of issueNote for a long shared text, so a problem fits on its own line:
 * "high, not mentioned" / "medium, not seen on video, check in person" / "low".
 */
export function shortIssueNote(issue: Issue, narrated: boolean, verdict?: PlanReviewItem): string {
  const parts = [SHORT_PRIORITY[issue.severity] ?? issue.severity];
  if (narrated && issue.unmentioned) parts.push("not mentioned");
  else if (narrated && issue.status === "mentioned_not_seen") parts.push("not seen on video, check in person");
  const kind = verdictKind(verdict);
  if (kind === "partly") parts.push("photos back part of it");
  else if (verdict?.verified === false && issue.status !== "mentioned_not_seen") parts.push("no photo yet, check in person");
  return parts.join(", ");
}

/** Material quantities that say "go measure", grouped onto one line in a long shared text. */
const ON_SITE_QTY = /^(measure on site|as needed)$/i;

/** Longest "Asked for" summary in a long shared text before it is cut at a word with an ellipsis. */
export const SHORT_ASKED_FOR = 90;

function shortened(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.]+$/, "")}\u2026`;
}

/**
 * How much a long shared text gives up to fit, in order: the said-vs-saw block, the counts line, the walk-order
 * lines, then a compact pass (one line per problem, measure-on-site materials grouped, a shorter Asked for, the
 * closer-look list on one line, no Start here or photo-check line). Problems, steps, materials and cost all stay.
 */
interface ShareTrim {
  said: boolean;
  counts: boolean;
  walk: boolean;
  compact: boolean;
}

const TRIMS: ShareTrim[] = [
  { said: false, counts: false, walk: false, compact: false },
  { said: true, counts: false, walk: false, compact: false },
  { said: true, counts: true, walk: false, compact: false },
  { said: true, counts: true, walk: true, compact: false },
  { said: true, counts: true, walk: true, compact: true },
];

/**
 * The plan as plain text, for a group text or email to the people doing the work.
 * A short header (space, city and state, date, how many problems), then the same order as the plan screen:
 * problems worst first, the work steps, materials, then cost. Only sections with content appear, the cost
 * always carries its "not a quote" label, and nothing points at a link the teammate doesn't have.
 * Long plans give up extras and then go compact before anything is cut (see TRIMS).
 */
export function planToText(plan: WorkPlan, opts: PlanTextOptions = {}): string {
  const maxChars = opts.maxChars ?? MAX_SHARE_CHARS;
  let lines: string[] = [];
  for (const trim of TRIMS) {
    lines = planTextLines(plan, opts, trim);
    const text = lines.join("\n");
    if (text.length <= maxChars) return text;
  }
  // Keep the sign-off: cut the body at a line and say it was shortened.
  const signoff = opts.pdfAttached ? SHARE_SIGNOFF_PDF : SHARE_SIGNOFF;
  const tail = `\n...\n${opts.pdfAttached ? "Shortened for a text. The PDF has everything." : "Shortened for a text."}\n\n${signoff}`;
  const body = lines.slice(0, -2).join("\n");
  const cut = body.slice(0, Math.max(0, maxChars - tail.length));
  const atLine = cut.lastIndexOf("\n");
  return (atLine > 0 ? cut.slice(0, atLine) : cut) + tail;
}

function planTextLines(plan: WorkPlan, opts: PlanTextOptions, trim: ShareTrim): string[] {
  const lines: string[] = [];
  const narrated = Boolean(plan.transcript?.trim()) || (plan.transcriptTurns?.length ?? 0) > 0;
  const sample = opts.sample ?? plan.meta?.isExample === true;
  const location = planLocation(plan);
  // Ranked problems only, like the plan screen: lower-confidence finds get their own short list below.
  const issues = rankedIssues(plan).sort((a, b) => a.rank - b.rank);
  const watch = watchItems(plan);

  lines.push(`Work plan: ${clean(plan.spaceName) || "Walkthrough"}`);
  lines.push([location, shareDate(opts.date ?? new Date())].filter(Boolean).join(" \u00B7 "));
  const headline = unmentionedHeadline(issues, narrated);
  lines.push(headline ? `${problemSummary(issues.length)}. ${headline}` : `${problemSummary(issues.length)}.`);
  if (sample) lines.push("Example plan with sample data, not a real run.");
  if (narrated && plan.transcriptSummary) {
    const asked = clean(plan.transcriptSummary);
    lines.push(`Asked for: ${trim.compact ? shortened(asked, SHORT_ASKED_FOR) : asked}`);
  }

  const review = planReview(plan);
  if (issues.length > 0) {
    lines.push("");
    for (const [n, i] of issues.entries()) {
      if (trim.compact) lines.push(`${n + 1}. ${clean(i.title)} (${shortIssueNote(i, narrated, verdictFor(review, i))})`);
      else lines.push(`${n + 1}. ${clean(i.title)}`, `   ${issueNote(i, narrated, verdictFor(review, i))}`);
    }
    // Where along the walk each problem was seen, when the walk caught something nobody said.
    if (!trim.walk) lines.push(...walkTextLines(plan, issues, narrated));
    const line = trim.compact ? null : plainReviewLine(plan);
    if (line) lines.push(line);
  } else {
    lines.push("", "Nothing stood out in the frames checked. Walk it in person before you sign off.");
  }
  const why = coverageLine(plan);
  if (why) lines.push(why);
  const counts = countsShareLine(plan.inventory ?? [], masksAvailable(plan));
  if (counts && !trim.counts) lines.push("", counts);
  const said = trim.said ? [] : saidVsSeenShareLines(plan);
  if (said.length > 0) lines.push("", ...said);
  if (!sample && opts.sinceLines && opts.sinceLines.length > 0) lines.push("", ...opts.sinceLines);
  if (watch.length > 0) {
    if (trim.compact) {
      const shown = watch.slice(0, MAX_SHARE_WATCH).map((w) => clean(w.title));
      const more = watch.length > MAX_SHARE_WATCH ? ` and ${watch.length - MAX_SHARE_WATCH} more` : "";
      lines.push("", `${WATCH_HEADING} (check in person): ${shown.join(" \u00B7 ")}${more}`);
    } else {
      lines.push("", `${WATCH_HEADING} (lower confidence, check in person):`);
      for (const w of watch.slice(0, MAX_SHARE_WATCH)) lines.push(`- ${watchLine(w)}`);
      if (watch.length > MAX_SHARE_WATCH) lines.push(`- and ${watch.length - MAX_SHARE_WATCH} more`);
    }
  }

  const steps = [...plan.workOrder].sort((a, b) => a.order - b.order);
  if (steps.length > 0) {
    const startHere = trim.compact ? [] : fixFirstPlanLines(plan);
    if (startHere.length > 0) lines.push("", ...startHere);
    lines.push("", "Do the work in this order:");
    for (const s of steps) {
      const extra = [s.trade ? clean(s.trade) : null, s.hours ? `${span(s.hours)} h` : null].filter(Boolean).join(", ");
      lines.push(`${s.order}. ${clean(s.title)}${extra ? ` (${extra})` : ""}`);
    }
    // Same schedule as the Add to calendar file (weekdays 9 to 5 from the next workday).
    const schedule = calendarSummary(steps, opts.date ?? new Date());
    if (schedule) lines.push(`Schedule: ${schedule}`);
    const progress = sample ? null : shareProgressLine(steps, opts.doneSteps ?? []);
    if (progress) lines.push(progress);
    const fixedLine = sample ? null : shareFixedLine(issues, steps, opts.doneSteps ?? []);
    if (fixedLine) lines.push(fixedLine);
    // Where to pick up, so the teammate reading the text knows the next step without the plan screen.
    const next = sample ? null : nextUpShareLine(steps, opts.doneSteps ?? []);
    if (next) lines.push(next);
  } else if (!sample && issues.length > 0) {
    // Same honest line as the plan screen: the problems are real, the step-by-step order just wasn't laid out.
    lines.push("", noStepsLine(issues.length));
  }

  if (plan.materials.length > 0) {
    lines.push("", "Materials:");
    // In the compact pass, "Measure on site" and "As needed" are said once, with their items on one line.
    const byQty = new Map<string, string[]>();
    for (const m of plan.materials) {
      const q = clean(m.qty);
      if (trim.compact && ON_SITE_QTY.test(q)) {
        const key = q.charAt(0).toUpperCase() + q.slice(1).toLowerCase();
        byQty.set(key, [...(byQty.get(key) ?? []), clean(m.item)]);
      } else lines.push(`- ${clean(m.item)}: ${q}`);
    }
    for (const [q, items] of byQty) lines.push(`- ${q}: ${items.join(" \u00B7 ")}`);
  }

  if (plan.costRange) {
    const c = plan.costRange;
    lines.push("", `Cost: ${usd(c.low)}-${usd(c.high)} for ${clean(c.region)}. ${c.label ?? COST_LABEL}.`);
    const live = livePricesLine(c);
    if (live) lines.push(live);
  } else {
    const noStepsCost = sample ? null : noStepsCostLine(steps.length, plan.materials.length);
    if (noStepsCost) lines.push("", noStepsCost);
  }

  const runCost = runCostLine(plan, { sample });
  if (runCost) lines.push("", runCost);

  lines.push("", opts.pdfAttached ? SHARE_SIGNOFF_PDF : SHARE_SIGNOFF);
  return lines;
}

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

/** Minimal slices of `navigator` used here, so tests can pass stubs. */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText: (text: string) => Promise<void> };
}

interface ShareData {
  title?: string;
  text?: string;
  files?: File[];
}

/** A file to send along when the share sheet takes files, and the text to use with it (it points at the file). */
export interface ShareAttachment {
  files: File[];
  text: string;
}

/** True when this browser's share sheet takes these files (iOS and Android Safari/Chrome do; most desktops don't). */
export function canShareFiles(nav: ShareNavigator, files: File[]): boolean {
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * Native share sheet when the device has one (phones), else the clipboard. With `attach`, the share carries the
 * file too (and its text) when the sheet takes files; otherwise the plain text goes alone.
 * A dismissed share sheet is "cancelled", not an error, and never falls through to the clipboard.
 */
export async function sharePlanText(
  title: string,
  text: string,
  nav: ShareNavigator,
  preferShare: boolean,
  attach?: ShareAttachment | null,
): Promise<ShareResult> {
  const tries: ShareData[] = [];
  if (preferShare && typeof nav.share === "function") {
    if (attach && canShareFiles(nav, attach.files)) tries.push({ title, text: attach.text, files: attach.files });
    const data = { title, text };
    if (!nav.canShare || nav.canShare(data)) tries.push(data);
  }
  for (const data of tries) {
    try {
      await nav.share!(data);
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // Refused (no fresh tap, or the target can't take a file): try the next, then the clipboard.
    }
  }
  if (nav.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return "copied";
    } catch {
      return "failed";
    }
  }
  return "failed";
}
