/** Home-screen manifest (app/manifest.ts). Plain object checks, no browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import manifest from "@/app/manifest";

const m = manifest();

test("opens straight to the recorder as its own app", () => {
  assert.equal(m.start_url, "/start");
  assert.equal(m.display, "standalone");
  assert.equal(m.name, "SightWork");
  assert.ok(m.short_name && m.short_name.length <= 12, "short name fits under a home-screen icon");
});

test("colors match the site", () => {
  assert.equal(m.theme_color, "#14171c");
  assert.equal(m.background_color, "#f7f5f0");
});

test("lists a scalable icon and a 180 px PNG", () => {
  const icons = m.icons ?? [];
  assert.ok(icons.some((i) => i.src === "/icon.svg" && i.sizes === "any"));
  assert.ok(icons.some((i) => i.src === "/apple-icon" && i.sizes === "180x180" && i.type === "image/png"));
});

test("start page sits inside the scope", () => {
  assert.ok(m.scope && m.start_url && m.start_url.startsWith(m.scope));
});

test("long-press shortcuts open the recorder, the last plan and the example, all inside the scope", () => {
  const shortcuts = m.shortcuts ?? [];
  assert.deepEqual(
    shortcuts.map((x) => x.url),
    ["/start", "/start?view=last", "/start?view=example"],
  );
  for (const x of shortcuts) {
    assert.ok(x.name.length > 0 && x.name.length <= 30, "shortcut name fits a menu row");
    assert.ok(x.short_name && x.short_name.length <= 12, "short name fits a small menu");
    assert.ok(m.scope && x.url.startsWith(m.scope), "shortcut stays inside the app scope");
  }
});
