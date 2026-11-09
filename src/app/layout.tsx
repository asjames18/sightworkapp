import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font: no runtime request to Google, same look on every device.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "SightWork",
  description: "Film a walkthrough. Get a work plan.",
  applicationName: "SightWork",
  // Added to a phone's home screen: keep the short name and the dark status bar.
  appleWebApp: { capable: true, title: "SightWork", statusBarStyle: "black" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#14171c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: /start may add a "sw-opening" class to <html> before React loads (see app/start/page.tsx).
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">
        {/* First stop for the Tab key: lets keyboard and screen reader users jump past the header to the page. */}
        <a
          href="#main-content"
          data-testid="skip-link"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent print:hidden"
        >
          Skip to main content
        </a>
        {/* Shown only when scripts are off: the film, plan and save steps all run in the browser. */}
        <noscript>
          <div
            role="alert"
            data-testid="noscript-note"
            className="mx-auto my-4 max-w-xl rounded-2xl border border-ink/30 bg-white px-4 py-3 text-sm leading-6 text-ink print:hidden"
          >
            <p className="font-semibold">SightWork needs JavaScript.</p>
            <p>
              Filming, picking frames and building the plan all happen in your browser. Turn JavaScript on for this
              site, or open it in a current Chrome, Safari, Edge or Firefox, then reload the page.
            </p>
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
