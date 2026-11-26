/** The public reviews page as a visitor and as the owner who turns it on and
 *  edits its markdown. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type App,
  createApp,
  inProcess,
  type Page,
} from "#test/blackbox/driver.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { disablePublicSite, enablePublicSite } from "#test-utils/settings.ts";

const enableReviews = async (enabled: boolean): Promise<void> => {
  const app = createApp(inProcess);
  await app.logIn();
  const page = await app.submit("/admin/features/reviews", {
    enabled: String(enabled),
  });
  expect(page.status).toBe(302);
};

const reviewSource = (name: string): string => `---
reviews:
  - name: ${JSON.stringify(name)}
    rating: 5
    date: "2026-11-24"
    text: "A new review."
---

New introduction.
`;

const follow = async (app: App, page: Page): Promise<Page> => {
  expect(page.status).toBe(302);
  if (page.location === null) throw new Error("The save named no address.");
  return app.get(page.location);
};

const editor = async (): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  return app;
};

describeWithEnv("the reviews page", { db: true }, () => {
  test("is not found until the owner turns Reviews on", async () => {
    await enablePublicSite();
    try {
      const page = await createApp(inProcess).get("/reviews");
      expect(page.status).toBe(404);
    } finally {
      await disablePublicSite();
    }
  });

  test("shows the sample review and the nav link once Reviews is on", async () => {
    await enablePublicSite();
    try {
      await enableReviews(true);
      const app = createApp(inProcess);
      const page = await app.get("/reviews");

      expect(page.status).toBe(200);
      expectIncludesAll(page.html, [
        '<ul class="reviews-grid">',
        "Sample customer",
        "This is a sample review.",
        "Read what our customers say.",
        "Rated 5 out of 5 stars",
        'href="/reviews"',
      ]);

      await enableReviews(false);
      expect((await app.get("/reviews")).status).toBe(404);
      expect((await app.get("/")).html).not.toContain('href="/reviews"');
    } finally {
      await disablePublicSite();
    }
  });

  test("shows the owner the sample file before the feature is on", async () => {
    const app = await editor();
    const page = await app.get("/admin/site/reviews");

    expect(page.status).toBe(200);
    expectIncludesAll(page.html, [
      "Reviews file",
      "Sample customer",
      "Turn on the Reviews feature",
    ]);
    expect(page.html).not.toContain('<a href="/reviews">');
  });

  test("lets the owner add a review and refuses a broken file", async () => {
    await enablePublicSite();
    try {
      await enableReviews(true);
      const app = await editor();
      const page = await app.get("/admin/site/reviews");
      expect(page.html).toContain('<a href="/reviews">');

      const saved = await app.submit("/admin/site/reviews", {
        reviewsMarkdown: reviewSource("A new reviewer"),
      });
      const afterSave = await follow(app, saved);
      expect(afterSave.html).toContain("Reviews updated.");
      expectIncludesAll((await app.get("/reviews")).html, [
        "A new reviewer",
        "A new review.",
        "New introduction.",
      ]);

      const refused = await follow(
        app,
        await app.submit("/admin/site/reviews", {
          reviewsMarkdown: "No frontmatter here.",
        }),
      );
      expect(refused.html).toContain("no frontmatter block");
      expect((await app.get("/reviews")).html).toContain("A new reviewer");
    } finally {
      await disablePublicSite();
    }
  });

  test("hides the editor from a signed-out visitor", async () => {
    const page = await createApp(inProcess).get("/admin/site/reviews");

    expect(page.status).toBe(302);
    expect(page.location).toBe("/admin?return_url=%2Fadmin%2Fsite%2Freviews");
  });
});
