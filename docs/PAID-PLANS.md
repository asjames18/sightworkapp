# Paid plans: setup and test checklist

Paid plans are off by default. Using SightWork with your own Meta key stays free and never touches any of this. This page is for anyone running their own copy who wants to take payments through Stripe.

Everything below uses free tiers only. Stripe charges its normal per-payment fee only when a real payment happens, and test mode costs nothing.

## Settings

Copy the lines from `.env.example` into your host's environment (never into the repo):

| Setting | What it is |
| --- | --- |
| `SIGHTWORK_BILLING` | Set to `on` to turn on checkout, the pricing page and paid access codes. With it on, server plan runs (`/api/plan`, `/api/transcribe`) need a paid access code; the tester code no longer opens them. Own-key runs are unaffected. |
| `SIGHTWORK_ACCESS_SECRET` | 32 or more random characters. Signs access codes. Changing it invalidates every code. |
| `STRIPE_SECRET_KEY` | Stripe key for the mode you run (use a `sk_test_` key everywhere except production). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) of the webhook endpoint. |
| `SIGHTWORK_PRICE_*` | One Stripe price id per plan, from the same Stripe mode as the key. |
| `BREVO_API_KEY` (or `RESEND_API_KEY`), `SIGHTWORK_MAIL_FROM` | Optional. Needed only for "find my purchase" emails; without them that form answers 503. Brevo is used when its key is set. `SIGHTWORK_MAIL_FROM` looks like `SightWork <no-reply@example.com>` on a domain verified with the mail service. |

## Test in Stripe test mode

1. Create the products and prices in Stripe test mode and put the ids in the `SIGHTWORK_PRICE_*` settings.
2. Set the settings above on a preview deployment only, with `SIGHTWORK_BILLING=on`.
3. Add a webhook endpoint pointing at `/api/billing/webhook` on that deployment and copy its signing secret.
4. Open `/pricing`, choose a plan and pay with the Stripe test card `4242 4242 4242 4242` (any future date, any CVC).
5. You should land on `/billing/done` with an access code. Packs give a customer code; subscriptions give a subscription code.
6. On `/pricing`, paste a subscription code into "Manage subscription". It should open the Stripe billing portal.
7. Use "Find my purchase" with the checkout email. The answer is the same whether or not a purchase exists; if mail is set up, the code arrives by email.
8. Check Stripe's webhook log shows 2xx for each event.

Only after all of that passes, repeat with live keys and live price ids in production. A real charge should be a deliberate step by the owner.

## What is stored

Nothing about buyers is stored by SightWork. Stripe is the record. An access code is a signed token that names a Stripe customer or subscription, and it is checked against Stripe when used.
