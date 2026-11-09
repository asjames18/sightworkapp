import { canShareFiles, type ShareNavigator } from "./planText";

export type SaveVideoResult = "shared" | "cancelled" | "downloaded" | "needs-tap" | "failed";

export interface SaveVideoEnv {
  nav: ShareNavigator;
  /** A phone (touch screen): try the share sheet first. */
  preferShare: boolean;
  download: (blob: Blob, name: string) => boolean;
  /** Second tap after "needs-tap": the share is tried again, and if refused again it downloads. */
  retry?: boolean;
}

/**
 * "Save video": a web page can't put a file in the Photos app by itself, so on a phone whose share sheet
 * takes the video it opens the sheet (iPhone lists "Save Video" there). Otherwise it downloads the file
 * (Android saves it to Downloads, a computer to its downloads folder). A dismissed sheet is "cancelled",
 * never a download. Must run inside the tap.
 */
export async function saveVideoFile(file: File, env: SaveVideoEnv): Promise<SaveVideoResult> {
  if (env.preferShare && canShareFiles(env.nav, [file])) {
    try {
      await env.nav.share!({ files: [file], title: file.name });
      return "shared";
    } catch (e) {
      const name = e instanceof Error ? e.name : (e as { name?: string } | null)?.name ?? "";
      if (name === "AbortError") return "cancelled";
      if (name === "NotAllowedError" && !env.retry) return "needs-tap";
    }
  }
  try {
    return env.download(file, file.name) ? "downloaded" : "failed";
  } catch {
    return "failed";
  }
}

/** What to say after a tap on Save video. Empty when nothing needs saying (a dismissed sheet). */
export function saveVideoMessage(result: SaveVideoResult): string {
  switch (result) {
    case "shared":
      return "Done.";
    case "downloaded":
      return "Downloaded. Look in your Downloads folder.";
    case "needs-tap":
      return "Tap Save video once more to finish.";
    case "failed":
      return "Couldn't save the video from this browser.";
    default:
      return "";
  }
}

/** The line under a take recorded here: kept on the phone or not, and what the button does. */
export function keptTakeNote(kept: boolean, phone: boolean): string {
  if (kept) return phone ? "Saved on this phone. Tap Save video to keep it in Photos." : "Saved in this browser. Tap Save video to download it.";
  return phone ? "Tap Save video to keep a copy in Photos." : "Tap Save video to download a copy.";
}

/**
 * The line on a stopped run's card for a take recorded in SightWork's camera. The video is never
 * uploaded, so a failed run doesn't lose it; this says so and points at Save video. Null for a video
 * picked from the phone's library or files (it's already there).
 */
export function failedTakeNote(kept: boolean, phone: boolean): string | null {
  if (!kept) return null;
  return phone
    ? "Your video is still saved on this phone. Tap Save video to keep it in Photos, then try again."
    : "Your video is still saved in this browser. Tap Save video to download it, then try again.";
}
