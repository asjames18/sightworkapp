/** The public address printed on shared texts and the PDF footer comes from one place. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNOFF_LINE, SITE_HOST, SITE_URL } from "@/lib/client/siteUrl";
import { VOLUNTEER_SIGNOFF } from "@/lib/client/volunteerCall";
import { QUOTE_SIGNOFF } from "@/lib/client/quoteRequest";

test("the site url is the host behind https", () => {
  assert.equal(SITE_URL, `https://${SITE_HOST}`);
  assert.equal(SITE_HOST, "sightwork.melanatedintech.com");
});

test("the volunteer call and quote request end with the same full link line", () => {
  assert.equal(SIGNOFF_LINE, "Made with SightWork \u00B7 https://sightwork.melanatedintech.com");
  assert.equal(VOLUNTEER_SIGNOFF, SIGNOFF_LINE);
  assert.equal(QUOTE_SIGNOFF, SIGNOFF_LINE);
});
