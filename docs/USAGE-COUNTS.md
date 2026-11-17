# Usage counts

SightWork keeps a small set of anonymous daily totals so the owner can see how the app is used.
Counting is off unless the server is given somewhere to keep the totals (see Setup).

## What is counted

Each count is one number for a day (Eastern time), a site (the live site or a test build), an event, one
short detail from a fixed list, and a device class.

| Event | Detail | Counted where |
| --- | --- | --- |
| `view` | The page opened: `/`, `/start`, `/start/example`, `/pricing`, `/settings`, `/help/own-key`, `/credits`, `/billing/done`, `/status`, or `other` | Browser |
| `plan_started`, `plan_done`, `plan_failed` | How the plan ran: `byok` (the visitor's own Meta API key) or `code` (an access code on SightWork's server). Example plans aren't counted. | Browser |
| `checkout_started` | The plan picked (for example `single` or `pack5`) | Server, after Stripe Checkout opens |
| `checkout_done` | None | Server, on Stripe's signed "checkout completed" event |
| `recover_used` | None | Server, when "Lost your access code?" is used |

Device class is `phone`, `tablet` or `desktop`, worked out from the window width alone. Server counts have none.

## What is never kept

- No names, emails, IP addresses, access codes, API keys, videos, narration, frames or plan text.
- No cookies, local storage ids, session ids or anything else that could link one count to another.
- No fingerprinting: the only thing read from the device is the window width's rough class.
- No third-party scripts, and nothing is shared with other sites.
- Query strings and any page not on the list above are never stored (unlisted pages count as `other`).
- Browsers that send Global Privacy Control or Do Not Track, and automated browsers, send nothing.
  Crawlers and link previews are ignored on the server.

Rows older than 400 days are deleted by the database.

## How it works

- The browser sends `{ e, d, v }` (event, detail, device class) to `POST /api/usage` with `navigator.sendBeacon`.
  The server checks that the request came from this site, checks the event and detail against the fixed
  lists, and adds 1 to that day's counter. It always answers 204 with no body.
- Checkout, finished checkout and code recovery are counted by the server routes themselves.
- The totals live in a Postgres table reached through two database functions: one adds 1 to a counter,
  the other reads the totals back only for the holder of the view key. The table itself can't be read or
  written with the public key.

## Viewing the numbers

Open `/admin/usage` and enter the view key. The key is sent once in the request body; it never goes in
the address bar or a cookie. The page shows page views by page and device, plan runs by how they ran,
checkouts opened and finished, code recoveries, and a by-day table. It is hidden (404) unless counting
and the view key are both set up.

## Setup

| Variable | What it is |
| --- | --- |
| `SIGHTWORK_USAGE_URL` | The database's https address. |
| `SIGHTWORK_USAGE_KEY` | The database's public (publishable) key. It can only call the two functions. |
| `SIGHTWORK_USAGE_VIEW_TOKEN` | A long random key for `/admin/usage`. The database stores only its SHA-256 hash. |

With `SIGHTWORK_USAGE_URL` and `SIGHTWORK_USAGE_KEY` unset, nothing is counted and the browser sends nothing.
