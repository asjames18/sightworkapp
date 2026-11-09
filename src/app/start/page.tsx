import type { Metadata } from "next";
import { SightWorkFlow } from "@/components/SightWorkFlow";

export const metadata: Metadata = {
  title: "Make a work plan | SightWork",
  description: "Upload a walkthrough video (30 seconds for a small room up to 5 minutes for a warehouse) and get a work plan: problems worst first with proof frames, counts, steps in order and materials.",
};

// `?view=last` (the last plan saved on this device) can only be read in the browser, so the page would first
// paint the upload screen and then swap to the plan (a visible flash and a layout shift). This runs before the
// app is parsed: it hides the app until the plan is on screen (SightWorkFlow removes the class), and never for
// more than 2.5 s, so a script error can't leave the page blank. (`?view=example` is prerendered instead, see
// next.config.ts.) If the script ever sees view=example here (rewrite not applied), it hides the swap too.
const HIDE_UNTIL_PLAN = `(function(){try{var v=new URLSearchParams(location.search).get("view");if(v==="example"||v==="last"){var d=document.documentElement;d.classList.add("sw-opening");setTimeout(function(){d.classList.remove("sw-opening")},2500)}}catch(e){}})();`;

/** The app: upload, processing and plan stay stages inside SightWorkFlow. */
export default function Start() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: HIDE_UNTIL_PLAN }} />
      <SightWorkFlow />
    </>
  );
}
