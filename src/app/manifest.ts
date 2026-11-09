import type { MetadataRoute } from "next";

// Lets a phone add SightWork to its home screen with its own name and icon. It opens straight to the
// recorder (/start), without browser bars, in the same dark top bar the site uses. A long press on the
// icon (where the phone supports app shortcuts) jumps straight to a new walkthrough, the last plan saved
// on this device, or the example plan.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SightWork",
    short_name: "SightWork",
    description: "Film a walkthrough. Get a work plan.",
    id: "/start",
    start_url: "/start",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f5f0",
    theme_color: "#14171c",
    categories: ["productivity", "business", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
    shortcuts: [
      { name: "Film a walkthrough", short_name: "Film", description: "Open the recorder for a new walkthrough.", url: "/start" },
      { name: "Open my last plan", short_name: "Last plan", description: "Reopen the last plan saved on this phone.", url: "/start?view=last" },
      { name: "See an example plan", short_name: "Example", description: "Open a finished example plan.", url: "/start?view=example" },
    ],
  };
}
