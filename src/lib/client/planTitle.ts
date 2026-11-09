/**
 * Browser tab title for an open plan. A finished or reopened plan names its space in the tab, the
 * history list and a bookmark ("Sanctuary stage plan | SightWork"), so two plans open in two tabs can be
 * told apart. Example plans keep the title their own page sets.
 */

const MAX_NAME = 48;

/** Tab title for a plan of this space; the plain app title when there is no usable name. */
export function planPageTitle(spaceName: string | null | undefined): string {
  const name = typeof spaceName === "string" ? spaceName.replace(/\s+/g, " ").trim() : "";
  if (!name) return "Your plan | SightWork";
  let short = name;
  if (short.length > MAX_NAME) {
    const cut = short.slice(0, MAX_NAME);
    const space = cut.lastIndexOf(" ");
    short = `${(space > MAX_NAME / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
  }
  // "Sanctuary stage plan", but not "Sanctuary plan plan".
  const label = /\bplan$/i.test(short) ? short : `${short} plan`;
  return `${label} | SightWork`;
}

type TitleDocument = Pick<Document, "title"> & { head?: Node | null };

/**
 * Sets the plan title and returns a cleanup that puts the earlier title back, unless something else
 * (the plan-ready cue, another screen) changed the title meanwhile. A plan reopened right at page load
 * can open before the page's own <title> settles, and that later update would put the page title back;
 * while the plan is open, a title reset to exactly that earlier title is turned back into the plan title.
 */
export function showPlanTitle(
  spaceName: string | null | undefined,
  doc: TitleDocument | undefined = typeof document === "undefined" ? undefined : document,
  Observer: typeof MutationObserver | undefined = typeof MutationObserver === "undefined" ? undefined : MutationObserver,
): () => void {
  if (!doc) return () => {};
  const before = doc.title;
  const title = planPageTitle(spaceName);
  doc.title = title;
  let observer: MutationObserver | null = null;
  if (Observer && doc.head && before !== title) {
    observer = new Observer(() => {
      if (doc.title === before) doc.title = title;
    });
    observer.observe(doc.head, { subtree: true, childList: true, characterData: true });
  }
  return () => {
    observer?.disconnect();
    observer = null;
    if (doc.title === title) doc.title = before;
  };
}
