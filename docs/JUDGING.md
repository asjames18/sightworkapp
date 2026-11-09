> Historical note (Nov 9, 2026): written for the Meta AI Developer Hackathon judging criteria. SightWork is now an open-source product; this doc is kept for history.

# How SightWork maps to the judging criteria

Criteria and weights from the Official Rules embedded on the [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon): **Impact 30%** (real-world potential and fit), **Demo 25%** (works, holds up live, quality of the demo video), **Use of Meta AI tooling 25%** (creative, beyond a basic integration), **Technical depth 20%**. SightWork is on the **Startup track**, "judged on technical execution and whether it holds up in production", under the theme **Build for Your World**.

## Impact (30%)
- Who it helps: churches, schools and nonprofits that run on volunteers and have no facilities staff, plus small contractors scoping a job.
- What changes: a one-minute phone walkthrough becomes a volunteer-ready plan in about 2 to 3.5 minutes, for about $1 in model calls on real runs ($0.94 to $1.10 with live price lookup): problems worst first with proof frames, who does each step, a shopping list, and a rough local cost.
- It travels: Send to your team (share sheet or clipboard), Save PDF, ticks saved per plan for work day.
- Built for the whole crew: Read it to me (the device's own voice, with a speed choice), Text size (Normal, Large, Extra large), a Contrast button, Windows High Contrast support, a Skip to main content link and axe checks at phone and desktop widths.
- Built for work day, not just the demo: tick steps off, "If people share it evenly" turns total hours into hours each for 1 to 12 people, and Add to calendar downloads the steps as a calendar file.
- Safe and affordable for volunteers: a Permit may apply chip, a Shut off first chip (power, water or gas) and a Check for lead or asbestos chip a Working up high chip, a Ventilate while working chip, an Eyes and dust mask chip, a Needs time to dry chip and a Needs dry weather chip appear on the steps that need them, as reminders and not test results, and one closed Before anyone starts box lists them all with links to their steps; a budget box shows how many steps, in work order, a typed amount covers; Ask for a quote, Ask for volunteers and Ask a store to donate send a plain request by the share sheet.

## Demo (25%)
- Live site with a real run on the landing page (a church sanctuary stage, nothing edited but a covered logo) and four labeled samples.
- Processing screen names the Meta model behind each step with a running clock.
- `/status` shows the live build and config at a glance, with no model calls.
- Holds up live: a real run keeps the phone screen on, says so when the connection drops, asks before a reload or swipe back can throw the run away, and has a Stop this run button; a page that fails shows a plain message with Try again instead of a bare error. A run cut by the 5-minute host limit says so, and Try again, lighter retries the same video with fewer, smaller frames.

## Use of Meta AI tooling (25%)
- Four Meta models chained in one agent run, one job each: Muse Voice Transcribe, SAM 3.1, Muse Spark Open (Meta open weights on Baseten, the default plan engine) and Muse Image; Muse Spark with web search prices the work.
- The same open-weights model runs a separate review-only pass that checks every problem against its photo.
- Every plan ends with a Powered by Meta AI panel that says which model did each step and whether it ran.

## Technical depth (20%)
- Device-side frame selection (sharpest neighbour per tick), narration extraction and leveling, request-size budgeting.
- Schema-validated model outputs, per-step checks streamed to the screen, spend cap in code, retries and graceful skips.
- Offline eval harness (`npm run eval`) with a baseline held in `npm test`; Playwright e2e with axe at phone and desktop widths. See [ARCHITECTURE.md](ARCHITECTURE.md).
