/** The public reviews page and the admin review records. */

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
import {
  disablePublicSite,
  enablePublicSite,
  setReviewsPageEnabled,
} from "#test-utils/settings.ts";
import { loggedIn } from "./settings.ts";

const fields = (name: string, url: string, text = "A new review.") => ({
  date: "2026-11-24",
  name,
  rating: "5",
  text,
  url,
});

const follow = async (app: App, page: Page): Promise<Page> => {
  expect(page.status).toBe(302);
  if (page.location === null) throw new Error("The save named no address.");
  return app.get(page.location);
};

const addReview = async (app: App, name: string, url: string): Promise<Page> =>
  follow(
    app,
    await app.submit(
      "/admin/site/reviews/new",
      fields(name, url),
      "/admin/site/reviews",
    ),
  );

const enableReviews = async (): Promise<void> => {
  await enablePublicSite();
  await setReviewsPageEnabled(true);
};

const cleanUp = async (): Promise<void> => {
  await setReviewsPageEnabled(false);
  await disablePublicSite();
};

const withReviews = async (
  body: (app: App) => Promise<void>,
): Promise<void> => {
  await enableReviews();
  try {
    await body(await loggedIn());
  } finally {
    await cleanUp();
  }
};

const deleteReview = async (app: App, name: string): Promise<Page> =>
  follow(
    app,
    await app.submit("/admin/site/reviews/1/delete", {
      confirmIdentifier: name,
    }),
  );

describeWithEnv("the reviews page", { db: true }, () => {
  test("starts with no reviews", () =>
    withReviews(async (app) => {
      const list = await app.get("/admin/site/reviews");
      expectIncludesAll(list.html, ["No reviews yet."]);
      expect((await app.get("/reviews")).status).toBe(404);
    }));

  test("saves the page intro and switch", async () => {
    await enablePublicSite();
    try {
      const app = await loggedIn();
      const list = await app.get("/admin/site/reviews");
      expectIncludesAll(list.html, [
        "Reviews page",
        "Enable reviews page",
        "Reviews page intro",
        'action="/admin/site/reviews/intro"',
      ]);

      const created = await addReview(
        app,
        "An intro reviewer",
        "https://example.com/reviews/intro",
      );
      expect(created.html).toContain("Review created");
      expect((await app.get("/reviews")).status).toBe(404);

      const intro = await app.submit(
        "/admin/site/reviews",
        { reviewsIntroText: "Read **our reviews**." },
        "/admin/site/reviews/intro",
      );
      expect(intro.status).toBe(302);

      const enabled = await app.submit(
        "/admin/site/reviews",
        { reviewsEnabled: "true" },
        "/admin/site/reviews/toggle",
      );
      expect(enabled.status).toBe(302);
      expectIncludesAll((await app.get("/reviews")).html, [
        "Read <strong>our reviews</strong>.",
        "An intro reviewer",
      ]);
    } finally {
      await setReviewsPageEnabled(false);
      await disablePublicSite();
    }
  });

  test("shows a saved review on the public page", () =>
    withReviews(async (app) => {
      await addReview(
        app,
        "Sample customer",
        "https://example.com/reviews/sample",
      );
      const page = await createApp(inProcess).get("/reviews");

      expect(page.status).toBe(200);
      expectIncludesAll(page.html, [
        '<ul class="reviews-grid">',
        "Sample customer",
        "A new review.",
        "Rated 5 out of 5 stars",
        'href="/reviews"',
      ]);
    }));

  test("lets the owner add, edit, and delete a review", () =>
    withReviews(async (app) => {
      const list = await app.get("/admin/site/reviews");
      expect(list.status).toBe(200);
      expectIncludesAll(list.html, ["Add review"]);

      const created = await addReview(
        app,
        "A new reviewer",
        "https://example.com/reviews/new",
      );
      expect(created.html).toContain("Review created");
      expectIncludesAll((await app.get("/admin/site/reviews/new")).html, [
        "Review details",
        "Public link",
      ]);
      const publicPage = await app.get("/reviews");
      expectIncludesAll(publicPage.html, ["A new reviewer", "A new review."]);

      const edited = await follow(
        app,
        await app.submit(
          "/admin/site/reviews/1/edit",
          fields("An edited reviewer", "https://example.com/reviews/new"),
        ),
      );
      expect(edited.html).toContain("Review updated");
      expect((await app.get("/reviews")).html).toContain("An edited reviewer");
      expect((await app.get("/reviews")).html).not.toContain("A new reviewer");

      const removed = await deleteReview(app, "An edited reviewer");
      expect(removed.html).toContain("Review deleted");
      expect((await app.get("/reviews")).html).not.toContain(
        "An edited reviewer",
      );
    }));

  test("refuses a review URL another review already has", () =>
    withReviews(async (app) => {
      await addReview(
        app,
        "First reviewer",
        "https://example.com/reviews/same",
      );
      const refused = await follow(
        app,
        await app.submit(
          "/admin/site/reviews/new",
          fields("A second reviewer", "https://example.com/reviews/same"),
          "/admin/site/reviews",
        ),
      );
      expect(refused.html).toContain(
        "That review URL is already used by another review.",
      );
      expect((await app.get("/reviews")).html).not.toContain(
        "A second reviewer",
      );
    }));

  test("refuses a review URL that is not a web address", () =>
    withReviews(async (app) => {
      const refused = await follow(
        app,
        await app.submit(
          "/admin/site/reviews/new",
          fields("A reviewer", "ftp://example.com/review"),
          "/admin/site/reviews",
        ),
      );
      expect(refused.html).toContain(
        "Enter a full review URL that starts with http:// or https://.",
      );
    }));

  test("refuses an edit that takes another review's URL", () =>
    withReviews(async (app) => {
      await addReview(
        app,
        "First reviewer",
        "https://example.com/reviews/first",
      );
      await addReview(
        app,
        "Second reviewer",
        "https://example.com/reviews/second",
      );
      const refused = await follow(
        app,
        await app.submit(
          "/admin/site/reviews/1/edit",
          fields("First reviewer", "https://example.com/reviews/second"),
        ),
      );
      expect(refused.html).toContain(
        "That review URL is already used by another review.",
      );
      expect((await app.get("/reviews")).html).toContain("First reviewer");
    }));

  test("shows no reviews page or link while reviews are off", async () => {
    await enablePublicSite();
    try {
      const page = await createApp(inProcess).get("/reviews");
      expect(page.status).toBe(404);
      expect((await createApp(inProcess).get("/")).html).not.toContain(
        'href="/reviews"',
      );
    } finally {
      await disablePublicSite();
    }
  });

  test("shows no reviews page or link when every review is deleted", () =>
    withReviews(async (app) => {
      await addReview(
        app,
        "The only reviewer",
        "https://example.com/reviews/only",
      );
      await deleteReview(app, "The only reviewer");
      expect((await app.get("/reviews")).status).toBe(404);
      expect((await app.get("/")).html).not.toContain('href="/reviews"');
    }));

  test("hides the review editor from a signed-out visitor", async () => {
    const page = await createApp(inProcess).get("/admin/site/reviews");

    expect(page.status).toBe(302);
    expect(page.location).toBe("/admin?return_url=%2Fadmin%2Fsite%2Freviews");
  });
});
