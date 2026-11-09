import { ImageResponse } from "next/og";
import { samplePlan } from "@/lib/mock/samplePlan";

// Social card for the landing link, drawn from the featured sample plan (hand-written, on CC0 photos; labeled as a sample).
export const alt = "SiteWork App: film a walkthrough, get a work plan. Sample plan card.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#14171c";
const PAPER = "#f7f5f0";
const ACCENT = "#e8590c";
const ACCENT_DARK = "#c2410c";
const MUTED = "#5b616b";

export default function OpengraphImage() {
  const issues = samplePlan.issues.slice(0, 3);
  const counts = samplePlan.inventory.slice(0, 3);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER, color: INK, padding: 64, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 520, paddingRight: 44 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="56" height="56" viewBox="0 0 32 32">
              <rect width="32" height="32" rx="7" fill={INK} />
              <path d="M5 16c3-5.5 6.8-8 11-8s8 2.5 11 8c-3 5.5-6.8 8-11 8s-8-2.5-11-8z" fill="none" stroke={PAPER} strokeWidth="2.2" strokeLinejoin="round" />
              <circle cx="16" cy="16" r="4.2" fill={ACCENT} />
            </svg>
            <div style={{ fontSize: 36, fontWeight: 700 }}>SiteWork</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 54, fontWeight: 800, lineHeight: 1.1, letterSpacing: -1 }}>Film a walkthrough.</div>
            <div style={{ fontSize: 54, fontWeight: 800, lineHeight: 1.1, letterSpacing: -1, color: ACCENT_DARK }}>Get a work plan.</div>
            <div style={{ fontSize: 24, color: MUTED, marginTop: 22, lineHeight: 1.35 }}>
              Counts, ranked problems with proof, and ordered work steps from one phone video.
            </div>
          </div>
          <div style={{ fontSize: 20, color: MUTED }}>Open source. Film a walkthrough. Get a work plan.</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, background: "#ffffff", borderRadius: 28, padding: 36, border: "1px solid #e4e1da" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 26, fontWeight: 700 }}>Sample plan</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#ffffff", background: INK, borderRadius: 999, padding: "6px 14px" }}>SAMPLE</div>
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 24 }}>
            {counts.map((c) => (
              <div key={c.label} style={{ display: "flex", flexDirection: "column", flex: 1, background: PAPER, borderRadius: 16, padding: "14px 16px" }}>
                <div style={{ fontSize: 44, fontWeight: 800, color: ACCENT }}>{String(c.count)}</div>
                <div style={{ fontSize: 18, color: MUTED }}>{c.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 26 }}>
            {issues.map((i) => (
              <div key={i.rank} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 999, background: i.severity === "high" ? ACCENT_DARK : INK, color: "#ffffff", fontSize: 20, fontWeight: 700 }}>
                  {String(i.rank)}
                </div>
                <div style={{ fontSize: 22, flex: 1, lineHeight: 1.25 }}>{i.title}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 19, color: MUTED, marginTop: "auto" }}>Plus proof frames, materials and ordered work steps.</div>
        </div>
      </div>
    ),
    size,
  );
}
